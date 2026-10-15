// Catálogo de modelos de imagem: o que a interface mostra (modelo, proporção,
// qualidade) e os limites que a camada de geração respeita (quantas imagens
// por chamada). Não depende de nenhum provedor — vale pro simulado e pro real.

export type ImageModel = 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini' | 'dall-e-3' | 'dall-e-2'

export const MODEL_LABELS: Record<ImageModel, string> = {
  'gpt-image-1.5': 'GPT Image 1.5 (recomendado)',
  'gpt-image-1': 'GPT Image 1',
  'gpt-image-1-mini': 'GPT Image 1 Mini (rápido e barato)',
  'dall-e-3': 'DALL-E 3',
  'dall-e-2': 'DALL-E 2',
}

export interface SizeOption {
  value: string // tamanho enviado pra API, ex. "1024x1536"
  label: string
  aspect: number // proporção final (largura / altura) mostrada/baixada
  crop?: boolean // se true, a API não gera nesse formato exato — recortamos no centro depois
}

export interface QualityOption {
  value: string
  label: string
}

// gpt-image-1, 1.5 e mini têm a mesma grade de tamanhos/qualidade.
const GPT_IMAGE_SIZES: SizeOption[] = [
  { value: '1024x1024', label: 'Quadrada (1:1)', aspect: 1 },
  { value: '1024x1536', label: 'Vertical (9:16)', aspect: 9 / 16, crop: true },
  { value: '1536x1024', label: 'Horizontal (16:9)', aspect: 16 / 9, crop: true },
]

const GPT_IMAGE_QUALITIES: QualityOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Baixa' },
  { value: 'medium', label: 'Média' },
  { value: 'high', label: 'Alta' },
]

export const MODEL_SIZES: Record<ImageModel, SizeOption[]> = {
  'gpt-image-1.5': GPT_IMAGE_SIZES,
  'gpt-image-1': GPT_IMAGE_SIZES,
  'gpt-image-1-mini': GPT_IMAGE_SIZES,
  'dall-e-3': [
    { value: '1024x1024', label: 'Quadrada (1:1)', aspect: 1 },
    { value: '1024x1792', label: 'Vertical (9:16)', aspect: 9 / 16, crop: true },
    { value: '1792x1024', label: 'Horizontal (16:9)', aspect: 16 / 9, crop: true },
  ],
  'dall-e-2': [
    { value: '256x256', label: 'Quadrada pequena', aspect: 1 },
    { value: '512x512', label: 'Quadrada média', aspect: 1 },
    { value: '1024x1024', label: 'Quadrada grande', aspect: 1 },
  ],
}

export const MODEL_QUALITIES: Record<ImageModel, QualityOption[] | null> = {
  'gpt-image-1.5': GPT_IMAGE_QUALITIES,
  'gpt-image-1': GPT_IMAGE_QUALITIES,
  'gpt-image-1-mini': GPT_IMAGE_QUALITIES,
  'dall-e-3': [
    { value: 'standard', label: 'Padrão' },
    { value: 'hd', label: 'HD' },
  ],
  'dall-e-2': null,
}

// Quantas imagens cada modelo aceita gerar numa única chamada da API.
export const MODEL_MAX_N: Record<ImageModel, number> = {
  'gpt-image-1.5': 10,
  'gpt-image-1': 10,
  'gpt-image-1-mini': 10,
  'dall-e-2': 10,
  'dall-e-3': 1,
}

// Tamanho máximo do prompt aceito por cada modelo (caracteres), conforme a
// documentação da API. O backend recusa prompts maiores antes de chamar a API.
export const MODEL_PROMPT_LIMITS: Record<ImageModel, number> = {
  'gpt-image-1.5': 32000,
  'gpt-image-1': 32000,
  'gpt-image-1-mini': 32000,
  'dall-e-3': 4000,
  'dall-e-2': 1000,
}

// Limite de imagens por nó (o campo "Qtd." da interface).
export const MAX_IMAGES_PER_NODE = 10

export const DEFAULT_MODEL: ImageModel = 'gpt-image-1.5'

export function isImageModel(value: unknown): value is ImageModel {
  return typeof value === 'string' && value in MODEL_LABELS
}

export function isGptImageModel(model: ImageModel) {
  return model.startsWith('gpt-image')
}

export function getSizeOption(model: ImageModel, size: string): SizeOption | undefined {
  return MODEL_SIZES[model].find((s) => s.value === size)
}

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 1
  return Math.max(1, Math.min(MAX_IMAGES_PER_NODE, Math.floor(count)))
}

// Divide um pedido de N imagens em chamadas que respeitam o máximo por
// chamada do modelo (ex.: dall-e-3 só aceita 1 por vez).
export function splitIntoBatches(total: number, maxPerCall: number): number[] {
  const batches: number[] = []
  let remaining = Math.max(0, Math.floor(total))
  const max = Math.max(1, Math.floor(maxPerCall))
  while (remaining > 0) {
    const batch = Math.min(remaining, max)
    batches.push(batch)
    remaining -= batch
  }
  return batches
}
