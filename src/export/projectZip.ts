import JSZip from 'jszip'
import { dataUrlToBytes, extensionFor, readImageSize, sha256Hex } from '../lib/binary'
import type { AssetRecord, AssetSource } from '../persistence/schema'
import type { FlowMeta, FlowSlice, ImageFlowNode, ReferenceFlowNode } from '../store/types'
import { sheetOf, type Character } from '../generation/characters'
import type { StyleGuide } from '../generation/styleGuide'
import type { SceneImageVersion } from '../batch/types'
import type { Storyboard } from '../story/types'
import { isOutdated } from '../batch/versions'
import { FORMAT_LABELS, isNineSixteen, type FormatMethod } from '../batch/format'

// Exportação do projeto em ZIP: todas as imagens prontas, em ordem, com nomes
// padronizados, e um manifest.json descrevendo cada arquivo (origem, prompt,
// modelo, dimensões e hash SHA-256 pra conferir a integridade).

// 2: + storyboard (cenas, imagens oficiais, prompts, orientação de movimento)
export const MANIFEST_FORMAT_VERSION = 2
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

// Arquivo de entrada (referência ou foto de personagem) incluído no ZIP.
export interface ManifestInputFile {
  file: string
  name: string
  mimeType: string
  width: number | null
  height: number | null
  byteLength: number
  sha256: string
}

export interface ManifestReferenceNode {
  nodeId: string
  label: string
  role: string
  preserveClothing: boolean
  files: ManifestInputFile[]
  missing: string[]
}

export interface ManifestCharacter {
  id: string
  name: string | null
  version: number | null
  sheet: Record<string, string> | null
  primaryPhotoId: string | null
  files: ManifestInputFile[]
  missing: string[]
  deletedFromLibrary: boolean
  usedInNodes: string[]
  usedInScenes: number[] // números das cenas do storyboard
}

export interface ManifestSceneImage {
  versionId: string
  file: string
  promptFile: string
  mimeType: string
  width: number | null
  height: number | null
  byteLength: number
  sha256: string
  model: string
  size: string
  quality: string
  simulated: boolean
  approved: boolean
  outdated: boolean // a cena foi editada depois da geração
  createdAt: string
  references: Array<{ kind: string; label: string; sha256: string | null; characterId?: string; sceneId?: string }>
  characters: Array<{ characterId: string; name: string; version: number }>
  format: SceneImageVersion['format']
  formatMethod: FormatMethod
  review: { status: string; problems: string[]; note: string } | null
}

export interface ManifestVersion {
  versionId: string
  createdAt: string
  model: string
  size: string
  width: number | null
  height: number | null
  sha256: string
  simulated: boolean
  official: boolean
  formatMethod: FormatMethod
  derivedFrom: string | null
  review: { status: string; problems: string[]; note: string; reviewedAt: string | null } | null
}

export interface ManifestScene {
  number: number
  sceneId: string
  title: string
  status: string
  excerpt: string
  source: { start: number; end: number }
  characters: string[]
  motion: string
  image: ManifestSceneImage | null
  versionsAvailable: number
  versions: ManifestVersion[] // histórico completo (as imagens não oficiais não vão no ZIP)
  readyForAnimation: boolean
  notReadyReasons: string[]
  missing?: string
}

