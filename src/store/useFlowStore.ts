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
import { cropBase64ToAspect } from '../lib/image'
import { enhancePromptText, generateImages, MODEL_SIZES, type ImageModel } from '../lib/openai'
import {
  loadApiKey,
  loadFlowsRaw,
  loadImagePreset,
  saveApiKey,
  saveFlowsRaw,
  saveImagePreset,
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
  b64?: string
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
  const model = (preset?.model as ImageModel) ?? 'gpt-image-1.5'
  const size = preset?.size ?? MODEL_SIZES[model][0].value
  return {
    model,
    size,
    quality: preset?.quality,
    count: preset?.count ?? 1,
    images: [],
  }
}

function toMeta(flow: StoredFlow): FlowMeta {
  return { id: flow.id, name: flow.name, updatedAt: flow.updatedAt }
}

// Imagens geradas (base64) nunca são salvas no fluxo — só a estrutura
// (nós, posições, prompts e configuração) — pra não estourar o localStorage.
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
  apiKey: string

  onNodesChange: (flowId: string, changes: NodeChange[]) => void
  onEdgesChange: (flowId: string, changes: EdgeChange[]) => void
  onConnect: (flowId: string, connection: Connection) => void

  addPromptNode: (flowId: string, position: { x: number; y: number }) => void
  addImageNode: (flowId: string, position: { x: number; y: number }) => void
  deleteNode: (flowId: string, id: string) => void

  updatePromptData: (flowId: string, id: string, partial: Partial<PromptNodeData>) => void
  updateImageConfig: (flowId: string, id: string, partial: Partial<ImageNodeData>) => void
  enhancePrompt: (flowId: string, id: string) => Promise<void>

  setApiKey: (key: string) => void

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
  if (!sourceNode) return null
  const prompt = (sourceNode.data as PromptNodeData).prompt
  return prompt && prompt.trim() ? prompt.trim() : null
}

