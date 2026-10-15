import { getAssetUrl } from '../persistence/assetUrls'
import {
  PROJECT_SCHEMA_VERSION,
  type AssetRecord,
  type PersistedNode,
  type PersistedSlot,
  type ProjectRecord,
} from '../persistence/schema'
import type { FlowMeta, FlowNode, FlowSlice, ImageSlot } from './types'

// Converte entre o estado da tela e o formato salvo no banco.

export const MISSING_ASSET_MESSAGE = 'Imagem não encontrada no armazenamento local do navegador.'

// Só imagens prontas E salvas viram referência no projeto. Imagens carregando,
// com erro ou que falharam ao salvar ficam só na sessão atual.
function persistSlots(images: ImageSlot[]): PersistedSlot[] {
  return images.flatMap((slot) =>
    slot.status === 'done' && slot.assetId ? [{ id: slot.id, assetId: slot.assetId, aspect: slot.aspect }] : [],
  )
}

export function serializeProject(meta: FlowMeta, slice: FlowSlice, updatedAt = Date.now()): ProjectRecord {
  const nodes = slice.nodes.map((n): PersistedNode => {
    // estado passageiro da tela não vai pro banco
    const { selected: _selected, dragging: _dragging, ...rest } = n
    if (rest.type === 'image') {
      return { ...rest, data: { ...rest.data, images: persistSlots(rest.data.images), notice: undefined } }
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

export function restoreProject(record: ProjectRecord, assets: AssetRecord[]): RestoredProject {
  const assetsById = new Map(assets.map((a) => [a.id, a]))
  const referenced = new Set<string>()

  const nodes = (record.nodes ?? []).map((n) => {
    if (n.type !== 'image') return n as unknown as FlowNode
    const saved = Array.isArray(n.data.images) ? (n.data.images as PersistedSlot[]) : []
    const images: ImageSlot[] = saved.map((slot) => {
      const asset = assetsById.get(slot.assetId)
      if (!asset) return { id: slot.id, status: 'error', aspect: slot.aspect ?? 1, error: MISSING_ASSET_MESSAGE }
      referenced.add(asset.id)
      return slotFromAsset(slot.id, asset, slot.aspect ?? 1)
    })
    return { ...n, data: { ...n.data, images, notice: undefined } } as unknown as FlowNode
  })

  // recupera imagens geradas que ficaram fora da estrutura salva
  const imageNodes = new Map(nodes.filter((n) => n.type === 'image').map((n) => [n.id, n]))
  const orphanAssetIds: string[] = []
  let recoveredCount = 0
  const unreferenced = assets
    .filter((a) => a.kind === 'generated' && !referenced.has(a.id))
    .sort((a, b) => a.createdAt - b.createdAt)

  for (const asset of unreferenced) {
    const node = asset.source ? imageNodes.get(asset.source.nodeId) : undefined
    if (!node || node.type !== 'image') {
      orphanAssetIds.push(asset.id)
      continue
    }
    const aspect = asset.width && asset.height ? asset.width / asset.height : 1
    const wantedId = asset.source?.slotId ?? asset.id
    const slotId = node.data.images.some((s) => s.id === wantedId) ? asset.id : wantedId
    node.data.images.push(slotFromAsset(slotId, asset, aspect))
    recoveredCount += 1
  }

  return {
    meta: {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt ?? record.updatedAt,
      updatedAt: record.updatedAt,
    },
    slice: { nodes, edges: record.edges ?? [] },
    orphanAssetIds,
    recoveredCount,
  }
}

export function collectAssetIds(nodes: FlowNode[]): string[] {
  return nodes.flatMap((n) =>
    n.type === 'image' ? n.data.images.flatMap((s) => (s.assetId ? [s.assetId] : [])) : [],
  )
}
