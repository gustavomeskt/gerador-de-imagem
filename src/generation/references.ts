import { readImageSize, sniffImageType } from '../lib/binary'
import type { ImageModel } from './models'

// Imagens de referência: fotos enviadas pela pessoa que vão JUNTO com o pedido
// pro modelo (endpoint de edição da OpenAI, /v1/images/edits). Este módulo é
// compartilhado entre navegador e servidor: tipos, limites, validação dos
// arquivos e o texto que explica ao modelo o papel de cada imagem.
//
// Conferido no SDK oficial da OpenAI (openai-python, image_edit_params.py,
// out/2026): até 16 imagens png/webp/jpg (< 50 MB cada) por chamada;
// input_fidelity aceita "high" e "low" no gpt-image-1 e no gpt-image-1.5, e
// só "low" no gpt-image-1-mini. DALL-E não aparece como modelo de edição.

export type InputFidelity = 'high' | 'low'

export interface ReferenceSupport {
  maxImages: number // limite da API por chamada
  fidelity: InputFidelity[] // valores aceitos de input_fidelity
}

export const REFERENCE_SUPPORT: Record<ImageModel, ReferenceSupport | null> = {
  'gpt-image-1.5': { maxImages: 16, fidelity: ['high', 'low'] },
  'gpt-image-1': { maxImages: 16, fidelity: ['high', 'low'] },
  'gpt-image-1-mini': { maxImages: 16, fidelity: ['low'] },
  'dall-e-3': null,
  'dall-e-2': null,
}

export function supportsReferences(model: ImageModel): boolean {
  return REFERENCE_SUPPORT[model] !== null
}

// Só envia input_fidelity quando o modelo aceita escolher (o mini só tem
// "low", que já é o padrão da API — então nem manda).
export function effectiveFidelity(model: ImageModel, wanted: InputFidelity | undefined): InputFidelity | undefined {
  const support = REFERENCE_SUPPORT[model]
  if (!support || support.fidelity.length < 2) return undefined
  return wanted && support.fidelity.includes(wanted) ? wanted : 'high'
}

// Limites do app (mais conservadores que os da API). O servidor pode ser
// configurado com outros valores e sempre valida de novo.
export const DEFAULT_MAX_REFERENCES = 6
export const DEFAULT_MAX_REFERENCE_BYTES = 8 * 1024 * 1024
export const REFERENCE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ReferenceMimeType = (typeof REFERENCE_MIME_TYPES)[number]

// Papel de um nó de referência: diz ao modelo o que preservar.
export type ReferenceRole = 'character' | 'clothing' | 'object' | 'style'

export const REFERENCE_ROLE_LABELS: Record<ReferenceRole, string> = {
  character: 'Personagem (rosto e corpo)',
  clothing: 'Roupa / figurino',
  object: 'Cenário ou objeto',
  style: 'Estilo visual',
}

// ordem de envio: personagens primeiro (os modelos dão mais peso às
// primeiras imagens quando a fidelidade é alta)
export const ROLE_ORDER: ReferenceRole[] = ['character', 'clothing', 'object', 'style']

// O que identifica uma referência sem carregar os bytes (vai no orçamento).
export interface ReferenceDescriptor {
  sha256: string
  mimeType: ReferenceMimeType
  byteLength: number
  width: number
  height: number
}

// Referência completa, com os bytes em base64 (vai na chamada de geração).
export interface ReferenceImageInput extends ReferenceDescriptor {
  b64: string
}

export type FileCheck =
  | { ok: true; mimeType: ReferenceMimeType; width: number; height: number }
  | { ok: false; error: string }

// Valida um arquivo pelos bytes reais (assinatura), não pela extensão.
export function checkReferenceFile(bytes: Uint8Array, maxBytes = DEFAULT_MAX_REFERENCE_BYTES): FileCheck {
  if (bytes.byteLength === 0) return { ok: false, error: 'arquivo vazio' }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: `maior que ${Math.round(maxBytes / 1024 / 1024)} MB` }
  }
  const mimeType = sniffImageType(bytes)
  if (!mimeType) return { ok: false, error: 'formato não suportado (use PNG, JPG ou WebP)' }
  const size = readImageSize(bytes, mimeType)
  if (!size || size.width < 1 || size.height < 1) return { ok: false, error: 'não foi possível ler as dimensões da imagem' }
  return { ok: true, mimeType, width: size.width, height: size.height }
}

export interface ReferenceGroup {
  label: string
  role: ReferenceRole
  preserveClothing: boolean
  imageCount: number
}

// O texto que associa cada imagem ao seu papel fica em promptComposer.ts
// (junto com as fichas de personagem e o guia de estilo).
export { buildReferencePrompt } from './promptComposer'

export function toDescriptor(r: ReferenceDescriptor): ReferenceDescriptor {
  return { sha256: r.sha256, mimeType: r.mimeType, byteLength: r.byteLength, width: r.width, height: r.height }
}
