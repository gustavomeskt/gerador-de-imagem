import type { ImageModel } from './models'
import type { InputFidelity, ReferenceDescriptor, ReferenceImageInput } from './references'

// Contrato que todo provedor de geração implementa. A interface e o store só
// conversam com essa interface — nunca com a API da OpenAI diretamente — pra
// que dê pra trocar entre o provedor simulado (grátis, local) e o backend
// seguro (que guarda a chave no servidor) sem mexer no resto do app.

export type ProviderKind = 'mock' | 'backend'

export interface ImageGenerationRequest {
  model: ImageModel
  prompt: string
  size: string // tamanho no formato da API, ex. "1024x1536"
  quality?: string
  n: number // já respeita o máximo por chamada do modelo
  // com referências a chamada vai pro endpoint de edição (as fotos vão junto)
  references?: ReferenceImageInput[]
  inputFidelity?: InputFidelity
  // lote do storyboard: quantas das ÚLTIMAS referências são imagens de cenas
  // anteriores geradas neste mesmo lote (desconhecidas no orçamento — o
  // orçamento autoriza a quantidade, não o conteúdo delas)
  deferredReferences?: number
}

export interface GeneratedImage {
  // data URL pronta pra <img src> e download (ex. "data:image/png;base64,...")
  src: string
  mimeType: string
}

// Um "trabalho" de geração: tudo o que um nó vai pedir de uma vez (pode virar
// várias chamadas, ex.: dall-e-3 gera 1 por chamada). É o que se orça e
// confirma antes de gastar.
export interface ImageJob {
  model: ImageModel
  prompt: string
  size: string
  quality?: string
  totalImages: number
  // só a identificação das referências (hash, tipo, tamanho, dimensões) —
  // os bytes só vão na chamada de geração
  references?: ReferenceDescriptor[]
  inputFidelity?: InputFidelity
}

// Lote do storyboard: uma imagem por cena, cada uma com o próprio prompt e as
// próprias referências. Orçado de uma vez; cada chamada precisa bater com um
// item do orçamento.
export interface BatchImageItem {
  prompt: string
  references?: ReferenceDescriptor[]
  deferredReferences?: number
}

export interface BatchImageJob {
  model: ImageModel
  size: string
  quality?: string
  inputFidelity?: InputFidelity
  items: BatchImageItem[]
}

// Orçamento devolvido pelo backend. O id (quoteId) precisa acompanhar as
// chamadas pagas: sem ele o servidor recusa — é a confirmação explícita.
export interface CostQuote {
  quoteId: string
  kind: 'images' | 'enhance' | 'story' | 'batch'
  expiresAt: string // ISO
  mode: 'simulated' | 'openai' // simulated = servidor não chama a OpenAI, nada é cobrado
  paid: boolean
  estimatedUsd: number
  images: number
  breakdown: string[] // linhas legíveis explicando a conta
  notes: string[]
}

export interface CallOptions {
  quoteId?: string
}

export interface ImageProvider {
  readonly kind: ProviderKind
  readonly label: string
  generateImages(request: ImageGenerationRequest, options?: CallOptions): Promise<GeneratedImage[]>
  enhancePrompt(prompt: string, options?: CallOptions): Promise<string>
  // Provedores que podem gerar custo pedem um orçamento antes; quem não
  // implementa (o simulado do navegador) é grátis e não pede confirmação.
  quoteImages?(job: ImageJob): Promise<CostQuote>
  quoteEnhance?(prompt: string): Promise<CostQuote>
  quoteBatch?(job: BatchImageJob): Promise<CostQuote>
}

// status/code: o que o backend respondeu (permite decidir se é seguro tentar
// de novo); retryAfterMs: espera pedida pelo servidor (Retry-After).
export class ProviderError extends Error {
  readonly status?: number
  readonly code?: string
  readonly retryAfterMs?: number
  constructor(message: string, details: { status?: number; code?: string; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = details.status
    this.code = details.code
    this.retryAfterMs = details.retryAfterMs
  }
}
