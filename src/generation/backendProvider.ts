import { ProviderError, type GeneratedImage, type ImageGenerationRequest, type ImageProvider } from './types'

// Provedor real, via backend próprio. O navegador NUNCA vê a chave da API:
// ele só chama rotas /api/* do nosso servidor, que guarda a chave em variável
// de ambiente e repassa o pedido pra OpenAI.
//
// Contrato esperado do backend (será implementado numa etapa seguinte):
//   POST /api/images/generate  { model, prompt, size, quality?, n }
//     → 200 { images: [{ b64: string, mimeType?: string }] }
//   POST /api/prompts/enhance  { prompt }
//     → 200 { prompt: string }
//   Erros → { error: { message: string } } com status 4xx/5xx

export const BACKEND_UNAVAILABLE_MESSAGE =
  'Backend seguro indisponível. Inicie o servidor da API ou use o provedor simulado em "Configuração".'

export interface BackendProviderOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    const message = body?.error?.message
    return typeof message === 'string' && message ? message : fallback
  } catch {
    return fallback
  }
}

export function createBackendProvider(options: BackendProviderOptions = {}): ImageProvider {
  const baseUrl = options.baseUrl ?? '/api'

  async function post(path: string, body: unknown, errorLabel: string): Promise<unknown> {
    const fetchImpl = options.fetchImpl ?? fetch
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new ProviderError(BACKEND_UNAVAILABLE_MESSAGE)
    }

    // 404/502/503/504: rota inexistente ou proxy sem servidor por trás
    if ([404, 502, 503, 504].includes(res.status)) {
      throw new ProviderError(await readErrorMessage(res, BACKEND_UNAVAILABLE_MESSAGE))
    }
    if (!res.ok) {
      throw new ProviderError(await readErrorMessage(res, `Erro ${res.status} ${errorLabel}`))
    }

    try {
      return await res.json()
    } catch {
      throw new ProviderError(`Resposta inválida do backend ${errorLabel}`)
    }
  }

  return {
    kind: 'backend',
    label: 'OpenAI via backend seguro',

    async generateImages(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
      const data = (await post('/images/generate', request, 'ao gerar imagens')) as {
        images?: Array<{ b64?: unknown; mimeType?: unknown }>
      }
      if (!Array.isArray(data?.images)) {
        throw new ProviderError('Resposta inválida do backend ao gerar imagens')
      }
      return data.images
        .filter((img): img is { b64: string; mimeType?: unknown } => typeof img?.b64 === 'string' && !!img.b64)
        .map((img) => {
          const mimeType = typeof img.mimeType === 'string' ? img.mimeType : 'image/png'
          return { src: `data:${mimeType};base64,${img.b64}`, mimeType }
        })
    },

    async enhancePrompt(prompt: string): Promise<string> {
      const data = (await post('/prompts/enhance', { prompt }, 'ao melhorar o prompt')) as { prompt?: unknown }
      const text = typeof data?.prompt === 'string' ? data.prompt.trim() : ''
      if (!text) throw new ProviderError('A resposta veio vazia ao tentar melhorar o prompt.')
      return text
    },
  }
}
