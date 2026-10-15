import { isGptImageModel } from './models'
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

// Modelo de texto usado só pra reescrever/detalhar o prompt antes de gerar a
// imagem — imita o que o ChatGPT faz por trás dos panos.
export const PROMPT_ENHANCER_MODEL = 'gpt-5-mini'

export const PROMPT_ENHANCER_SYSTEM = `Você reescreve prompts curtos de geração de imagem em prompts detalhados e fotográficos, no mesmo estilo que o ChatGPT usa internamente antes de gerar uma imagem. Adicione especificações de iluminação, ângulo de câmera, composição, textura de material/pele, humor e estilo fotográfico, mantendo fielmente a ideia original do usuário — não troque o assunto nem invente elementos que mudem o pedido. Responda só com o prompt reescrito, em inglês, sem aspas, sem explicações, sem prefixos como "Prompt:".`

export function buildEnhancerBody(prompt: string): Record<string, unknown> {
  return {
    model: PROMPT_ENHANCER_MODEL,
    messages: [
      { role: 'system', content: PROMPT_ENHANCER_SYSTEM },
      { role: 'user', content: prompt },
    ],
  }
}