export const useFlowStore = create<FlowState>((set, get) => {
  const initial = loadInitialState()

  function updateFlowSlice(flowId: string, updater: (slice: FlowSlice) => FlowSlice) {
    set((state) => ({
      flowsData: {
        ...state.flowsData,
        [flowId]: updater(state.flowsData[flowId] ?? { nodes: [], edges: [] }),
      },
    }))
    markDirty(flowId)
  }

  return {
    flowsData: initial.flowsData,
    flows: initial.flows,
    apiKey: loadApiKey(),

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
      updateFlowSlice(flowId, (slice) => ({
        ...slice,
        nodes: slice.nodes.map((n) =>
          n.id === id && n.type === 'prompt' ? { ...n, data: { ...n.data, ...partial } } : n,
        ),
      }))
    },

    enhancePrompt: async (flowId, id) => {
      const slice = get().flowsData[flowId]
      const node = slice?.nodes.find((n) => n.id === id)
      if (!node || node.type !== 'prompt') return
      const original = node.data.prompt.trim()
      if (!original) return

      const apiKey = get().apiKey
      if (!apiKey) {
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === id && n.type === 'prompt'
              ? { ...n, data: { ...n.data, enhanceError: 'Configure sua API key: volte ao início e abra "Configuração".' } }
              : n,
          ),
        }))
        return
      }

      updateFlowSlice(flowId, (s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === id && n.type === 'prompt'
            ? { ...n, data: { ...n.data, enhancing: true, enhanceError: undefined } }
            : n,
        ),
      }))

      try {
        const enhanced = await enhancePromptText({ apiKey, prompt: original })
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === id && n.type === 'prompt'
              ? { ...n, data: { ...n.data, prompt: enhanced, enhancing: false } }
              : n,
          ),
        }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Falha ao melhorar o prompt'
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === id && n.type === 'prompt'
              ? { ...n, data: { ...n.data, enhancing: false, enhanceError: message } }
              : n,
          ),
        }))
      }
    },

    updateImageConfig: (flowId, id, partial) => {
      updateFlowSlice(flowId, (slice) => ({
        ...slice,
        nodes: slice.nodes.map((n) =>
          n.id === id && n.type === 'image' ? { ...n, data: { ...n.data, ...partial } } : n,
        ),
      }))

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

    setApiKey: (key) => {
      saveApiKey(key)
      set({ apiKey: key })
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
      const slice = get().flowsData[flowId]
      const node = slice?.nodes.find((n) => n.id === imageNodeId)
      if (!node || node.type !== 'image') return
      const data = node.data
      const apiKey = get().apiKey

      if (!apiKey) {
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === imageNodeId && n.type === 'image'
              ? {
                  ...n,
                  data: { ...n.data, notice: 'Configure sua API key: volte ao início e abra "Configuração".' },
                }
              : n,
          ),
        }))
        return
      }

      const prompt = getConnectedPrompt(slice.nodes, slice.edges, imageNodeId)
      if (!prompt) {
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === imageNodeId && n.type === 'image'
              ? { ...n, data: { ...n.data, notice: 'Conecte um nó de prompt com texto antes de gerar.' } }
              : n,
          ),
        }))
        return
      }

      const sizeOption = MODEL_SIZES[data.model].find((s) => s.value === data.size)
      const aspect = sizeOption?.aspect ?? 1
      const count = Math.max(1, Math.min(10, data.count))

      const placeholders: ImageSlot[] = Array.from({ length: count }, () => ({
        id: nextId('img'),
        status: 'loading',
        aspect,
      }))

      updateFlowSlice(flowId, (s) => ({
        ...s,
        nodes: s.nodes.map((n) =>
          n.id === imageNodeId && n.type === 'image'
            ? { ...n, data: { ...n.data, images: placeholders, notice: undefined } }
            : n,
        ),
      }))

      try {
        let b64List = await generateImages({
          apiKey,
          model: data.model,
          prompt,
          size: data.size,
          quality: data.quality,
          n: count,
        })

        // tamanhos 9:16/16:9 vêm de um recorte no centro — a API não gera
        // esses dois formatos nativamente
        if (sizeOption?.crop) {
          b64List = await Promise.all(b64List.map((b64) => cropBase64ToAspect(b64, aspect)))
        }

        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) => {
            if (n.id !== imageNodeId || n.type !== 'image') return n
            const images = n.data.images.map((slot, i) =>
              i < b64List.length
                ? { ...slot, status: 'done' as const, b64: b64List[i] }
                : { ...slot, status: 'error' as const, error: 'Sem resposta' },
            )
            return { ...n, data: { ...n.data, images } }
          }),
        }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Falha ao gerar imagens'
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) => {
            if (n.id !== imageNodeId || n.type !== 'image') return n
            const images = n.data.images.map((slot) => ({
              ...slot,
              status: 'error' as const,
              error: message,
            }))
            return { ...n, data: { ...n.data, images, notice: message } }
          }),
        }))
      }
    },

    regenerateSlot: async (flowId, imageNodeId, slotId) => {
      const slice = get().flowsData[flowId]
      const node = slice?.nodes.find((n) => n.id === imageNodeId)
      if (!node || node.type !== 'image') return
      const data = node.data
      const apiKey = get().apiKey

      if (!apiKey) {
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === imageNodeId && n.type === 'image'
              ? {
                  ...n,
                  data: { ...n.data, notice: 'Configure sua API key: volte ao início e abra "Configuração".' },
                }
              : n,
          ),
        }))
        return
      }

      const prompt = getConnectedPrompt(slice.nodes, slice.edges, imageNodeId)
      if (!prompt) {
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) =>
            n.id === imageNodeId && n.type === 'image'
              ? { ...n, data: { ...n.data, notice: 'Conecte um nó de prompt com texto antes de gerar.' } }
              : n,
          ),
        }))
        return
      }

      updateFlowSlice(flowId, (s) => ({
        ...s,
        nodes: s.nodes.map((n) => {
          if (n.id !== imageNodeId || n.type !== 'image') return n
          const images = n.data.images.map((slot) =>
            slot.id === slotId ? { ...slot, status: 'loading' as const, error: undefined } : slot,
          )
          return { ...n, data: { ...n.data, images } }
        }),
      }))

      try {
        const sizeOption = MODEL_SIZES[data.model].find((s) => s.value === data.size)
        let [b64] = await generateImages({
          apiKey,
          model: data.model,
          prompt,
          size: data.size,
          quality: data.quality,
          n: 1,
        })

        if (sizeOption?.crop) {
          b64 = await cropBase64ToAspect(b64, sizeOption.aspect)
        }

        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) => {
            if (n.id !== imageNodeId || n.type !== 'image') return n
            const images = n.data.images.map((slot) =>
              slot.id === slotId ? { ...slot, status: 'done' as const, b64 } : slot,
            )
            return { ...n, data: { ...n.data, images } }
          }),
        }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Falha ao gerar imagem'
        updateFlowSlice(flowId, (s) => ({
          ...s,
          nodes: s.nodes.map((n) => {
            if (n.id !== imageNodeId || n.type !== 'image') return n
            const images = n.data.images.map((slot) =>
              slot.id === slotId ? { ...slot, status: 'error' as const, error: message } : slot,
            )
            return { ...n, data: { ...n.data, images } }
          }),
        }))
      }
    },

    deleteSlot: (flowId, imageNodeId, slotId) => {
      updateFlowSlice(flowId, (slice) => ({
        ...slice,
        nodes: slice.nodes.map((n) => {
          if (n.id !== imageNodeId || n.type !== 'image') return n
          return { ...n, data: { ...n.data, images: n.data.images.filter((s) => s.id !== slotId) } }
        }),
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

function flushDirtyFlows() {
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
