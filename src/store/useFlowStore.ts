import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { clampCount, DEFAULT_MODEL, getSizeOption, isImageModel, MODEL_LABELS, MODEL_SIZES, type ImageModel } from '../generation/models'
import { orderedPhotos, sheetOf, type Character, type CharacterSheet } from '../generation/characters'
import { composePrompt } from '../generation/promptComposer'
import { allocateCharacterPhotos } from '../generation/referencePlan'
import { defaultStyleGuide, sizeForAspect, type StyleGuide } from '../generation/styleGuide'
import {
  checkReferenceFile,
  DEFAULT_MAX_REFERENCES,
  effectiveFidelity,
  ROLE_ORDER,
  supportsReferences,
  toDescriptor,
  type InputFidelity,
  type ReferenceImageInput,
  type ReferenceMimeType,
  type ReferenceRole,
} from '../generation/references'
import { getProvider } from '../generation/providers'
import { resolveAspect, runGeneration, type ImageGenerationConfig, type ImageResult } from '../generation/service'
import type { CostQuote, GeneratedImage, ImageJob, ImageProvider, ProviderKind } from '../generation/types'
import { bytesToBase64, bytesToDataUrl, dataUrlToBytes, readImageSize, sha256Hex, toArrayBuffer } from '../lib/binary'
import { cropToAspect } from '../lib/image'
import { loadFlowsRaw, loadImagePreset, loadProviderKind, saveImagePreset, saveProviderKind } from '../lib/storage'
import { getAssetUrl, releaseAssetUrl } from '../persistence/assetUrls'
import { toStorageError, type StorageIssueKind } from '../persistence/errors'
import { legacyFlowToProject, migrateLegacyFlows } from '../persistence/migration'
import { repository } from '../persistence/repository'
import type { AssetRecord, AssetSource, ProjectRecord } from '../persistence/schema'
import { collectAssetIds, restoreProject, serializeProject, type RestoredProject } from './projectSerialization'
import { useCharacterStore } from './useCharacterStore'
import { LIBRARY_PROJECT_ID } from '../generation/characters'
import type {
  FlowMeta,
  FlowNode,
  FlowSlice,
  ImageFlowNode,
  ImageNodeData,
  ImageSlot,
  PromptFlowNode,
  PromptNodeData,
  ReferenceFlowNode,
  ReferenceImage,
  ReferenceNodeData,
} from './types'

export type {
  ReferenceFlowNode,
  ReferenceImage,
  ReferenceNodeData,
  FlowMeta,
  FlowNode,
  ImageFlowNode,
  ImageNodeData,
  ImageSlot,
  PromptFlowNode,
  PromptNodeData,
} from './types'

