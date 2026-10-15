import { MODEL_MAX_N, MODEL_PROMPT_LIMITS, MODEL_QUALITIES, MODEL_SIZES, type ImageModel } from '../src/generation/models'
import { createHash } from 'node:crypto'
import {
  checkReferenceFile,
  effectiveFidelity,
  REFERENCE_MIME_TYPES,
  REFERENCE_SUPPORT,
  type InputFidelity,
  type ReferenceDescriptor,
  type ReferenceImageInput,
  type ReferenceMimeType,
} from '../src/generation/references'
import type { ImageGenerationRequest, ImageJob } from '../src/generation/types'
import type { ServerConfig } from './config'
import { HttpError } from './http'

// Validação estrita de tudo que chega do navegador. Só passa adiante o que
// está na lista de modelos permitidos e nos tamanhos/qualidades conhecidos;
// campos desconhecidos são recusados (nada arbitrário chega à OpenAI).

// Campos que existirão em etapas futuras. Hoje são recusados com mensagem
// clara, em vez de ignorados em silêncio.
const FUTURE_FIELDS: Record<string, string> = {
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

// --- imagens de referência ------------------------------------------------

function referencesArray(value: unknown, config: ServerConfig, model: ImageModel): unknown[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) invalid('"references" precisa ser uma lista com pelo menos uma imagem.')
  if (!REFERENCE_SUPPORT[model]) {
    throw new HttpError(
      400,
      'references_not_supported',
      `O modelo ${model} não aceita imagens de referência. Use gpt-image-1.5, gpt-image-1 ou gpt-image-1-mini.`,
    )
  }
  const limit = Math.min(config.maxReferenceImages, REFERENCE_SUPPORT[model]!.maxImages)
  if (value.length > limit) invalid(`No máximo ${limit} imagens de referência por geração.`)
  return value
}

function readFidelity(value: unknown, model: ImageModel, hasReferences: boolean): InputFidelity | undefined {
  if (value === undefined || value === null) return undefined
  if (!hasReferences) invalid('"inputFidelity" só pode ser usado com imagens de referência.')
  const support = REFERENCE_SUPPORT[model]
  if (typeof value !== 'string' || !support?.fidelity.includes(value as InputFidelity)) {
    invalid(`"inputFidelity" inválido para ${model}. Aceitos: ${support?.fidelity.join(', ') ?? 'nenhum'}.`)
  }
  // o mini só tem "low" (padrão da API): não precisa mandar
  return effectiveFidelity(model, value as InputFidelity)
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

// Decodifica e confere cada referência pelos BYTES (assinatura do arquivo),
// sem confiar no tipo declarado. Só aceita dados enviados no corpo — nunca
// URLs (o servidor não baixa nada de fora).
function readReferenceImages(list: unknown[], config: ServerConfig): ReferenceImageInput[] {
  return list.map((item, i) => {
    const label = `Referência ${i + 1}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`${label}: formato inválido.`)
    const ref = item as Record<string, unknown>
    for (const key of Object.keys(ref)) {
      if (key !== 'mimeType' && key !== 'b64') invalid(`${label}: campo não permitido "${key}" (envie só mimeType e b64; URLs não são aceitas).`)
    }
    if (typeof ref.b64 !== 'string' || !ref.b64 || !BASE64_RE.test(ref.b64)) invalid(`${label}: dados da imagem ausentes ou fora do formato base64.`)
    if ((ref.b64.length * 3) / 4 > config.maxReferenceBytes + 3) {
      invalid(`${label}: arquivo maior que ${Math.round(config.maxReferenceBytes / 1024 / 1024)} MB.`)
    }
    const bytes = new Uint8Array(Buffer.from(ref.b64, 'base64'))
    const check = checkReferenceFile(bytes, config.maxReferenceBytes)
    if (!check.ok) invalid(`${label}: ${check.error}.`)
    if (ref.mimeType !== check.mimeType) invalid(`${label}: o conteúdo não corresponde ao tipo declarado (${String(ref.mimeType)}).`)
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mimeType: check.mimeType,
      byteLength: bytes.byteLength,
      width: check.width,
      height: check.height,
      b64: ref.b64,
    }
  })
}

function readReferenceDescriptors(list: unknown[], config: ServerConfig): ReferenceDescriptor[] {
  return list.map((item, i) => {
    const label = `Referência ${i + 1}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`${label}: formato inválido.`)
    const ref = item as Record<string, unknown>
    for (const key of Object.keys(ref)) {
      if (!['sha256', 'mimeType', 'byteLength', 'width', 'height'].includes(key)) invalid(`${label}: campo não permitido "${key}".`)
    }
    if (typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256)) invalid(`${label}: sha256 inválido.`)
    if (!REFERENCE_MIME_TYPES.includes(ref.mimeType as ReferenceMimeType)) invalid(`${label}: tipo não suportado (use PNG, JPG ou WebP).`)
    const byteLength = readPositiveInt(ref.byteLength, `${label}.byteLength`, config.maxReferenceBytes)
    const width = readPositiveInt(ref.width, `${label}.width`, 20000)
    const height = readPositiveInt(ref.height, `${label}.height`, 20000)
    return { sha256: ref.sha256 as string, mimeType: ref.mimeType as ReferenceMimeType, byteLength, width, height }
  })
}

