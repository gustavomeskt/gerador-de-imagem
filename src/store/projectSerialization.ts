import { getAssetUrl } from '../persistence/assetUrls'
import {
  PROJECT_SCHEMA_VERSION,
  type AssetRecord,
  type PersistedNode,
  type PersistedReferenceImage,
  type PersistedSlot,
  type ProjectRecord,
} from '../persistence/schema'
import type { ReferenceMimeType } from '../generation/references'
import { normalizeStyleGuide } from '../generation/styleGuide'
import type { FlowMeta, FlowNode, FlowSlice, ImageSlot, ReferenceImage } from './types'

// Converte entre o estado da tela e o formato salvo no banco.

export const MISSING_ASSET_MESSAGE = 'Imagem não encontrada no armazenamento local do navegador.'

// Só imagens prontas E salvas viram referência no projeto. Imagens carregando,
// com erro ou que falharam ao salvar ficam só na sessão atual.
function persistSlots(images: ImageSlot[]): PersistedSlot[] {
  return images.flatMap((slot) =>
    slot.status === 'done' && slot.assetId ? [{ id: slot.id, assetId: slot.assetId, aspect: slot.aspect }] : [],
  )
}

function persistReferenceImages(images: ReferenceImage[]): PersistedReferenceImage[] {
  return images.flatMap((img) =>
    img.assetId && !img.missing
      ? [
          {
            id: img.id,
            assetId: img.assetId,
            name: img.name,
            mimeType: img.mimeType,
            byteLength: img.byteLength,
            width: img.width,
            height: img.height,
            sha256: img.sha256,
          },
        ]
      : [],
  )
}

export function serializeProject(meta: FlowMeta, slice: FlowSlice, updatedAt = Date.now()): ProjectRecord {
  const nodes = slice.nodes.map((n): PersistedNode => {
    // estado passageiro da tela não vai pro banco
    const { selected: _selected, dragging: _dragging, ...rest } = n
    if (rest.type === 'image') {
      return { ...rest, data: { ...rest.data, images: persistSlots(rest.data.images), notice: undefined } }
    }
    if (rest.type === 'reference') {
      return { ...rest, data: { ...rest.data, images: persistReferenceImages(rest.data.images), notice: undefined } }
    }
    return { ...rest, data: { ...rest.data, enhancing: undefined, enhanceError: undefined } }
  })

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    updatedAt,
    nodes,
    edges: slice.edges.map(({ selected: _selected, ...e }) => e),
    ...(slice.styleGuide ? { styleGuide: slice.styleGuide } : {}),
  }
}

export interface RestoredProject {
  meta: FlowMeta
  slice: FlowSlice
  // arquivos sem nó correspondente (nó apagado) — podem ser removidos
  orphanAssetIds: string[]
  // arquivos que existiam mas não estavam referenciados (ex.: o app fechou
  // antes de salvar a estrutura) e foram devolvidos ao nó de origem
  recoveredCount: number
}

function slotFromAsset(id: string, asset: AssetRecord, aspect: number): ImageSlot {
  return {
    id,
    status: 'done',
    assetId: asset.id,
    mimeType: asset.mimeType,
    src: getAssetUrl(asset.id, asset.bytes, asset.mimeType),
    aspect,
  }
}

function referenceFromAsset(id: string, asset: AssetRecord, saved?: PersistedReferenceImage): ReferenceImage {
  return {
    id,
    assetId: asset.id,
    src: getAssetUrl(asset.id, asset.bytes, asset.mimeType),
    name: saved?.name ?? asset.reference?.name ?? 'referência',
    mimeType: asset.mimeType as ReferenceMimeType,
    byteLength: asset.byteLength,
    width: asset.width ?? saved?.width ?? 0,
    height: asset.height ?? saved?.height ?? 0,
    sha256: asset.sha256 ?? saved?.sha256 ?? '',
  }
}

export function restoreProject(record: ProjectRecord, assets: AssetRecord[]): RestoredProject {
  const assetsById = new Map(assets.map((a) => [a.id, a]))
  const referenced = new Set<string>()

  const nodes = (record.nodes ?? []).map((n) => {
    if (n.type === 'image') {
      const saved = Array.isArray(n.data.images) ? (n.data.images as PersistedSlot[]) : []
      const images: ImageSlot[] = saved.map((slot) => {
        const asset = assetsById.get(slot.assetId)
        if (!asset) return { id: slot.id, status: 'error', aspect: slot.aspect ?? 1, error: MISSING_ASSET_MESSAGE }
        referenced.add(asset.id)
        return slotFromAsset(slot.id, asset, slot.aspect ?? 1)
      })
      return { ...n, data: { ...n.data, images, notice: undefined } } as unknown as FlowNode
    }
    if (n.type === 'reference') {
      const saved = Array.isArray(n.data.images) ? (n.data.images as PersistedReferenceImage[]) : []
      const images: ReferenceImage[] = saved.map((img) => {
        const asset = assetsById.get(img.assetId)
        if (!asset) {
          return {
            id: img.id,
            assetId: img.assetId,
            name: img.name,
            mimeType: img.mimeType as ReferenceMimeType,
            byteLength: img.byteLength,
            width: img.width,
            height: img.height,
            sha256: img.sha256,
            missing: true,
          }
        }
        referenced.add(asset.id)
        return referenceFromAsset(img.id, asset, img)
      })
      return { ...n, data: { ...n.data, images, notice: undefined } } as unknown as FlowNode
    }
    return n as unknown as FlowNode
  })

  // recupera arquivos que ficaram fora da estrutura salva (o app fechou
  // antes de salvar) devolvendo-os ao nó de origem; sem nó, são órfãos
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const orphanAssetIds: string[] = []
  let recoveredCount = 0
  const unreferenced = assets.filter((a) => !referenced.has(a.id)).sort((a, b) => a.createdAt - b.createdAt)

  for (const asset of unreferenced) {
    if (asset.kind === 'generated') {
      const node = asset.source ? byId.get(asset.source.nodeId) : undefined
      if (!node || node.type !== 'image') {
        orphanAssetIds.push(asset.id)
        continue
      }
      const aspect = asset.width && asset.height ? asset.width / asset.height : 1
      const wantedId = asset.source?.slotId ?? asset.id
      const slotId = node.data.images.some((s) => s.id === wantedId) ? asset.id : wantedId
      node.data.images.push(slotFromAsset(slotId, asset, aspect))
      recoveredCount += 1
    } else if (asset.kind === 'reference') {
      const node = asset.reference ? byId.get(asset.reference.nodeId) : undefined
      if (!node || node.type !== 'reference') {
        orphanAssetIds.push(asset.id)
        continue
      }
      node.data.images.push(referenceFromAsset(asset.id, asset))
      recoveredCount += 1
    }
  }

  return {
    meta: {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt ?? record.updatedAt,
      updatedAt: record.updatedAt,
    },
    // projetos antigos (sem guia) recebem o guia padrão DESLIGADO
    slice: { nodes, edges: record.edges ?? [], styleGuide: normalizeStyleGuide(record.styleGuide) },
    orphanAssetIds,
    recoveredCount,
  }
}

// Todos os arquivos usados pelos nós (imagens geradas e referências).
export function collectAssetIds(nodes: FlowNode[]): string[] {
  return nodes.flatMap((n) => {
    if (n.type === 'image') return n.data.images.flatMap((s) => (s.assetId ? [s.assetId] : []))
    if (n.type === 'reference') return n.data.images.flatMap((r) => (r.assetId ? [r.assetId] : []))
    return []
  })
}