export interface ManifestStoryboard {
  folder: string
  copyFile: string
  copySha256: string
  storyboardFile: string
  guideFile: string
  approvedAt: string | null
  sceneCount: number
  imagesExported: number
  simulatedImages: number
  readyForAnimation: number
  animationNote: string
  history: Storyboard['history']
  scenes: ManifestScene[]
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
  // fotos originais usadas como referência e fichas dos personagens
  referenceNodes: ManifestReferenceNode[]
  characters: ManifestCharacter[]
  styleGuide: StyleGuide | null
  storyboard: ManifestStoryboard | null
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

async function loadInputBytes(
  item: { assetId?: string; src?: string },
  loadAsset: AssetLoader,
): Promise<Uint8Array | undefined> {
  if (item.assetId) {
    const asset = await loadAsset(item.assetId)
    if (asset) return new Uint8Array(asset.bytes)
  }
  if (item.src?.startsWith('data:')) return dataUrlToBytes(item.src).bytes
  return undefined
}

export async function buildProjectZip(params: {
  meta: FlowMeta
  slice: FlowSlice
  loadAsset: AssetLoader
  // biblioteca atual (pra incluir fotos e fichas dos personagens usados)
  characters?: Character[]
  storyboard?: Storyboard | null
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

  // fotos originais dos nós de referência
  const addInput = async (
    folder: string,
    index: number,
    item: { assetId?: string; src?: string; name: string; mimeType: string; width?: number; height?: number },
  ): Promise<ManifestInputFile | null> => {
    const bytes = await loadInputBytes(item, loadAsset)
    if (!bytes) return null
    const file = `${folder}/${pad(index, 2)}_${slugify(item.name.replace(/\.[a-z0-9]+$/i, ''))}.${extensionFor(item.mimeType)}`
    zip.file(file, bytes, { binary: true })
    return {
      file,
      name: item.name,
      mimeType: item.mimeType,
      width: item.width ?? null,
      height: item.height ?? null,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    }
  }

  const referenceNodes: ManifestReferenceNode[] = []
  const refNodes = slice.nodes
    .filter((n): n is ReferenceFlowNode => n.type === 'reference')
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  for (const [i, node] of refNodes.entries()) {
    const folder = `referencias/${pad(i + 1, 2)}_${slugify(node.data.label || 'referencia')}`
    const files: ManifestInputFile[] = []
    const missing: string[] = []
    for (const [j, img] of node.data.images.entries()) {
      const added = await addInput(folder, j + 1, img)
      if (added) files.push(added)
      else missing.push(img.name)
    }
    referenceNodes.push({ nodeId: node.id, label: node.data.label, role: node.data.role, preserveClothing: node.data.preserveClothing, files, missing })
  }

  // personagens da biblioteca usados no projeto (fotos + ficha atual)
  const usage = new Map<string, string[]>()
  for (const node of nodes) {
    for (const id of node.data.castIds ?? []) usage.set(id, [...(usage.get(id) ?? []), node.id])
  }
  const sceneUsage = new Map<string, number[]>()
  params.storyboard?.scenes.forEach((scene, i) => {
    for (const key of scene.characterKeys) {
      const libraryId = params.storyboard!.characters.find((c) => c.key === key)?.libraryId
      if (libraryId) sceneUsage.set(libraryId, [...(sceneUsage.get(libraryId) ?? []), i + 1])
    }
  })
  for (const id of sceneUsage.keys()) if (!usage.has(id)) usage.set(id, [])
  const characters: ManifestCharacter[] = []
  for (const [id, usedInNodes] of usage) {
    const usedInScenes = sceneUsage.get(id) ?? []
    const c = params.characters?.find((x) => x.id === id)
    if (!c) {
      characters.push({ id, name: null, version: null, sheet: null, primaryPhotoId: null, files: [], missing: [], deletedFromLibrary: true, usedInNodes, usedInScenes })
      continue
    }
    const folder = `personagens/${slugify(c.name)}_${id.slice(-6)}`
    const files: ManifestInputFile[] = []
    const missing: string[] = []
    for (const [j, photo] of c.photos.entries()) {
      const added = await addInput(folder, j + 1, photo)
      if (added) files.push(added)
      else missing.push(photo.name)
    }
    characters.push({
      id,
      name: c.name,
      version: c.version,
      sheet: { ...sheetOf(c) },
      primaryPhotoId: c.primaryPhotoId,
      files,
      missing,
      deletedFromLibrary: false,
      usedInNodes,
      usedInScenes,
    })
  }

  const storyboard = params.storyboard ? await addStoryboard(zip, params.storyboard, loadAsset) : null

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
    referenceNodes,
    characters,
    styleGuide: slice.styleGuide ?? null,
    storyboard,
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { data, manifest, fileName: zipFileName(meta.name, now) }
}

// --- storyboard: pacote para o Google Flow ---

export const STORYBOARD_DIR = 'storyboard'

export const ANIMATION_NOTE =
  'Esta ferramenta ainda NÃO anima as imagens. Cada cena traz a imagem oficial e uma orientação de movimento ' +
  '(só a ação já descrita na copy) para você usar ao animar no Google Flow.'

// Imagens simuladas (fictícias) levam "_SIMULADA" no nome: nunca se
// confundem com arquivos reais prontos para animar.
export function sceneFileName(number: number, mimeType: string, simulated = false): string {
  return `${STORYBOARD_DIR}/cenas/cena_${pad(number, 3)}${simulated ? '_SIMULADA' : ''}.${extensionFor(mimeType)}`
}

// Pronta para animar no Google Flow: imagem real (não simulada), aprovada
// pela pessoa e em 9:16 (nativo, expandido ou reenquadrado).
export function readinessOf(image: ManifestSceneImage | null, missing?: string): { ready: boolean; reasons: string[] } {
  if (!image) return { ready: false, reasons: [missing ?? 'sem imagem oficial'] }
  const reasons: string[] = []
  if (image.simulated) reasons.push('imagem simulada (fictícia)')
  if (!image.approved) reasons.push('imagem ainda não aprovada')
  if (image.formatMethod === 'unadjusted') reasons.push('formato ainda não é 9:16')
  if (image.outdated) reasons.push('cena editada depois da imagem')
  return { ready: reasons.length === 0, reasons }
}

function sceneTitle(excerpt: string): string {
  const text = excerpt.replace(/\s+/g, ' ').trim()
  return text.length > 70 ? `${text.slice(0, 69)}…` : text
}

async function addStoryboard(zip: JSZip, board: Storyboard, loadAsset: AssetLoader): Promise<ManifestStoryboard> {
  const nameOf = new Map(board.characters.map((c) => [c.key, c.name]))
  const scenes: ManifestScene[] = []
  const guide: string[] = [
    '# Roteiro para o Google Flow',
    '',
    ANIMATION_NOTE,
    '',
    'Cada cena: arquivo da imagem oficial, trecho da copy (texto original) e orientação de movimento.',
    '',
  ]
  let exported = 0
  let simulated = 0
  let ready = 0

  for (const [i, scene] of board.scenes.entries()) {
    const number = i + 1
    const title = sceneTitle(scene.excerpt)
    const characters = scene.characterKeys.map((k) => nameOf.get(k) ?? '?')
    const official = scene.images?.find((v) => v.id === scene.officialImageId)
    let image: ManifestSceneImage | null = null
    let missing: string | undefined
    if (!official) missing = 'sem imagem oficial'
    else {
      let bytes: Uint8Array | undefined
      if (official.assetId) {
        const asset = await loadAsset(official.assetId)
        if (asset) bytes = new Uint8Array(asset.bytes)
      }
      if (!bytes && official.src?.startsWith('data:')) bytes = dataUrlToBytes(official.src).bytes
      if (!bytes) missing = 'arquivo da imagem não encontrado no armazenamento local'
      else {
        const file = sceneFileName(number, official.mimeType, official.simulated)
        const promptFile = `${STORYBOARD_DIR}/prompts/cena_${pad(number, 3)}.txt`
        zip.file(file, bytes, { binary: true })
        zip.file(promptFile, official.prompt)
        exported += 1
        if (official.simulated) simulated += 1
        image = {
          versionId: official.id,
          file,
          promptFile,
          mimeType: official.mimeType,
          width: official.width,
          height: official.height,
          byteLength: bytes.byteLength,
          sha256: await sha256Hex(bytes),
          model: official.model,
          size: official.size,
          quality: official.quality,
          simulated: official.simulated,
          approved: !!scene.imageApprovedAt,
          outdated: isOutdated(scene, board),
          createdAt: new Date(official.createdAt).toISOString(),
          references: official.references.map((r) => ({
            kind: r.kind,
            label: r.label,
            sha256: r.sha256 ?? null,
            ...(r.characterId ? { characterId: r.characterId } : {}),
            ...(r.sceneId ? { sceneId: r.sceneId } : {}),
          })),
          characters: official.characters.map((c) => ({ characterId: c.characterId, name: c.name, version: c.version })),
          format: official.format,
          formatMethod: official.format.method ?? (isNineSixteen(official.width, official.height) ? 'native' : 'unadjusted'),
          review: official.review ? { status: official.review.status, problems: official.review.problems, note: official.review.note } : null,
        }
      }
    }
    scenes.push({
      number,
      sceneId: scene.id,
      title,
      status: scene.status,
      excerpt: scene.excerpt,
      source: scene.source,
      characters,
      motion: scene.motion,
      image,
      versionsAvailable: scene.images?.length ?? 0,
      versions: (scene.images ?? []).map((v) => ({
        versionId: v.id,
        createdAt: new Date(v.createdAt).toISOString(),
        model: v.model,
        size: v.size,
        width: v.width,
        height: v.height,
        sha256: v.sha256,
        simulated: v.simulated,
        official: v.id === scene.officialImageId,
        formatMethod: v.format.method ?? (isNineSixteen(v.width, v.height) ? 'native' : 'unadjusted'),
        derivedFrom: v.derivedFrom ?? null,
        review: v.review
          ? { status: v.review.status, problems: v.review.problems, note: v.review.note, reviewedAt: v.review.reviewedAt ? new Date(v.review.reviewedAt).toISOString() : null }
          : null,
      })),
      ...readinessToFields(readinessOf(image, missing)),
      ...(missing ? { missing } : {}),
    })
    if (readinessOf(image, missing).ready) ready += 1

    guide.push(`## Cena ${pad(number, 3)} — ${title}`)
    guide.push('')
    const readiness = readinessOf(image, missing)
    guide.push(`- Situação: ${readiness.ready ? 'PRONTA para animar' : `NÃO PRONTA — ${readiness.reasons.join('; ')}`}`)
    guide.push(`- Imagem: ${image ? image.file.replace(`${STORYBOARD_DIR}/`, '') : `(${missing})`}${image?.simulated ? ' — IMAGEM SIMULADA (fictícia), não use para animar' : ''}`)
    if (image) guide.push(`- Formato: ${FORMAT_LABELS[image.formatMethod]} — ${image.width}×${image.height}`)
    guide.push(`- Personagens: ${characters.join(', ') || '—'}`)
    if (scene.environment) guide.push(`- Ambiente: ${scene.environment}`)
    if (scene.camera || scene.framing) guide.push(`- Câmera: ${[scene.framing, scene.camera].filter(Boolean).join('; ')}`)
    guide.push(`- Movimento (Google Flow): ${scene.motion || 'animar apenas a ação descrita no trecho'}`)
    guide.push(`- Trecho da copy: "${scene.excerpt}"`)
    guide.push('')
  }

  const copyFile = `${STORYBOARD_DIR}/copy_original.txt`
  const storyboardFile = `${STORYBOARD_DIR}/storyboard.json`
  const guideFile = `${STORYBOARD_DIR}/roteiro_google_flow.md`
  zip.file(copyFile, board.copy)
  // storyboard completo (sem imagens em memória e sem versões anteriores restauráveis)
  const { snapshots: _snapshots, ...rest } = board
  zip.file(
    storyboardFile,
    JSON.stringify(
      { ...rest, scenes: board.scenes.map((s) => ({ ...s, images: s.images?.map(({ src: _src, ...v }) => v) })) },
      null,
      2,
    ),
  )
  zip.file(guideFile, guide.join('\n'))
  zip.file(
    `${STORYBOARD_DIR}/LEIA-ME.txt`,
    [
      'Pacote do storyboard',
      '',
      ANIMATION_NOTE,
      '',
      'cenas/            imagens oficiais, na ordem da história (cena_001, cena_002, ...)',
      'prompts/          o texto exato enviado para gerar cada imagem oficial',
      'roteiro_google_flow.md   imagem + trecho da copy + orientação de movimento de cada cena',
      'copy_original.txt        a copy exatamente como foi colada',
      'storyboard.json          o storyboard completo (cenas, personagens, histórico, versões)',
      '',
      `Prontas para animar (reais, aprovadas e em 9:16): ${ready} de ${board.scenes.length} cena(s).`,
      simulated ? `ATENÇÃO: ${simulated} imagem(ns) são SIMULADAS (fictícias, geradas sem IA; nome termina em _SIMULADA) — servem só para testar o fluxo, NÃO para animar.` : '',
      'Formato de cada imagem (nativo, expandido ou reenquadrado) e o histórico de versões e aprovações estão no manifest.json.',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  )

  return {
    folder: STORYBOARD_DIR,
    copyFile,
    copySha256: await sha256Hex(new TextEncoder().encode(board.copy)),
    storyboardFile,
    guideFile,
    approvedAt: board.approvedAt ? new Date(board.approvedAt).toISOString() : null,
    sceneCount: board.scenes.length,
    imagesExported: exported,
    simulatedImages: simulated,
    readyForAnimation: ready,
    animationNote: ANIMATION_NOTE,
    history: board.history,
    scenes,
  }
}

function readinessToFields(r: { ready: boolean; reasons: string[] }) {
  return { readyForAnimation: r.ready, notReadyReasons: r.reasons }
}