// POST /api/images/generate — uma chamada à API (n já respeita o limite do modelo).
// Com "references", vira uma edição com as fotos (endpoint /v1/images/edits).
export function validateGenerateBody(body: unknown, config: ServerConfig): ImageGenerationRequest {
  const obj = asObject(body)
  rejectUnknownFields(obj, ['model', 'prompt', 'size', 'quality', 'n', 'references', 'inputFidelity'])
  const params = readImageParams(obj, config)
  const n = readPositiveInt(obj.n, 'n', Math.min(MODEL_MAX_N[params.model], config.maxImagesPerJob))
  const list = referencesArray(obj.references, config, params.model)
  const references = list ? readReferenceImages(list, config) : undefined
  const inputFidelity = readFidelity(obj.inputFidelity, params.model, !!references)
  return { ...params, n, ...(references ? { references } : {}), ...(inputFidelity ? { inputFidelity } : {}) }
}

// POST /api/images/quote — orçamento de um trabalho inteiro (todas as imagens
// de um nó). As referências vêm só identificadas (hash, tipo, tamanho,
// dimensões); a chamada de geração precisa trazer exatamente esses arquivos.
export function validateImageJob(body: unknown, config: ServerConfig): ImageJob {
  const obj = asObject(body)
  rejectUnknownFields(obj, ['model', 'prompt', 'size', 'quality', 'totalImages', 'references', 'inputFidelity'])
  const params = readImageParams(obj, config)
  const totalImages = readPositiveInt(obj.totalImages, 'totalImages', config.maxImagesPerJob)
  const list = referencesArray(obj.references, config, params.model)
  const references = list ? readReferenceDescriptors(list, config) : undefined
  const inputFidelity = readFidelity(obj.inputFidelity, params.model, !!references)
  return { ...params, totalImages, ...(references ? { references } : {}), ...(inputFidelity ? { inputFidelity } : {}) }
}

// POST /api/prompts/enhance e /api/prompts/quote
export const ENHANCE_MAX_PROMPT_CHARS = 4000

export function validateEnhanceBody(body: unknown): { prompt: string } {
  const obj = asObject(body)
  rejectUnknownFields(obj, ['prompt'])
  return { prompt: readPrompt(obj.prompt, ENHANCE_MAX_PROMPT_CHARS) }
}

// Pedido de interpretação de historinha: só a copy (texto livre) e os nomes
// dos personagens da biblioteca. Nada de URLs, ids ou fotos.
export function validateStoryBody(body: unknown, config: ServerConfig): { copy: string; libraryNames: string[] } {
  const b = asObject(body)
  rejectUnknownFields(b, ['copy', 'libraryNames'])
  if (typeof b.copy !== 'string') invalid('"copy" precisa ser um texto.')
  // a copy é usada exatamente como veio (sem trim): as cenas apontam para
  // posições dentro dela
  const copy = b.copy
  if (!copy.trim()) invalid('"copy" não pode ficar vazia.')
  if (copy.length > config.maxStoryChars) {
    invalid(`A copy passa do limite de ${config.maxStoryChars} caracteres (MAX_STORY_CHARS).`)
  }
  const names = b.libraryNames ?? []
  if (!Array.isArray(names) || names.length > 300) invalid('"libraryNames" precisa ser uma lista de até 300 nomes.')
  const libraryNames = names.map((n) => {
    if (typeof n !== 'string' || !n.trim() || n.length > 80) invalid('Cada nome em "libraryNames" precisa ser um texto de até 80 caracteres.')
    return n.trim()
  })
  return { copy, libraryNames: [...new Set(libraryNames)] }
}
