import type { ImageModel } from './models'

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
}

// Orçamento devolvido pelo backend. O id (quoteId) precisa acompanhar as
// chamadas pagas: sem ele o servidor recusa — é a confirmação explícita.
export interface CostQuote {
  quoteId: string
  kind: 'images' | 'enhance'
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
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}
