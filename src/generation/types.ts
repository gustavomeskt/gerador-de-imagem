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

export interface ImageProvider {
  readonly kind: ProviderKind
  readonly label: string
  generateImages(request: ImageGenerationRequest): Promise<GeneratedImage[]>
  enhancePrompt(prompt: string): Promise<string>
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}
