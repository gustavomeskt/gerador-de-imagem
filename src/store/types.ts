import type { Edge, Node } from '@xyflow/react'
import type { ImageModel } from '../generation/models'
import type { InputFidelity, ReferenceMimeType, ReferenceRole } from '../generation/references'

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
  // fidelidade às imagens de referência conectadas (só modelos que aceitam)
  inputFidelity?: InputFidelity
  [key: string]: unknown
}

// Uma foto dentro de um nó de Referência.
export interface ReferenceImage {
  id: string
  assetId?: string // arquivo no armazenamento local (pode ser compartilhado entre nós)
  src?: string // URL pra exibir (blob:), ou data URL quando não foi salva
  name: string
  mimeType: ReferenceMimeType
  byteLength: number
  width: number
  height: number
  sha256: string
  missing?: boolean // o arquivo sumiu do armazenamento
  unsaved?: boolean // a gravação local falhou — só existe nesta sessão
}

// Nó de Referência: um "assunto" (uma pessoa, uma roupa, um objeto, um
// estilo) com uma ou mais fotos dele.
export interface ReferenceNodeData {
  label: string
  role: ReferenceRole
  preserveClothing: boolean
  images: ReferenceImage[]
  notice?: string
  [key: string]: unknown
}

export type PromptFlowNode = Node<PromptNodeData, 'prompt'>
export type ImageFlowNode = Node<ImageNodeData, 'image'>
export type ReferenceFlowNode = Node<ReferenceNodeData, 'reference'>
export type FlowNode = PromptFlowNode | ImageFlowNode | ReferenceFlowNode

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
