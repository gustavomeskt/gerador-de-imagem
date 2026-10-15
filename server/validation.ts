import { MODEL_MAX_N, MODEL_PROMPT_LIMITS, MODEL_QUALITIES, MODEL_SIZES, type ImageModel } from '../src/generation/models'
import type { ImageGenerationRequest, ImageJob } from '../src/generation/types'
import type { ServerConfig } from './config'
import { HttpError } from './http'

// Validação estrita de tudo que chega do navegador. Só passa adiante o que
// está na lista de modelos permitidos e nos tamanhos/qualidades conhecidos;
// campos desconhecidos são recusados (nada arbitrário chega à OpenAI).

// Campos que existirão em etapas futuras. Hoje são recusados com mensagem
// clara, em vez de ignorados em silêncio.
const FUTURE_FIELDS: Record<string, string> = {
  references: 'imagens de referência',
  referenceImages: 'imagens de referência',
  characters: 'personagens',
  scenes: 'geração de cenas',
  mask: 'máscara de edição',
}

function invalid(message: string): never {
  throw new HttpError(400, 'invalid_request', message)
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('O corpo precisa ser um objeto JSON.')
  return body as Record<string, unknown>
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue
    if (key in FUTURE_FIELDS) {
      throw new HttpError(400, 'not_supported_yet', `"${key}" (${FUTURE_FIELDS[key]}) ainda não é suportado por este servidor.`)
    }
    invalid(`Campo não permitido: "${key}".`)
  }
}

function readPrompt(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') invalid('"prompt" precisa ser um texto.')
  const prompt = value.trim()
  if (!prompt) invalid('"prompt" não pode ficar vazio.')
  if (prompt.length > maxChars) invalid(`"prompt" passa do limite de ${maxChars} caracteres.`)
  return prompt
}

interface ImageParams {
  model: ImageModel
  prompt: string
  size: string
  quality?: string
}

function readImageParams(body: Record<string, unknown>, config: ServerConfig): ImageParams {
  const model = body.model
  if (typeof model !== 'string' || !(config.allowedModels as string[]).includes(model)) {
    invalid(`Modelo não permitido. Use um destes: ${config.allowedModels.join(', ')}.`)
  }
  const m = model as ImageModel

  const prompt = readPrompt(body.prompt, MODEL_PROMPT_LIMITS[m])

  if (typeof body.size !== 'string' || !MODEL_SIZES[m].some((s) => s.value === body.size)) {
    invalid(`Tamanho inválido para ${m}. Use: ${MODEL_SIZES[m].map((s) => s.value).join(', ')}.`)
  }

  let quality: string | undefined
  if (body.quality !== undefined && body.quality !== null) {
    const qualities = MODEL_QUALITIES[m]
    if (!qualities) invalid(`${m} não aceita o parâmetro "quality".`)
    if (typeof body.quality !== 'string' || !qualities.some((q) => q.value === body.quality)) {
      invalid(`Qualidade inválida para ${m}. Use: ${qualities.map((q) => q.value).join(', ')}.`)
    }
    quality = body.quality
  }

  return { model: m, prompt, size: body.size as string, quality }
}

function readPositiveInt(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) invalid(`"${name}" precisa ser um inteiro maior que zero.`)
  if (value > max) invalid(`"${name}" passa do máximo permitido (${max}).`)
  return value
}

// POST /api/images/generate — uma chamada à API (n já respeita o limite do modelo)
export function validateGenerateBody(body: unknown, config: ServerConfig): ImageGenerationRequest {
  const obj = asObject(body)
  rejectUnknownFields(obj, ['model', 'prompt', 'size', 'quality', 'n'])
  const params = readImageParams(obj, config)
  const n = readPositiveInt(obj.n, 'n', Math.min(MODEL_MAX_N[params.model], config.maxImagesPerJob))
  return { ...params, n }
}

// POST /api/images/quote — orçamento de um trabalho inteiro (todas as imagens de um nó)
export function validateImageJob(body: unknown, config: ServerConfig): ImageJob {
  const obj = asObject(body)
  rejectUnknownFields(obj, ['model', 'prompt', 'size', 'quality', 'totalImages'])
  const params = readImageParams(obj, config)
  const totalImages = readPositiveInt(obj.totalImages, 'totalImages', config.maxImagesPerJob)
  return { ...params, totalImages }
}

// POST /api/prompts/enhance e /api/prompts/quote
export const ENHANCE_MAX_PROMPT_CHARS = 4000

export function validateEnhanceBody(body: unknown): { prompt: string } {
  const obj = asObject(body)
  rejectUnknownFields(obj, ['prompt'])
  return { prompt: readPrompt(obj.prompt, ENHANCE_MAX_PROMPT_CHARS) }
}
