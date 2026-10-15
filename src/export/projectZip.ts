import JSZip from 'jszip'
import { dataUrlToBytes, extensionFor, readImageSize, sha256Hex } from '../lib/binary'
import type { AssetRecord, AssetSource } from '../persistence/schema'
import type { FlowMeta, FlowSlice, ImageFlowNode } from '../store/types'

// Exportação do projeto em ZIP: todas as imagens prontas, em ordem, com nomes
// padronizados, e um manifest.json descrevendo cada arquivo (origem, prompt,
// modelo, dimensões e hash SHA-256 pra conferir a integridade).

export const MANIFEST_FORMAT_VERSION = 1
export const IMAGES_DIR = 'imagens'

export const ORDERING_RULE =
  'Grupos = nós de imagem, ordenados de cima para baixo e, na mesma altura, da esquerda para a direita no canvas. ' +
  'Dentro de cada grupo, as imagens seguem a ordem em que aparecem no nó.'

export interface ManifestImage {
  sequence: number
  file: string
  group: number
  indexInGroup: number
  nodeId: string
  slotId: string
  assetId: string | null
  mimeType: string
  width: number | null
  height: number | null
  aspect: number
  byteLength: number
  sha256: string
  createdAt: string | null
  source: AssetSource | null
}

export interface ManifestGroup {
  group: number
  nodeId: string
  prompt: string | null
  model: string
  size: string
  quality: string | null
  imageCount: number
}

export interface ManifestSkipped {
  nodeId: string
  slotId: string
  reason: string
}

export interface ProjectManifest {
  formatVersion: number
  generator: string
  exportedAt: string
  project: { id: string; name: string; createdAt: string; updatedAt: string }
  ordering: string
  imageCount: number
  groups: ManifestGroup[]
  images: ManifestImage[]
  skipped: ManifestSkipped[]
}

export type AssetLoader = (assetId: string) => Promise<AssetRecord | undefined>

export interface ProjectZip {
  data: Uint8Array
  manifest: ProjectManifest
  fileName: string
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')

export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'projeto'
}

export function zipFileName(projectName: string, date: Date): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `_${pad(date.getHours(), 2)}-${pad(date.getMinutes(), 2)}`
  return `${slugify(projectName)}_${stamp}.zip`
}

export function imageFileName(sequence: number, group: number, indexInGroup: number, mimeType: string): string {
  return `${IMAGES_DIR}/${pad(sequence, 3)}_grupo-${pad(group, 2)}_imagem-${pad(indexInGroup, 2)}.${extensionFor(mimeType)}`
}

export function orderImageNodes(slice: FlowSlice): ImageFlowNode[] {
  return slice.nodes
    .filter((n): n is ImageFlowNode => n.type === 'image')
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
}

function connectedPrompt(slice: FlowSlice, nodeId: string): string | null {
  const edge = slice.edges.find((e) => e.target === nodeId && e.targetHandle === 'prompt-in')
  const source = edge && slice.nodes.find((n) => n.id === edge.source)
  return source?.type === 'prompt' && source.data.prompt.trim() ? source.data.prompt.trim() : null
}

async function loadSlotBytes(
  slot: ImageFlowNode['data']['images'][number],
  loadAsset: AssetLoader,
): Promise<{ bytes: Uint8Array; mimeType: string; asset?: AssetRecord } | string> {
  if (slot.assetId) {
    const asset = await loadAsset(slot.assetId)
    if (asset) return { bytes: new Uint8Array(asset.bytes), mimeType: asset.mimeType, asset }
    if (!slot.src?.startsWith('data:')) return 'arquivo não encontrado no armazenamento local'
  }
  // imagem que não foi salva no banco (falha de gravação ou modo sem
  // armazenamento): ainda está na memória como data URL
  if (slot.src?.startsWith('data:')) return dataUrlToBytes(slot.src)
  return 'imagem indisponível'
}

export async function buildProjectZip(params: {
  meta: FlowMeta
  slice: FlowSlice
  loadAsset: AssetLoader
  now?: Date
}): Promise<ProjectZip> {
  const { meta, slice, loadAsset } = params
  const now = params.now ?? new Date()
  const zip = new JSZip()

  const groups: ManifestGroup[] = []
  const images: ManifestImage[] = []
  const skipped: ManifestSkipped[] = []
  let sequence = 0

  const nodes = orderImageNodes(slice)
  for (const [nodeIndex, node] of nodes.entries()) {
    const group = nodeIndex + 1
    let indexInGroup = 0

    for (const slot of node.data.images) {
      if (slot.status !== 'done') {
        skipped.push({ nodeId: node.id, slotId: slot.id, reason: slot.status === 'loading' ? 'ainda gerando' : 'com erro' })
        continue
      }
      const loaded = await loadSlotBytes(slot, loadAsset)
      if (typeof loaded === 'string') {
        skipped.push({ nodeId: node.id, slotId: slot.id, reason: loaded })
        continue
      }

      sequence += 1
      indexInGroup += 1
      const file = imageFileName(sequence, group, indexInGroup, loaded.mimeType)
      const size =
        loaded.asset?.width && loaded.asset?.height
          ? { width: loaded.asset.width, height: loaded.asset.height }
          : readImageSize(loaded.bytes, loaded.mimeType)

      zip.file(file, loaded.bytes, { binary: true })
      images.push({
        sequence,
        file,
        group,
        indexInGroup,
        nodeId: node.id,
        slotId: slot.id,
        assetId: loaded.asset?.id ?? null,
        mimeType: loaded.mimeType,
        width: size?.width ?? null,
        height: size?.height ?? null,
        aspect: slot.aspect,
        byteLength: loaded.bytes.byteLength,
        sha256: await sha256Hex(loaded.bytes),
        createdAt: loaded.asset ? new Date(loaded.asset.createdAt).toISOString() : null,
        source: loaded.asset?.source ?? null,
      })
    }

    groups.push({
      group,
      nodeId: node.id,
      prompt: connectedPrompt(slice, node.id),
      model: node.data.model,
      size: node.data.size,
      quality: node.data.quality ?? null,
      imageCount: indexInGroup,
    })
  }

  const manifest: ProjectManifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    generator: 'image-flow-studio',
    exportedAt: now.toISOString(),
    project: {
      id: meta.id,
      name: meta.name,
      createdAt: new Date(meta.createdAt).toISOString(),
      updatedAt: new Date(meta.updatedAt).toISOString(),
    },
    ordering: ORDERING_RULE,
    imageCount: images.length,
    groups,
    images,
    skipped,
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { data, manifest, fileName: zipFileName(meta.name, now) }
}
