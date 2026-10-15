import type { Edge, Node } from '@xyflow/react'
import type { ImageModel } from '../generation/models'

export interface PromptNodeData {
  prompt: string
  enhancing?: boolean
  enhanceError?: string
  [key: string]: unknown
}

export interface ImageSlot {
  id: string
  status: 'loading' | 'done' | 'error'
  src?: string // URL pra exibir (blob: da imagem salva, ou data URL se não foi salva)
  mimeType?: string
  assetId?: string // id do arquivo no armazenamento local (IndexedDB)
  unsaved?: boolean // gerada, mas a gravação local falhou — só existe nesta sessão
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
  createdAt: number
  updatedAt: number
}

export interface FlowSlice {
  nodes: FlowNode[]
  edges: Edge[]
}
