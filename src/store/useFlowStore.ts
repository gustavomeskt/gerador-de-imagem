import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { clampCount, DEFAULT_MODEL, getSizeOption, isImageModel, MODEL_SIZES } from '../generation/models'
import { getProvider } from '../generation/providers'
import { resolveAspect, runGeneration, type ImageGenerationConfig, type ImageResult } from '../generation/service'
import type { CostQuote, GeneratedImage, ImageJob, ImageProvider, ProviderKind } from '../generation/types'
import { dataUrlToBytes, readImageSize, toArrayBuffer } from '../lib/binary'
import { cropToAspect } from '../lib/image'
import { loadFlowsRaw, loadImagePreset, loadProviderKind, saveImagePreset, saveProviderKind } from '../lib/storage'
import { getAssetUrl, releaseAssetUrl } from '../persistence/assetUrls'
import { toStorageError, type StorageIssueKind } from '../persistence/errors'
import { legacyFlowToProject, migrateLegacyFlows } from '../persistence/migration'
import { repository } from '../persistence/repository'
import type { AssetRecord, ProjectRecord } from '../persistence/schema'
import { collectAssetIds, restoreProject, serializeProject, type RestoredProject } from './projectSerialization'
import type {
  FlowMeta,
  FlowNode,
  FlowSlice,
  ImageFlowNode,
  ImageNodeData,
  ImageSlot,
  PromptFlowNode,
  PromptNodeData,
} from './types'

export type {
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

function defaultImageData(): ImageNodeData {
  const preset = loadImagePreset()
  const model = isImageModel(preset?.model) ? preset.model : DEFAULT_MODEL
  const size = preset?.size && getSizeOption(model, preset.size) ? preset.size : MODEL_SIZES[model][0].value
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

  onNodesChange: (flowId: string, changes: NodeChange[]) => void
  onEdgesChange: (flowId: string, changes: EdgeChange[]) => void
  onConnect: (flowId: string, connection: Connection) => void

  addPromptNode: (flowId: string, position: { x: number; y: number }) => void
  addImageNode: (flowId: string, position: { x: number; y: number }) => void
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
  async function discardAssets(flowId: string, assetIds: string[]) {
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
    return { node, prompt, config, provider: getProvider(providerKind), ctx: { prompt, config, provider: providerKind } }
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
      strayAssetIds = (await repository.listAssetOwners())
        .filter((o) => !projectIds.has(o.projectId))
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
      updateFlowSlice(flowId, (slice) => {
        // só uma conexão de entrada por nó de imagem: tira a anterior antes de puxar outra
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
        data: defaultImageData(),
        dragHandle: '.ifs-node__header',
      }
      updateFlowSlice(flowId, (slice) => ({ ...slice, nodes: [...slice.nodes, node] }))
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
        flowsData: { ...state.flowsData, [id]: { nodes: [], edges: [] } },
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
      const { node, prompt, config, provider, ctx } = prepared

      const previousSlots = node.data.images
      const aspect = resolveAspect(config)
      const count = clampCount(node.data.count)
      const setNotice = (notice: string) => updateImageNode(flowId, imageNodeId, (data) => ({ ...data, notice }))

      // provedor pago: orçamento + confirmação ANTES de mexer nas imagens
      let quoteId: string | undefined
      if (provider.quoteImages) {
        setNotice('Calculando o custo estimado…')
        const confirmed = await confirmImageJob(provider, { ...config, prompt, totalImages: count }, `Gerar ${count} imagem(ns)`, setNotice)
        if (confirmed === null || !findImageNode(flowId, imageNodeId)) return
        quoteId = confirmed
      }

      const slotIds = Array.from({ length: count }, () => nextId('img'))

      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        notice: undefined,
        images: slotIds.map((id) => ({ id, status: 'loading', aspect })),
      }))

      const results = await runGeneration({ provider, config, prompt, count: slotIds.length, crop: cropToAspect, quoteId })
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
      const { node, prompt, config, provider, ctx } = prepared

      const previous = node.data.images.find((s) => s.id === slotId)
      if (!previous) return

      let quoteId: string | undefined
      if (provider.quoteImages) {
        const confirmed = await confirmImageJob(provider, { ...config, prompt, totalImages: 1 }, 'Gerar de novo 1 imagem', (notice) =>
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

      const [result] = await runGeneration({ provider, config, prompt, count: 1, crop: cropToAspect, quoteId })

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
