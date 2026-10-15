import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import {
  clampCount,
  DEFAULT_MODEL,
  getSizeOption,
  isImageModel,
  MODEL_SIZES,
  type ImageModel,
} from '../generation/models'
import { getProvider } from '../generation/providers'
import { resolveAspect, runGeneration, type ImageGenerationConfig, type ImageResult } from '../generation/service'
import type { ProviderKind } from '../generation/types'
import { cropToAspect } from '../lib/image'
import {
  loadFlowsRaw,
  loadImagePreset,
  loadProviderKind,
  saveFlowsRaw,
  saveImagePreset,
  saveProviderKind,
} from '../lib/storage'

export interface PromptNodeData {
  prompt: string
  enhancing?: boolean
  enhanceError?: string
  [key: string]: unknown
}

export interface ImageSlot {
  id: string
  status: 'loading' | 'done' | 'error'
  src?: string // data URL da imagem
  mimeType?: string
  aspect: number
  error?: string
}

export interface ImageNodeData {
  model: ImageModel
  size: string
  quality?: string
  count: number
  images: ImageSlot[]
  notice?: string
  [key: string]: unknown
}

export type PromptFlowNode = Node<PromptNodeData, 'prompt'>
export type ImageFlowNode = Node<ImageNodeData, 'image'>
export type FlowNode = PromptFlowNode | ImageFlowNode

export interface FlowMeta {
  id: string
  name: string
  updatedAt: number
}

interface FlowSlice {
  nodes: FlowNode[]
  edges: Edge[]
}

interface StoredFlow extends FlowMeta {
  nodes: FlowNode[]
  edges: Edge[]
}

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

function toMeta(flow: StoredFlow): FlowMeta {
  return { id: flow.id, name: flow.name, updatedAt: flow.updatedAt }
}

// Imagens geradas nunca são salvas no fluxo — só a estrutura (nós, posições,
// prompts e configuração) — pra não estourar o localStorage.
function stripImages(nodes: FlowNode[]): FlowNode[] {
  return nodes.map((n) =>
    n.type === 'image' ? { ...n, data: { ...n.data, images: [], notice: undefined } } : n,
  )
}

function loadInitialState() {
  const flowsMap = loadFlowsRaw() as Record<string, StoredFlow>

  if (Object.keys(flowsMap).length === 0) {
    const id = nextId('flow')
    flowsMap[id] = { id, name: 'Fluxo 1', updatedAt: Date.now(), nodes: [], edges: [] }
    saveFlowsRaw(flowsMap)
  }

  const flowsData: Record<string, FlowSlice> = {}
  for (const f of Object.values(flowsMap)) {
    flowsData[f.id] = { nodes: f.nodes ?? [], edges: f.edges ?? [] }
  }

  return {
    flowsData,
    flows: Object.values(flowsMap).map(toMeta),
  }
}

interface FlowState {
  // nós/arestas de TODOS os fluxos, mantidos em memória ao mesmo tempo —
  // assim uma geração de imagem em andamento continua mesmo que a pessoa
  // saia desse fluxo e abra outro.
  flowsData: Record<string, FlowSlice>
  flows: FlowMeta[]
  providerKind: ProviderKind

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

function getConnectedPrompt(nodes: FlowNode[], edges: Edge[], imageNodeId: string): string | null {
  const edge = edges.find((e) => e.target === imageNodeId && e.targetHandle === 'prompt-in')
  if (!edge) return null
  const sourceNode = nodes.find((n) => n.id === edge.source)
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

export const useFlowStore = create<FlowState>((set, get) => {
  const initial = loadInitialState()

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

  // Valida o que é preciso pra gerar (nó existe, prompt conectado) e devolve
  // a configuração atual do nó. Se faltar algo, mostra o aviso no próprio nó.
  function prepareGeneration(flowId: string, imageNodeId: string) {
    const slice = get().flowsData[flowId]
    const node = slice?.nodes.find((n) => n.id === imageNodeId)
    if (!slice || !node || node.type !== 'image') return null

    const prompt = getConnectedPrompt(slice.nodes, slice.edges, imageNodeId)
    if (!prompt) {
      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        notice: 'Conecte um nó de prompt com texto antes de gerar.',
      }))
      return null
    }

    const config: ImageGenerationConfig = { model: node.data.model, size: node.data.size, quality: node.data.quality }
    return { prompt, config, provider: getProvider(get().providerKind) }
  }

