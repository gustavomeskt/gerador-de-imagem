import { isGptImageModel } from './models'
import { base64ToBytes, extensionFor } from '../lib/binary'
import type { ImageGenerationRequest } from './types'

// Regras de montagem dos pedidos pra API da OpenAI, preservadas do cliente
// original. Este módulo NÃO faz chamada nenhuma e não conhece chave de API:
// é lógica pura, pra ser usada pelo backend seguro (etapa seguinte) e testada
// isoladamente.

export function buildOpenAIImageBody(request: ImageGenerationRequest): Record<string, unknown> {
  const { model, prompt, size, quality, n } = request
  const body: Record<string, unknown> = { model, prompt, size, n }

  if (isGptImageModel(model)) {
    if (quality) body.quality = quality
  } else {
    // dall-e-2 / dall-e-3: pedimos base64 direto, sem depender de URL temporária
    body.response_format = 'b64_json'
    if (model === 'dall-e-3' && quality) body.quality = quality
  }

  return body
}

// Edição com imagens de referência (POST /v1/images/edits, multipart): cada
// foto vai como um arquivo no campo "image[]", na mesma ordem das
// referências. input_fidelity só é enviado quando o modelo aceita escolher.
export function buildOpenAIEditForm(request: ImageGenerationRequest): FormData {
  const refs = request.references ?? []
  if (refs.length === 0) throw new Error('Edição sem imagens de referência.')
  const form = new FormData()
  form.append('model', request.model)
  form.append('prompt', request.prompt)
  form.append('n', String(request.n))
  form.append('size', request.size)
  if (request.quality) form.append('quality', request.quality)
  if (request.inputFidelity) form.append('input_fidelity', request.inputFidelity)
  refs.forEach((ref, i) => {
    const bytes = base64ToBytes(ref.b64)
    form.append('image[]', new Blob([bytes as BlobPart], { type: ref.mimeType }), `referencia-${i + 1}.${extensionFor(ref.mimeType)}`)
  })
  return form
}

// Modelo de texto usado só pra reescrever/detalhar o prompt antes de gerar a
// imagem — imita o que o ChatGPT faz por trás dos panos.
export const PROMPT_ENHANCER_MODEL = 'gpt-5-mini'

export const PROMPT_ENHANCER_SYSTEM = `Você reescreve prompts curtos de geração de imagem em prompts detalhados e fotográficos, no mesmo estilo que o ChatGPT usa internamente antes de gerar uma imagem. Adicione especificações de iluminação, ângulo de câmera, composição, textura de material/pele, humor e estilo fotográfico, mantendo fielmente a ideia original do usuário — não troque o assunto nem invente elementos que mudem o pedido. Responda só com o prompt reescrito, em inglês, sem aspas, sem explicações, sem prefixos como "Prompt:".`

// Teto de tokens de saída do melhorador (inclui raciocínio do modelo). Limita
// o custo máximo de cada chamada.
export const PROMPT_ENHANCER_MAX_OUTPUT_TOKENS = 4000

export function buildEnhancerBody(prompt: string): Record<string, unknown> {
  return {
    model: PROMPT_ENHANCER_MODEL,
    max_completion_tokens: PROMPT_ENHANCER_MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: PROMPT_ENHANCER_SYSTEM },
      { role: 'user', content: prompt },
    ],
  }
}