let idCounter = 0
function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-${Date.now()}-${idCounter}`
}

function defaultImageData(style?: StyleGuide): ImageNodeData {
  const preset = loadImagePreset()
  const model = isImageModel(preset?.model) ? preset.model : DEFAULT_MODEL
  // com guia de estilo ativo, o nó novo já nasce na proporção preferida (9:16 por padrão)
  const size = style?.enabled
    ? sizeForAspect(model, style.aspect)
    : preset?.size && getSizeOption(model, preset.size)
      ? preset.size
      : MODEL_SIZES[model][0].value
  return {
    model,
    size,
    quality: preset?.quality,
    count: clampCount(preset?.count ?? 1),
    images: [],
  }
}

// 'indexeddb': tudo é salvo no banco local do navegador.
// 'memory': banco indisponível — o app funciona, mas nada é salvo.
export type PersistenceMode = 'pending' | 'indexeddb' | 'memory'

export interface StorageIssue {
  kind: StorageIssueKind
  message: string
}

// Pedido de confirmação de custo aberto na tela (provedores pagos).
export interface CostConfirmationRequest {
  title: string
  quote: CostQuote
}

export const GENERATION_CANCELLED_MESSAGE = 'Geração cancelada: nenhuma chamada paga foi feita.'
export const AWAITING_CONFIRMATION_MESSAGE = 'Aguardando sua confirmação do custo…'

interface FlowState {
  hydrated: boolean
  persistence: PersistenceMode
  storageIssue: StorageIssue | null
  costConfirmation: CostConfirmationRequest | null

  // nós/arestas de TODOS os fluxos, mantidos em memória ao mesmo tempo —
  // assim uma geração de imagem em andamento continua mesmo que a pessoa
  // saia desse fluxo e abra outro.
  flowsData: Record<string, FlowSlice>
  flows: FlowMeta[]
  providerKind: ProviderKind

  hydrate: () => Promise<void>
  dismissStorageIssue: () => void
  resolveCostConfirmation: (confirmed: boolean) => void
  // usado por outras telas (ex.: interpretação da historinha) para pedir a
  // mesma confirmação explícita de custo
  confirmCost: (title: string, quote: CostQuote) => Promise<boolean>

  onNodesChange: (flowId: string, changes: NodeChange[]) => void
  onEdgesChange: (flowId: string, changes: EdgeChange[]) => void
  onConnect: (flowId: string, connection: Connection) => void

  addPromptNode: (flowId: string, position: { x: number; y: number }) => void
  addImageNode: (flowId: string, position: { x: number; y: number }) => void
  addReferenceNode: (flowId: string, position: { x: number; y: number }) => void
  updateReferenceData: (flowId: string, id: string, partial: Partial<Pick<ReferenceNodeData, 'label' | 'role' | 'preserveClothing'>>) => void
  addReferenceImages: (flowId: string, nodeId: string, files: ReferenceFileInput[]) => Promise<void>
  replaceReferenceImage: (flowId: string, nodeId: string, imageId: string, file: ReferenceFileInput) => Promise<void>
  removeReferenceImage: (flowId: string, nodeId: string, imageId: string) => void

  // personagens da biblioteca num nó de imagem e ajustes só da cena
  setCast: (flowId: string, imageNodeId: string, castIds: string[]) => void
  setCastNote: (flowId: string, imageNodeId: string, characterId: string, note: string) => void
  updateStyleGuide: (flowId: string, partial: Partial<StyleGuide>) => void
  getGenerationPreview: (flowId: string, imageNodeId: string) => GenerationPlan | { error: string }
  deleteNode: (flowId: string, id: string) => void

  updatePromptData: (flowId: string, id: string, partial: Partial<PromptNodeData>) => void
  updateImageConfig: (flowId: string, id: string, partial: Partial<ImageNodeData>) => void
  enhancePrompt: (flowId: string, id: string) => Promise<void>

  setProviderKind: (kind: ProviderKind) => void

  createFlow: () => string
  renameFlow: (flowId: string, name: string) => void
  deleteFlow: (flowId: string) => void

  generate: (flowId: string, imageNodeId: string) => Promise<void>
  regenerateSlot: (flowId: string, imageNodeId: string, slotId: string) => Promise<void>
  deleteSlot: (flowId: string, imageNodeId: string, slotId: string) => void
}

function getConnectedPrompt(slice: FlowSlice, imageNodeId: string): string | null {
  const edge = slice.edges.find((e) => e.target === imageNodeId && e.targetHandle === 'prompt-in')
  if (!edge) return null
  const sourceNode = slice.nodes.find((n) => n.id === edge.source)
  if (!sourceNode || sourceNode.type !== 'prompt') return null
  const prompt = sourceNode.data.prompt
  return prompt && prompt.trim() ? prompt.trim() : null
}

function summarizeFailures(results: ImageResult[]): string | undefined {
  const errors = results.flatMap((r) => (r.ok ? [] : [r.error]))
  if (errors.length === 0) return undefined
  if (errors.length === results.length) return errors[0]
  return `${errors.length} de ${results.length} imagens falharam: ${errors[0]}`
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function sortByCreation(flows: FlowMeta[]): FlowMeta[] {
  return [...flows].sort((a, b) => a.createdAt - b.createdAt)
}

interface SavedImage {
  src: string
  mimeType: string
  assetId?: string
  unsaved?: boolean
}

interface GenerationContext {
  prompt: string
  config: ImageGenerationConfig
  provider: ProviderKind
  references?: AssetSource['references']
  inputFidelity?: InputFidelity
  characters?: AssetSource['characters']
  styleGuideApplied?: boolean
}

// Uma foto que vai na geração (de um personagem ou de um nó de referência).
export interface PlannedImage {
  kind: 'character' | 'reference'
  ownerId: string
  ownerLabel: string
  role: string
  photoName: string
  src?: string
  assetId?: string
  sha256: string
  mimeType: ReferenceMimeType
  width: number
  height: number
  byteLength: number
}

// Tudo o que uma geração vai usar — mostrado na pré-visualização.
export interface GenerationPlan {
  model: ImageModel
  scene: string
  prompt: string
  images: PlannedImage[]
  omitted: Array<{ ownerLabel: string; photoName: string }>
  characters: Array<{ id: string; name: string; version: number; sheet: CharacterSheet; sceneNote: string; sent: number; total: number }>
  references: Array<{ label: string; role: ReferenceRole; count: number }>
  style: StyleGuide | null
  inputFidelity?: InputFidelity
}

// Arquivo escolhido pela pessoa (File do navegador, ou equivalente nos testes).
export interface ReferenceFileInput {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
}

// Referências prontas pra uma geração: as fotos (bytes) + o texto que diz
// ao modelo qual imagem é de quem.
interface PreparedReferences {
  prompt: string
  inputs: ReferenceImageInput[]
  sourceRefs: NonNullable<AssetSource['references']>
  inputFidelity?: InputFidelity
}

const REFERENCE_EDGE_HANDLE = 'refs-in'

// Só liga prompt → entrada de prompt e referência → entrada de referências.
export function isValidFlowConnection(c: { sourceHandle?: string | null; targetHandle?: string | null }): boolean {
  return (
    (c.sourceHandle === 'prompt-out' && c.targetHandle === 'prompt-in') ||
    (c.sourceHandle === 'ref-out' && c.targetHandle === REFERENCE_EDGE_HANDLE)
  )
}

function connectedReferenceNodes(slice: FlowSlice, imageNodeId: string): ReferenceFlowNode[] {
  const seen = new Set<string>()
  const nodes: ReferenceFlowNode[] = []
  for (const e of slice.edges) {
    if (e.target !== imageNodeId || e.targetHandle !== REFERENCE_EDGE_HANDLE || seen.has(e.source)) continue
    const node = slice.nodes.find((n) => n.id === e.source)
    if (node?.type === 'reference') {
      seen.add(node.id)
      nodes.push(node)
    }
  }
  // personagens primeiro: com fidelidade alta os modelos priorizam as primeiras imagens
  return nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => ROLE_ORDER.indexOf(a.n.data.role) - ROLE_ORDER.indexOf(b.n.data.role) || a.i - b.i)
    .map(({ n }) => n)
}

let hydrating: Promise<void> | null = null
let pendingConfirmation: ((confirmed: boolean) => void) | null = null

export const useFlowStore = create<FlowState>((set, get) => {
  function reportStorageIssue(err: unknown) {
    const error = toStorageError(err)
    set({ storageIssue: { kind: error.kind, message: error.message } })
  }

  // Abre o diálogo de confirmação e espera a resposta da pessoa.
  function requestCostConfirmation(title: string, quote: CostQuote): Promise<boolean> {
    pendingConfirmation?.(false) // um pedido novo cancela o anterior
    return new Promise((resolve) => {
      pendingConfirmation = resolve
      set({ costConfirmation: { title, quote } })
    })
  }

  // Provedor pago: pede o orçamento e a confirmação antes de gastar.
  // Devolve o quoteId confirmado ou null (cancelado ou erro). Os avisos
  // (aguardando, cancelado, erro) vão pra onNotice.
  async function confirmImageJob(
    provider: ImageProvider,
    job: ImageJob,
    title: string,
    onNotice: (message: string) => void,
  ): Promise<string | null> {
    if (!provider.quoteImages) return null
    let quote: CostQuote
    try {
      quote = await provider.quoteImages(job)
    } catch (err) {
      onNotice(errorMessage(err, 'Não foi possível calcular o custo.'))
      return null
    }
    onNotice(AWAITING_CONFIRMATION_MESSAGE)
    if (!(await requestCostConfirmation(title, quote))) {
      onNotice(GENERATION_CANCELLED_MESSAGE)
      return null
    }
    return quote.quoteId
  }

  function isPersistent() {
    return get().persistence === 'indexeddb'
  }

  function updateFlowSlice(flowId: string, updater: (slice: FlowSlice) => FlowSlice) {
    // fluxo apagado no meio de uma geração: ignora em vez de recriá-lo
    if (!get().flowsData[flowId]) return
    set((state) => {
      const slice = state.flowsData[flowId]
      if (!slice) return state
      return { flowsData: { ...state.flowsData, [flowId]: updater(slice) } }
    })
    markDirty(flowId)
  }

  function updatePromptNode(flowId: string, id: string, updater: (data: PromptNodeData) => PromptNodeData) {
    updateFlowSlice(flowId, (slice) => ({
      ...slice,
      nodes: slice.nodes.map((n) => (n.id === id && n.type === 'prompt' ? { ...n, data: updater(n.data) } : n)),
    }))
  }

  function updateImageNode(flowId: string, id: string, updater: (data: ImageNodeData) => ImageNodeData) {
    updateFlowSlice(flowId, (slice) => ({
      ...slice,
      nodes: slice.nodes.map((n) => (n.id === id && n.type === 'image' ? { ...n, data: updater(n.data) } : n)),
    }))
  }

  function updateSlot(flowId: string, imageNodeId: string, slotId: string, updater: (slot: ImageSlot) => ImageSlot) {
    updateImageNode(flowId, imageNodeId, (data) => ({
      ...data,
      images: data.images.map((slot) => (slot.id === slotId ? updater(slot) : slot)),
    }))
  }

  function findImageNode(flowId: string, imageNodeId: string): ImageFlowNode | undefined {
    const node = get().flowsData[flowId]?.nodes.find((n) => n.id === imageNodeId)
    return node?.type === 'image' ? node : undefined
  }

  // Grava a imagem gerada no banco local assim que ela chega — não depende
  // de download manual. Se a gravação falhar, a imagem continua na tela
  // (marcada como não salva) e a pessoa é avisada.
  async function saveGeneratedImage(
    flowId: string,
    imageNodeId: string,
    slotId: string,
    image: GeneratedImage,
    ctx: GenerationContext,
  ): Promise<SavedImage> {
    if (!isPersistent()) return { src: image.src, mimeType: image.mimeType }
    try {
      const { bytes, mimeType } = dataUrlToBytes(image.src)
      const size = readImageSize(bytes, mimeType)
      const asset: AssetRecord = {
        id: nextId('asset'),
        projectId: flowId,
        kind: 'generated',
        mimeType,
        bytes: toArrayBuffer(bytes),
        byteLength: bytes.byteLength,
        width: size?.width,
        height: size?.height,
        createdAt: Date.now(),
        source: {
          nodeId: imageNodeId,
          slotId,
          prompt: ctx.prompt,
          model: ctx.config.model,
          size: ctx.config.size,
          quality: ctx.config.quality,
          provider: ctx.provider,
          ...(ctx.references?.length ? { references: ctx.references, inputFidelity: ctx.inputFidelity } : {}),
          ...(ctx.characters?.length ? { characters: ctx.characters } : {}),
          ...(ctx.styleGuideApplied ? { styleGuideApplied: true } : {}),
        },
      }
      await repository.putAsset(asset)
      return { src: getAssetUrl(asset.id, asset.bytes, mimeType), mimeType, assetId: asset.id }
    } catch (err) {
      reportStorageIssue(err)
      return { src: image.src, mimeType: image.mimeType, unsaved: true }
    }
  }

  // Remove arquivos que saíram do projeto. Salva a estrutura ANTES de apagar
  // os arquivos, pra nunca existir um projeto salvo apontando pra um arquivo
  // que já não existe.
  async function discardAssets(flowId: string, candidates: string[]) {
    // um arquivo pode estar em mais de um nó (a mesma foto de referência):
    // só apaga o que nenhum nó usa mais
    const inUse = new Set(collectAssetIds(get().flowsData[flowId]?.nodes ?? []))
    const assetIds = [...new Set(candidates)].filter((id) => !inUse.has(id))
    for (const id of assetIds) releaseAssetUrl(id)
    if (!isPersistent()) return
    await persistNow(flowId)
    if (assetIds.length === 0) return
    try {
      await repository.deleteAssets(assetIds)
    } catch (err) {
      reportStorageIssue(err)
    }
  }

  // Valida o que é preciso pra gerar (nó existe, prompt conectado) e devolve
  // a configuração atual do nó. Se faltar algo, mostra o aviso no próprio nó.
  function prepareGeneration(flowId: string, imageNodeId: string) {
    const slice = get().flowsData[flowId]
    const node = findImageNode(flowId, imageNodeId)
    if (!slice || !node) return null

    const prompt = getConnectedPrompt(slice, imageNodeId)
    if (!prompt) {
      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        notice: 'Conecte um nó de prompt com texto antes de gerar.',
      }))
      return null
    }

    const config: ImageGenerationConfig = { model: node.data.model, size: node.data.size, quality: node.data.quality }
    const providerKind = get().providerKind
    const ctx: GenerationContext = { prompt, config, provider: providerKind }
    return { node, prompt, config, provider: getProvider(providerKind), ctx }
  }

  function findReferenceNode(flowId: string, nodeId: string): ReferenceFlowNode | undefined {
    const node = get().flowsData[flowId]?.nodes.find((n) => n.id === nodeId)
    return node?.type === 'reference' ? node : undefined
  }

  function updateReferenceNode(flowId: string, id: string, updater: (data: ReferenceNodeData) => ReferenceNodeData) {
    updateFlowSlice(flowId, (slice) => ({
      ...slice,
      nodes: slice.nodes.map((n) => (n.id === id && n.type === 'reference' ? { ...n, data: updater(n.data) } : n)),
    }))
  }

  // Lê, valida e salva uma foto de referência. A mesma foto (mesmo hash) já
  // usada em outro nó do projeto reaproveita o arquivo salvo — sem cópia.
  async function ingestReferenceFile(
    flowId: string,
    nodeId: string,
    file: ReferenceFileInput,
  ): Promise<{ image: ReferenceImage } | { error: string }> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
    } catch {
      return { error: `${file.name}: não foi possível ler o arquivo` }
    }
    const check = checkReferenceFile(bytes)
    if (!check.ok) return { error: `${file.name}: ${check.error}` }
    const sha256 = await sha256Hex(bytes)
    const base = {
      id: nextId('ref'),
      name: file.name,
      mimeType: check.mimeType,
      byteLength: bytes.byteLength,
      width: check.width,
      height: check.height,
      sha256,
    }

    const existing = (get().flowsData[flowId]?.nodes ?? [])
      .flatMap((n) => (n.type === 'reference' ? n.data.images : []))
      .find((img) => img.sha256 === sha256 && img.assetId && !img.missing)
    if (existing) return { image: { ...base, assetId: existing.assetId, src: existing.src } }

    if (!isPersistent()) return { image: { ...base, src: bytesToDataUrl(bytes, check.mimeType) } }
    try {
      const asset: AssetRecord = {
        id: nextId('asset'),
        projectId: flowId,
        kind: 'reference',
        mimeType: check.mimeType,
        bytes: toArrayBuffer(bytes),
        byteLength: bytes.byteLength,
        width: check.width,
        height: check.height,
        createdAt: Date.now(),
        sha256,
        reference: { nodeId, name: file.name },
      }
      await repository.putAsset(asset)
      return { image: { ...base, assetId: asset.id, src: getAssetUrl(asset.id, asset.bytes, asset.mimeType) } }
    } catch (err) {
      reportStorageIssue(err)
      return { image: { ...base, src: bytesToDataUrl(bytes, check.mimeType), unsaved: true } }
    }
  }

  // Planeja as fotos e as instruções de uma geração (sem ler bytes ainda):
  // personagens da biblioteca escolhidos no nó + referências conectadas +
  // guia de estilo do projeto. Usado tanto pra gerar quanto pra mostrar a
  // pré-visualização — o que aparece na tela é exatamente o que vai.
  function planGenerationInputs(flowId: string, imageNodeId: string, scene: string): GenerationPlan | { error: string } {
    const slice = get().flowsData[flowId]
    const node = findImageNode(flowId, imageNodeId)
    if (!slice || !node) return { error: 'Nó não encontrado.' }
    const model = node.data.model
    const style = slice.styleGuide?.enabled ? slice.styleGuide : null

    // personagens (ids estáveis da biblioteca)
    const library = useCharacterStore.getState().characters
    const castIds = node.data.castIds ?? []
    const cast: Character[] = []
    for (const id of castIds) {
      const character = library.find((c) => c.id === id)
      if (!character) {
        return { error: 'Um personagem desta cena foi excluído da biblioteca. Remova-o do nó (ou restaure o backup) para continuar.' }
      }
      if (!character.photos.some((p) => !p.missing)) {
        return { error: `As fotos de "${character.name}" não foram encontradas no armazenamento. Edite o personagem.` }
      }
      cast.push(character)
    }

    const refNodes = connectedReferenceNodes(slice, imageNodeId)
    const empty = refNodes.find((n) => n.data.images.length === 0)
    if (empty) return { error: `O nó de referência "${empty.data.label || 'sem nome'}" está sem fotos.` }
    const missingRef = refNodes.flatMap((n) => n.data.images).find((img) => img.missing)
    if (missingRef) return { error: `Referência indisponível: a foto "${missingRef.name}" não foi encontrada — substitua ou remova.` }

    const refPhotos = refNodes.reduce((sum, n) => sum + n.data.images.length, 0)
    const hasImages = cast.length > 0 || refPhotos > 0
    if (hasImages && !supportsReferences(model)) {
      return {
        error: `${MODEL_LABELS[model]} não aceita imagens de referência. Escolha GPT Image 1.5, GPT Image 1 ou GPT Image 1 Mini, ou retire personagens e referências.`,
      }
    }

    // limite de fotos: a principal de cada personagem e todas as das
    // referências são obrigatórias; o que sobrar vai pras fotos extras dos
    // personagens, uma de cada vez (rodízio)
    const castPhotos = cast.map((c) => orderedPhotos(c).filter((p) => !p.missing))
    const allocation = allocateCharacterPhotos(castPhotos, refPhotos, DEFAULT_MAX_REFERENCES)
    if (!allocation.ok) {
      return {
        error: `Esta cena precisa de ${allocation.required} fotos (1 por personagem + referências), acima do limite de ${DEFAULT_MAX_REFERENCES} por geração.`,
      }
    }
    const chosen = allocation.chosen

    const notes = node.data.castNotes ?? {}
    const images: PlannedImage[] = []
    const omitted: GenerationPlan['omitted'] = []
    cast.forEach((c, i) => {
      for (const p of chosen[i]) {
        images.push({ kind: 'character', ownerId: c.id, ownerLabel: c.name, role: 'character', photoName: p.name, src: p.src, assetId: p.assetId, sha256: p.sha256, mimeType: p.mimeType, width: p.width, height: p.height, byteLength: p.byteLength })
      }
      for (const p of castPhotos[i].slice(chosen[i].length)) omitted.push({ ownerLabel: c.name, photoName: p.name })
    })
    for (const n of refNodes) {
      for (const img of n.data.images) {
        images.push({ kind: 'reference', ownerId: n.id, ownerLabel: n.data.label || 'sem nome', role: n.data.role, photoName: img.name, src: img.src, assetId: img.assetId, sha256: img.sha256, mimeType: img.mimeType, width: img.width, height: img.height, byteLength: img.byteLength })
      }
    }

    const prompt = composePrompt({
      scene,
      cast: cast.map((c, i) => ({ sheet: sheetOf(c), sceneNote: notes[c.id], imageCount: chosen[i].length })),
      references: refNodes.map((n) => ({
        label: n.data.label,
        role: n.data.role,
        preserveClothing: n.data.preserveClothing,
        imageCount: n.data.images.length,
      })),
      style,
    })

    return {
      model,
      scene,
      prompt,
      images,
      omitted,
      characters: cast.map((c, i) => ({
        id: c.id,
        name: c.name,
        version: c.version,
        sheet: sheetOf(c),
        sceneNote: notes[c.id] ?? '',
        sent: chosen[i].length,
        total: castPhotos[i].length,
      })),
      references: refNodes.map((n) => ({ label: n.data.label || 'sem nome', role: n.data.role, count: n.data.images.length })),
      style,
      inputFidelity: hasImages ? effectiveFidelity(model, node.data.inputFidelity) : undefined,
    }
  }

  // Lê os BYTES das fotos planejadas (biblioteca ou referências). As fotos
  // vão de verdade no pedido — nunca são trocadas por descrição em texto.
  async function materializePlan(plan: GenerationPlan): Promise<PreparedReferences | { error: string }> {
    const inputs: ReferenceImageInput[] = []
    try {
      for (const img of plan.images) {
        let bytes: Uint8Array | undefined
        if (img.src?.startsWith('data:')) bytes = dataUrlToBytes(img.src).bytes
        else if (img.assetId && isPersistent()) {
          const asset = await repository.getAsset(img.assetId)
          if (asset) bytes = new Uint8Array(asset.bytes)
        }
        if (!bytes) throw new Error(`a foto "${img.photoName}" (${img.ownerLabel}) não foi encontrada no armazenamento`)
        inputs.push({ sha256: img.sha256, mimeType: img.mimeType, byteLength: bytes.byteLength, width: img.width, height: img.height, b64: bytesToBase64(bytes) })
      }
    } catch (err) {
      return { error: `Referência indisponível: ${errorMessage(err, 'erro ao ler a foto')}.` }
    }
    return {
      prompt: plan.prompt,
      inputs,
      sourceRefs: plan.images.map((img) => ({ assetId: img.assetId, sha256: img.sha256, label: img.ownerLabel, role: img.role })),
      inputFidelity: plan.inputFidelity,
    }
  }

  // Contexto que fica registrado em cada imagem gerada (inclusive a ficha
  // dos personagens como estava — editar depois não apaga esse histórico).
  function planContext(plan: GenerationPlan): Partial<GenerationContext> {
    return {
      prompt: plan.prompt,
      characters: plan.characters.map((c) => ({
        characterId: c.id,
        version: c.version,
        sheet: { ...c.sheet },
        sceneNote: c.sceneNote || undefined,
        photoSha256: plan.images.filter((img) => img.kind === 'character' && img.ownerId === c.id).map((img) => img.sha256),
      })),
      styleGuideApplied: !!plan.style,
    }
  }

  function applyRestored(restored: RestoredProject[], persistence: PersistenceMode, issue: StorageIssue | null) {
    const flowsData: Record<string, FlowSlice> = {}
    for (const r of restored) flowsData[r.meta.id] = r.slice
    set({
      hydrated: true,
      persistence,
      storageIssue: issue,
      flowsData,
      flows: sortByCreation(restored.map((r) => r.meta)),
    })
    if (restored.length === 0) get().createFlow()
  }

  // Banco indisponível: mostra os fluxos antigos do localStorage (se houver)
  // pra não sumir nada da tela, mas sem salvar.
  function hydrateInMemory(err: unknown, kind: 'unavailable' | 'read') {
    const legacy = Object.values(loadFlowsRaw())
      .map(legacyFlowToProject)
      .filter((p): p is ProjectRecord => !!p)
    const error = toStorageError(err, kind)
    applyRestored(
      legacy.map((p) => restoreProject(p, [])),
      'memory',
      { kind: error.kind, message: error.message },
    )
  }

  async function loadFromDatabase() {
    try {
      await repository.open()
    } catch (err) {
      hydrateInMemory(err, 'unavailable')
      return
    }

    let issue: StorageIssue | null = null
    try {
      await migrateLegacyFlows()
    } catch (err) {
      const error = toStorageError(err)
      issue = { kind: error.kind, message: error.message }
    }

    let restored: RestoredProject[]
    let strayAssetIds: string[]
    try {
      const records = await repository.listProjects()
      restored = await Promise.all(
        records.map(async (record) => restoreProject(record, await repository.listAssetsByProject(record.id))),
      )
      // arquivos de projetos que já não existem (ex.: app fechado no meio
      // da exclusão de um fluxo)
      const projectIds = new Set(records.map((r) => r.id))
      // (as fotos da biblioteca de personagens não pertencem a projeto nenhum)
      strayAssetIds = (await repository.listAssetOwners())
        .filter((o) => o.projectId !== LIBRARY_PROJECT_ID && !projectIds.has(o.projectId))
        .map((o) => o.assetId)
    } catch (err) {
      // não conseguimos ler: não arrisca sobrescrever nada
      hydrateInMemory(err, 'read')
      return
    }

    applyRestored(restored, 'indexeddb', issue)

    for (const r of restored) if (r.recoveredCount > 0) markDirty(r.meta.id)
    const orphans = [...restored.flatMap((r) => r.orphanAssetIds), ...strayAssetIds]
    if (orphans.length > 0) {
      try {
        await repository.deleteAssets(orphans)
      } catch (err) {
        reportStorageIssue(err)
      }
    }
  }

  return {
    hydrated: false,
    persistence: 'pending',
    storageIssue: null,
    costConfirmation: null,
    flowsData: {},
    flows: [],
    providerKind: loadProviderKind(),

    hydrate: () => {
      hydrating ??= loadFromDatabase()
      return hydrating
    },

    dismissStorageIssue: () => set({ storageIssue: null }),

    confirmCost: (title, quote) => requestCostConfirmation(title, quote),

    resolveCostConfirmation: (confirmed) => {
      const resolve = pendingConfirmation
      pendingConfirmation = null
      set({ costConfirmation: null })
      resolve?.(confirmed)
    },

    onNodesChange: (flowId, changes) => {
      // nós apagados pela tecla Delete/Backspace também levam seus arquivos
      const removedIds = new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])))
      const removedAssets =
        removedIds.size > 0
          ? collectAssetIds(get().flowsData[flowId]?.nodes.filter((n) => removedIds.has(n.id)) ?? [])
          : []

      updateFlowSlice(flowId, (slice) => ({
        ...slice,
        nodes: applyNodeChanges(changes, slice.nodes) as FlowNode[],
      }))

      if (removedAssets.length > 0) void discardAssets(flowId, removedAssets)
    },

    onEdgesChange: (flowId, changes) => {
      updateFlowSlice(flowId, (slice) => ({ ...slice, edges: applyEdgeChanges(changes, slice.edges) }))
    },

    onConnect: (flowId, connection) => {
      if (!isValidFlowConnection(connection)) return
      updateFlowSlice(flowId, (slice) => {
        if (connection.targetHandle === REFERENCE_EDGE_HANDLE) {
          // várias referências por nó de imagem; só não repete a mesma
          const duplicate = slice.edges.some(
            (e) => e.source === connection.source && e.target === connection.target && e.targetHandle === REFERENCE_EDGE_HANDLE,
          )
          return duplicate ? slice : { ...slice, edges: addEdge({ ...connection, animated: false }, slice.edges) }
        }
        // só um prompt por nó de imagem: tira o anterior antes de puxar outro
        const filtered = slice.edges.filter(
          (e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle),
        )
        return { ...slice, edges: addEdge({ ...connection, animated: false }, filtered) }
      })
    },

    addPromptNode: (flowId, position) => {
      const node: PromptFlowNode = {
        id: nextId('prompt'),
        type: 'prompt',
        position,
        data: { prompt: '' },
        dragHandle: '.ifs-node__header',
      }
      updateFlowSlice(flowId, (slice) => ({ ...slice, nodes: [...slice.nodes, node] }))
    },

    addImageNode: (flowId, position) => {
      const node: ImageFlowNode = {
        id: nextId('image'),
        type: 'image',
        position,
        data: defaultImageData(get().flowsData[flowId]?.styleGuide),
        dragHandle: '.ifs-node__header',
      }
      updateFlowSlice(flowId, (slice) => ({ ...slice, nodes: [...slice.nodes, node] }))
    },

    addReferenceNode: (flowId, position) => {
      const node: ReferenceFlowNode = {
        id: nextId('reference'),
        type: 'reference',
        position,
        data: { label: '', role: 'character', preserveClothing: false, images: [] },
        dragHandle: '.ifs-node__header',
      }
      updateFlowSlice(flowId, (slice) => ({ ...slice, nodes: [...slice.nodes, node] }))
    },

    updateReferenceData: (flowId, id, partial) => {
      updateReferenceNode(flowId, id, (data) => ({ ...data, ...partial }))
    },

    addReferenceImages: async (flowId, nodeId, files) => {
      const errors: string[] = []
      for (const file of files) {
        const node = findReferenceNode(flowId, nodeId)
        if (!node) return
        if (node.data.images.length >= DEFAULT_MAX_REFERENCES) {
          errors.push(`${file.name}: limite de ${DEFAULT_MAX_REFERENCES} fotos por nó`)
          continue
        }
        const result = await ingestReferenceFile(flowId, nodeId, file)
        if ('error' in result) {
          errors.push(result.error)
          continue
        }
        if (findReferenceNode(flowId, nodeId)?.data.images.some((img) => img.sha256 === result.image.sha256)) {
          errors.push(`${file.name}: essa foto já está neste nó`)
          continue
        }
        updateReferenceNode(flowId, nodeId, (data) => ({ ...data, images: [...data.images, result.image] }))
      }
      updateReferenceNode(flowId, nodeId, (data) => ({ ...data, notice: errors.length ? errors.join(' · ') : undefined }))
      // nó apagado durante o upload: não deixa arquivo sem dono
      if (!findReferenceNode(flowId, nodeId)) await discardAssets(flowId, [])
      else if (isPersistent()) await persistNow(flowId)
    },

    replaceReferenceImage: async (flowId, nodeId, imageId, file) => {
      const old = findReferenceNode(flowId, nodeId)?.data.images.find((img) => img.id === imageId)
      if (!old) return
      const result = await ingestReferenceFile(flowId, nodeId, file)
      if ('error' in result) {
        updateReferenceNode(flowId, nodeId, (data) => ({ ...data, notice: result.error }))
        return
      }
      updateReferenceNode(flowId, nodeId, (data) => ({
        ...data,
        notice: undefined,
        images: data.images.map((img) => (img.id === imageId ? { ...result.image, id: imageId } : img)),
      }))
      await discardAssets(flowId, old.assetId && old.assetId !== result.image.assetId ? [old.assetId] : [])
    },

    removeReferenceImage: (flowId, nodeId, imageId) => {
      const assetId = findReferenceNode(flowId, nodeId)?.data.images.find((img) => img.id === imageId)?.assetId
      updateReferenceNode(flowId, nodeId, (data) => ({ ...data, images: data.images.filter((img) => img.id !== imageId) }))
      void discardAssets(flowId, assetId ? [assetId] : [])
    },

    setCast: (flowId, imageNodeId, castIds) => {
      const unique = [...new Set(castIds)]
      updateImageNode(flowId, imageNodeId, (data) => {
        const notes = Object.fromEntries(Object.entries(data.castNotes ?? {}).filter(([id]) => unique.includes(id)))
        return { ...data, castIds: unique, castNotes: notes, notice: undefined }
      })
    },

    setCastNote: (flowId, imageNodeId, characterId, note) => {
      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        castNotes: { ...(data.castNotes ?? {}), [characterId]: note.slice(0, 500) },
      }))
    },

    updateStyleGuide: (flowId, partial) => {
      updateFlowSlice(flowId, (slice) => ({
        ...slice,
        styleGuide: { ...(slice.styleGuide ?? defaultStyleGuide()), ...partial },
      }))
    },

    getGenerationPreview: (flowId, imageNodeId) => {
      const slice = get().flowsData[flowId]
      if (!slice || !findImageNode(flowId, imageNodeId)) return { error: 'Nó não encontrado.' }
      const scene = getConnectedPrompt(slice, imageNodeId)
      if (!scene) return { error: 'Conecte um nó de prompt com texto para ver as instruções.' }
      return planGenerationInputs(flowId, imageNodeId, scene)
    },

    deleteNode: (flowId, id) => {
      const removedAssets = collectAssetIds(get().flowsData[flowId]?.nodes.filter((n) => n.id === id) ?? [])
      updateFlowSlice(flowId, (slice) => ({
        nodes: slice.nodes.filter((n) => n.id !== id),
        edges: slice.edges.filter((e) => e.source !== id && e.target !== id),
      }))
      if (removedAssets.length > 0) void discardAssets(flowId, removedAssets)
    },

    updatePromptData: (flowId, id, partial) => {
      updatePromptNode(flowId, id, (data) => ({ ...data, ...partial }))
    },

    enhancePrompt: async (flowId, id) => {
      const node = get().flowsData[flowId]?.nodes.find((n) => n.id === id)
      if (!node || node.type !== 'prompt') return
      const original = node.data.prompt.trim()
      if (!original) return

      updatePromptNode(flowId, id, (data) => ({ ...data, enhancing: true, enhanceError: undefined }))
      const provider = getProvider(get().providerKind)

      try {
        let quoteId: string | undefined
        if (provider.quoteEnhance) {
          const quote = await provider.quoteEnhance(original)
          if (!(await requestCostConfirmation('Melhorar prompt', quote))) {
            updatePromptNode(flowId, id, (data) => ({ ...data, enhancing: false, enhanceError: GENERATION_CANCELLED_MESSAGE }))
            return
          }
          quoteId = quote.quoteId
        }
        const enhanced = await provider.enhancePrompt(original, quoteId ? { quoteId } : undefined)
        updatePromptNode(flowId, id, (data) => ({ ...data, prompt: enhanced, enhancing: false }))
      } catch (err) {
        const message = errorMessage(err, 'Falha ao melhorar o prompt')
        updatePromptNode(flowId, id, (data) => ({ ...data, enhancing: false, enhanceError: message }))
      }
    },

    updateImageConfig: (flowId, id, partial) => {
      updateImageNode(flowId, id, (data) => ({ ...data, ...partial }))

      // guarda preset (modelo/tamanho/qualidade/quantidade) como padrão do próximo nó de imagem
      const node = findImageNode(flowId, id)
      if (node) {
        saveImagePreset({
          model: node.data.model,
          size: node.data.size,
          quality: node.data.quality,
          count: node.data.count,
        })
      }
    },

    setProviderKind: (kind) => {
      saveProviderKind(kind)
      set({ providerKind: kind })
    },

    createFlow: () => {
      const id = nextId('flow')
      const now = Date.now()
      const meta: FlowMeta = { id, name: `Fluxo ${get().flows.length + 1}`, createdAt: now, updatedAt: now }

      set((state) => ({
        flowsData: { ...state.flowsData, [id]: { nodes: [], edges: [], styleGuide: defaultStyleGuide() } },
        flows: [...state.flows, meta],
      }))
      void persistNow(id)

      return id
    },

    renameFlow: (flowId, name) => {
      const trimmed = name.trim() || 'Sem nome'
      if (!get().flows.some((f) => f.id === flowId)) return
      set((state) => ({
        flows: state.flows.map((f) => (f.id === flowId ? { ...f, name: trimmed, updatedAt: Date.now() } : f)),
      }))
      markDirty(flowId)
    },

    deleteFlow: (flowId) => {
      const assetIds = collectAssetIds(get().flowsData[flowId]?.nodes ?? [])

      set((state) => {
        const { [flowId]: _removed, ...restData } = state.flowsData
        return {
          flowsData: restData,
          flows: state.flows.filter((f) => f.id !== flowId),
        }
      })
      dirtyFlowIds.delete(flowId)
      for (const id of assetIds) releaseAssetUrl(id)

      // apaga o projeto e todos os arquivos dele numa transação só
      if (isPersistent()) repository.deleteProject(flowId).catch(reportStorageIssue)
    },

    generate: async (flowId, imageNodeId) => {
      const prepared = prepareGeneration(flowId, imageNodeId)
      if (!prepared) return
      const { node, config, provider } = prepared
      let { prompt, ctx } = prepared

      const previousSlots = node.data.images
      const aspect = resolveAspect(config)
      const count = clampCount(node.data.count)
      const setNotice = (notice: string) => updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice }))

      // personagens + referências + guia de estilo; as fotos só são lidas
      // (de forma assíncrona) quando existem
      const plan = planGenerationInputs(flowId, imageNodeId, prompt)
      if ('error' in plan) {
        updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice: plan.error }))
        return
      }
      prompt = plan.prompt
      ctx = { ...ctx, ...planContext(plan) }
      let refs: PreparedReferences | null = null
      if (plan.images.length) {
        const loaded = await materializePlan(plan)
        if ('error' in loaded) {
          updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice: loaded.error }))
          return
        }
        refs = loaded
        ctx = { ...ctx, references: refs.sourceRefs, inputFidelity: refs.inputFidelity }
      }
      const refJob = refs?.inputs.length
        ? { references: refs.inputs.map(toDescriptor), ...(refs.inputFidelity ? { inputFidelity: refs.inputFidelity } : {}) }
        : {}

      // provedor pago: orçamento + confirmação ANTES de mexer nas imagens
      let quoteId: string | undefined
      if (provider.quoteImages) {
        setNotice('Calculando o custo estimado…')
        const title = `Gerar ${count} imagem(ns)${refs?.inputs.length ? ` com ${refs.inputs.length} referência(s)` : ''}`
        const confirmed = await confirmImageJob(provider, { ...config, prompt, totalImages: count, ...refJob }, title, setNotice)
        if (confirmed === null || !findImageNode(flowId, imageNodeId)) return
        quoteId = confirmed
      }

      const slotIds = Array.from({ length: count }, () => nextId('img'))

      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        notice: undefined,
        images: slotIds.map((id) => ({ id, status: 'loading', aspect })),
      }))

      const results = await runGeneration({
        provider,
        config,
        prompt,
        count: slotIds.length,
        crop: cropToAspect,
        quoteId,
        references: refs?.inputs.length ? refs.inputs : undefined,
        inputFidelity: refs?.inputFidelity,
      })
      const saved = await Promise.all(
        results.map((r, i) =>
          r.ok ? saveGeneratedImage(flowId, imageNodeId, slotIds[i], r.image, ctx) : Promise.resolve(null),
        ),
      )
      const newAssetIds = saved.flatMap((s) => (s?.assetId ? [s.assetId] : []))

      // nó ou fluxo apagado durante a geração: descarta o que acabou de salvar
      if (!findImageNode(flowId, imageNodeId)) {
        for (const id of newAssetIds) releaseAssetUrl(id)
        if (isPersistent() && newAssetIds.length > 0) repository.deleteAssets(newAssetIds).catch(reportStorageIssue)
        return
      }

      // tudo falhou: devolve as imagens que existiam antes
      if (results.every((r) => !r.ok) && previousSlots.some((s) => s.status === 'done')) {
        updateImageNode(flowId, imageNodeId, (data) => ({
          ...data,
          images: previousSlots,
          notice: `A geração falhou e as imagens anteriores foram mantidas: ${summarizeFailures(results)}`,
        }))
        return
      }

      // cada resultado vai pro slot pelo ID (não pela posição): se a pessoa
      // remover uma imagem enquanto as outras carregam, nada fica desalinhado
      const byId = new Map(slotIds.map((id, i) => [id, { result: results[i], saved: saved[i] }]))
      updateImageNode(flowId, imageNodeId, (data) => {
        const images = data.images.map((slot): ImageSlot => {
          const entry = byId.get(slot.id)
          if (!entry) return slot
          if (!entry.result.ok) return { ...slot, status: 'error', error: entry.result.error }
          const s = entry.saved as SavedImage
          return { ...slot, status: 'done', src: s.src, mimeType: s.mimeType, assetId: s.assetId, unsaved: s.unsaved, error: undefined }
        })
        return { ...data, images, notice: summarizeFailures(results) }
      })

      // arquivos novos de slots removidos durante a geração
      const keptIds = new Set(findImageNode(flowId, imageNodeId)?.data.images.map((s) => s.id))
      const droppedNew = saved.flatMap((s, i) => (s?.assetId && !keptIds.has(slotIds[i]) ? [s.assetId] : []))

      // as imagens antigas só são apagadas se todas as novas foram salvas —
      // se alguma gravação falhou, as antigas ficam guardadas (e voltam ao
      // nó na próxima abertura) pra não perder nada
      const allSaved = saved.every((s) => s === null || !s.unsaved)
      const replaced = allSaved ? collectAssetIds([{ ...node, data: { ...node.data, images: previousSlots } }]) : []

      await discardAssets(flowId, [...replaced, ...droppedNew])
    },

    regenerateSlot: async (flowId, imageNodeId, slotId) => {
      const prepared = prepareGeneration(flowId, imageNodeId)
      if (!prepared) return
      const { node, config, provider } = prepared
      let { prompt, ctx } = prepared

      const previous = node.data.images.find((s) => s.id === slotId)
      if (!previous) return

      // personagens + referências + guia de estilo; as fotos só são lidas
      // (de forma assíncrona) quando existem
      const plan = planGenerationInputs(flowId, imageNodeId, prompt)
      if ('error' in plan) {
        updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice: plan.error }))
        return
      }
      prompt = plan.prompt
      ctx = { ...ctx, ...planContext(plan) }
      let refs: PreparedReferences | null = null
      if (plan.images.length) {
        const loaded = await materializePlan(plan)
        if ('error' in loaded) {
          updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice: loaded.error }))
          return
        }
        refs = loaded
        ctx = { ...ctx, references: refs.sourceRefs, inputFidelity: refs.inputFidelity }
      }
      const refJob = refs?.inputs.length
        ? { references: refs.inputs.map(toDescriptor), ...(refs.inputFidelity ? { inputFidelity: refs.inputFidelity } : {}) }
        : {}

      let quoteId: string | undefined
      if (provider.quoteImages) {
        const confirmed = await confirmImageJob(provider, { ...config, prompt, totalImages: 1, ...refJob }, 'Gerar de novo 1 imagem', (notice) =>
          updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice })),
        )
        if (confirmed === null || !findImageNode(flowId, imageNodeId)?.data.images.some((s) => s.id === slotId)) return
        quoteId = confirmed
        updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice: undefined }))
      }

      // a proporção do slot acompanha a configuração ATUAL do nó — se a
      // pessoa mudou de 1:1 pra 9:16, a nova imagem não fica espremida
      updateSlot(flowId, imageNodeId, slotId, (slot) => ({
        ...slot,
        status: 'loading',
        error: undefined,
        aspect: resolveAspect(config),
      }))

      const [result] = await runGeneration({
        provider,
        config,
        prompt,
        count: 1,
        crop: cropToAspect,
        quoteId,
        references: refs?.inputs.length ? refs.inputs : undefined,
        inputFidelity: refs?.inputFidelity,
      })

      if (result?.ok) {
        const saved = await saveGeneratedImage(flowId, imageNodeId, slotId, result.image, ctx)

        // slot apagado enquanto regerava: descarta a imagem nova
        if (!findImageNode(flowId, imageNodeId)?.data.images.some((s) => s.id === slotId)) {
          if (saved.assetId) await discardAssets(flowId, [saved.assetId])
          return
        }

        updateSlot(flowId, imageNodeId, slotId, (slot) => ({
          ...slot,
          status: 'done',
          src: saved.src,
          mimeType: saved.mimeType,
          assetId: saved.assetId,
          unsaved: saved.unsaved,
          error: undefined,
        }))
        // a anterior só é apagada depois que a nova foi salva
        const replaced = saved.assetId && previous.assetId && previous.assetId !== saved.assetId ? [previous.assetId] : []
        await discardAssets(flowId, replaced)
        return
      }

      const message = result ? result.error : 'Sem resposta'
      if (previous.status === 'done' && previous.src) {
        // falhou ao refazer uma imagem que já existia: mantém a anterior
        updateSlot(flowId, imageNodeId, slotId, () => previous)
        updateImageNode(flowId, imageNodeId, (data) => ({
          ...data,
          notice: `Não foi possível gerar de novo (a imagem anterior foi mantida): ${message}`,
        }))
      } else {
        updateSlot(flowId, imageNodeId, slotId, (slot) => ({ ...slot, status: 'error', error: message }))
      }
    },

    deleteSlot: (flowId, imageNodeId, slotId) => {
      const assetId = findImageNode(flowId, imageNodeId)?.data.images.find((s) => s.id === slotId)?.assetId
      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        images: data.images.filter((s) => s.id !== slotId),
      }))
      void discardAssets(flowId, assetId ? [assetId] : [])
    },
  }
})

// Autosave por fluxo: qualquer mudança de nós/arestas daquele fluxo (mover,
// conectar, digitar, gerar...) agenda uma gravação alguns ms depois da
// última mudança — funciona mesmo pra fluxos fora de tela (gerando em
// segundo plano) porque cada ação já diz de qual flowId ela é.
const dirtyFlowIds = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | undefined

function markDirty(flowId: string) {
  dirtyFlowIds.add(flowId)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushDirtyFlows(), 600)
}

function persistNow(flowId: string): Promise<void> {
  dirtyFlowIds.add(flowId)
  return flushDirtyFlows()
}

export async function flushDirtyFlows(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  const state = useFlowStore.getState()

  if (state.persistence !== 'indexeddb') {
    if (state.persistence === 'memory') dirtyFlowIds.clear()
    return
  }

  const records: ProjectRecord[] = []
  for (const id of dirtyFlowIds) {
    const slice = state.flowsData[id]
    const meta = state.flows.find((f) => f.id === id)
    if (!slice || !meta) continue // fluxo foi apagado nesse meio tempo
    records.push(serializeProject(meta, slice))
  }
  dirtyFlowIds.clear()
  if (records.length === 0) return

  try {
    await repository.saveProjects(records)
  } catch (err) {
    // tenta de novo na próxima mudança
    for (const r of records) dirtyFlowIds.add(r.id)
    const error = toStorageError(err)
    useFlowStore.setState({ storageIssue: { kind: error.kind, message: error.message } })
  }
}

// salva o que estiver pendente ao fechar/trocar de aba
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushDirtyFlows())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushDirtyFlows()
  })
}