  return {
    flowsData: initial.flowsData,
    flows: initial.flows,
    providerKind: loadProviderKind(),

    onNodesChange: (flowId, changes) => {
      updateFlowSlice(flowId, (slice) => ({
        ...slice,
        nodes: applyNodeChanges(changes, slice.nodes) as FlowNode[],
      }))
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
      updateFlowSlice(flowId, (slice) => ({
        nodes: slice.nodes.filter((n) => n.id !== id),
        edges: slice.edges.filter((e) => e.source !== id && e.target !== id),
      }))
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

      try {
        const enhanced = await getProvider(get().providerKind).enhancePrompt(original)
        updatePromptNode(flowId, id, (data) => ({ ...data, prompt: enhanced, enhancing: false }))
      } catch (err) {
        const message = errorMessage(err, 'Falha ao melhorar o prompt')
        updatePromptNode(flowId, id, (data) => ({ ...data, enhancing: false, enhanceError: message }))
      }
    },

    updateImageConfig: (flowId, id, partial) => {
      updateImageNode(flowId, id, (data) => ({ ...data, ...partial }))

      // guarda preset (modelo/tamanho/qualidade/quantidade) como padrão do próximo nó de imagem
      const node = get().flowsData[flowId]?.nodes.find((n) => n.id === id)
      if (node && node.type === 'image') {
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
      const name = `Fluxo ${get().flows.length + 1}`
      const record: StoredFlow = { id, name, updatedAt: Date.now(), nodes: [], edges: [] }

      const flowsMap = loadFlowsRaw() as Record<string, StoredFlow>
      flowsMap[id] = record
      saveFlowsRaw(flowsMap)

      set((state) => ({
        flowsData: { ...state.flowsData, [id]: { nodes: [], edges: [] } },
        flows: [...state.flows, toMeta(record)],
      }))

      return id
    },

    renameFlow: (flowId, name) => {
      const trimmed = name.trim() || 'Sem nome'
      const flowsMap = loadFlowsRaw() as Record<string, StoredFlow>
      if (!flowsMap[flowId]) return

      flowsMap[flowId] = { ...flowsMap[flowId], name: trimmed, updatedAt: Date.now() }
      saveFlowsRaw(flowsMap)

      set((state) => ({
        flows: state.flows.map((f) => (f.id === flowId ? { ...f, name: trimmed } : f)),
      }))
    },

    deleteFlow: (flowId) => {
      const flowsMap = loadFlowsRaw() as Record<string, StoredFlow>
      delete flowsMap[flowId]
      saveFlowsRaw(flowsMap)

      set((state) => {
        const { [flowId]: _removed, ...restData } = state.flowsData
        return {
          flowsData: restData,
          flows: state.flows.filter((f) => f.id !== flowId),
        }
      })
    },

    generate: async (flowId, imageNodeId) => {
      const prepared = prepareGeneration(flowId, imageNodeId)
      if (!prepared) return
      const { prompt, config, provider } = prepared

      const node = get().flowsData[flowId].nodes.find((n) => n.id === imageNodeId) as ImageFlowNode
      const aspect = resolveAspect(config)
      const slotIds = Array.from({ length: clampCount(node.data.count) }, () => nextId('img'))

      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        notice: undefined,
        images: slotIds.map((id) => ({ id, status: 'loading', aspect })),
      }))

      const results = await runGeneration({ provider, config, prompt, count: slotIds.length, crop: cropToAspect })

      // cada resultado vai pro slot pelo ID (não pela posição): se a pessoa
      // remover uma imagem enquanto as outras carregam, nada fica desalinhado
      updateImageNode(flowId, imageNodeId, (data) => {
        const byId = new Map(slotIds.map((id, i) => [id, results[i]]))
        const images = data.images.map((slot): ImageSlot => {
          const result = byId.get(slot.id)
          if (!result) return slot
          return result.ok
            ? { ...slot, status: 'done', src: result.image.src, mimeType: result.image.mimeType, error: undefined }
            : { ...slot, status: 'error', error: result.error }
        })
        return { ...data, images, notice: summarizeFailures(results) }
      })
    },

    regenerateSlot: async (flowId, imageNodeId, slotId) => {
      const prepared = prepareGeneration(flowId, imageNodeId)
      if (!prepared) return
      const { prompt, config, provider } = prepared

      const node = get().flowsData[flowId].nodes.find((n) => n.id === imageNodeId) as ImageFlowNode
      const previous = node.data.images.find((s) => s.id === slotId)
      if (!previous) return

      // a proporção do slot acompanha a configuração ATUAL do nó — se a
      // pessoa mudou de 1:1 pra 9:16, a nova imagem não fica espremida
      updateSlot(flowId, imageNodeId, slotId, (slot) => ({
        ...slot,
        status: 'loading',
        error: undefined,
        aspect: resolveAspect(config),
      }))

      const [result] = await runGeneration({ provider, config, prompt, count: 1, crop: cropToAspect })

      if (result?.ok) {
        updateSlot(flowId, imageNodeId, slotId, (slot) => ({
          ...slot,
          status: 'done',
          src: result.image.src,
          mimeType: result.image.mimeType,
          error: undefined,
        }))
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
      updateImageNode(flowId, imageNodeId, (data) => ({
        ...data,
        images: data.images.filter((s) => s.id !== slotId),
      }))
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
  saveTimer = setTimeout(flushDirtyFlows, 600)
}

export function flushDirtyFlows() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  const state = useFlowStore.getState()
  const flowsMap = loadFlowsRaw() as Record<string, StoredFlow>

  for (const id of dirtyFlowIds) {
    const slice = state.flowsData[id]
    if (!slice) continue
    const meta = state.flows.find((f) => f.id === id)
    if (!meta) continue // fluxo foi apagado nesse meio tempo

    flowsMap[id] = {
      id,
      name: meta.name,
      updatedAt: Date.now(),
      nodes: stripImages(slice.nodes),
      edges: slice.edges,
    }
  }

  saveFlowsRaw(flowsMap)
  dirtyFlowIds.clear()
}
