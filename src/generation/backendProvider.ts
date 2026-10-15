import {
  ProviderError,
  type BatchImageJob,
  type CallOptions,
  type CostQuote,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageJob,
  type ImageProvider,
} from './types'
import { toDescriptor } from './references'

// Provedor real, via backend próprio (pasta server/). O navegador NUNCA vê a
// chave da API: ele só chama rotas /api/* do servidor local, que guarda a
// chave em variável de ambiente e repassa o pedido pra OpenAI.
//
// Contrato com o backend:
//   POST /api/images/quote     { model, prompt, size, quality?, totalImages,
//                                references?: [{ sha256, mimeType, byteLength, width, height }],
//                                inputFidelity? } → CostQuote
//   POST /api/images/generate  { model, prompt, size, quality?, n,
//                                references?: [{ mimeType, b64 }], inputFidelity? }
//                              + cabeçalho X-Cost-Quote
//     (com references o servidor usa o endpoint de edição da OpenAI, com as fotos)
//     → 200 { images: [{ b64: string, mimeType?: string }] }
//   POST /api/images/batch-quote { model, size, quality?, inputFidelity?,
//                                items: [{ prompt, references?, deferredReferences? }] } → CostQuote
//     (lote do storyboard: cada /images/generate precisa bater com um item)
//   POST /api/prompts/quote    { prompt } → CostQuote
//   POST /api/prompts/enhance  { prompt }  + cabeçalho X-Cost-Quote
//     → 200 { prompt: string }
//   GET  /api/status           → modo, limites e uso do dia (sem a chave)
//   Erros → { error: { message: string, code?: string } } com status 4xx/5xx
//
// O cabeçalho X-Cost-Quote leva o id do orçamento que a pessoa confirmou;
// sem ele o servidor recusa a chamada paga (428).

export const BACKEND_UNAVAILABLE_MESSAGE =
  'Backend local indisponível. Inicie o servidor com "npm run server" (ou "npm run dev:full") ou use o provedor simulado em "Configuração".'

export const QUOTE_HEADER = 'X-Cost-Quote'

export interface BackendProviderOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface BackendStatus {
  mode: 'simulated' | 'openai'
  keyConfigured: boolean
  allowedModels: string[]
  referenceModels?: string[]
  limits: Record<string, number>
  usageToday: { date: string; images: number; estimatedUsd: number; calls: number }
  prices: { referenceDate: string; source: string }
}

async function readError(res: Response, fallback: string): Promise<ProviderError> {
  let message = fallback
  let code: string | undefined
  try {
    const body = await res.json()
    if (typeof body?.error?.message === 'string' && body.error.message) message = body.error.message
    if (typeof body?.error?.code === 'string') code = body.error.code
  } catch {
    // corpo sem JSON
  }
  const retry = Number(res.headers.get('retry-after'))
  return new ProviderError(message, { status: res.status, code, ...(Number.isFinite(retry) && retry > 0 ? { retryAfterMs: retry * 1000 } : {}) })
}

function isQuote(value: unknown): value is CostQuote {
  const q = value as CostQuote
  return !!q && typeof q.quoteId === 'string' && typeof q.estimatedUsd === 'number' && typeof q.paid === 'boolean'
}

export function createBackendProvider(options: BackendProviderOptions = {}): ImageProvider & {
  fetchStatus(): Promise<BackendStatus>
} {
  const baseUrl = options.baseUrl ?? '/api'

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    errorLabel: string,
    quoteId?: string,
  ): Promise<unknown> {
    const fetchImpl = options.fetchImpl ?? fetch
    const headers: Record<string, string> = {}
    if (method === 'POST') headers['Content-Type'] = 'application/json'
    if (quoteId) headers[QUOTE_HEADER] = quoteId

    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new ProviderError(BACKEND_UNAVAILABLE_MESSAGE, { code: 'network_error' })
    }

    // 404/502/503/504 sem mensagem nossa: rota inexistente ou proxy sem servidor por trás
    if ([404, 502, 503, 504].includes(res.status)) throw await readError(res, BACKEND_UNAVAILABLE_MESSAGE)
    if (!res.ok) throw await readError(res, `Erro ${res.status} ${errorLabel}`)

    try {
      return await res.json()
    } catch {
      throw new ProviderError(`Resposta inválida do backend ${errorLabel}`)
    }
  }

  async function quote(path: string, body: unknown, label: string): Promise<CostQuote> {
    const data = await request('POST', path, body, label)
    if (!isQuote(data)) throw new ProviderError(`Resposta inválida do backend ${label}`)
    return data
  }

  return {
    kind: 'backend',
    label: 'OpenAI via backend local (seguro)',

    quoteImages(job: ImageJob) {
      const body = {
        model: job.model,
        prompt: job.prompt,
        size: job.size,
        quality: job.quality,
        totalImages: job.totalImages,
        ...(job.references?.length ? { references: job.references.map(toDescriptor) } : {}),
        ...(job.references?.length && job.inputFidelity ? { inputFidelity: job.inputFidelity } : {}),
      }
      return quote('/images/quote', body, 'ao orçar a geração')
    },

    quoteBatch(job: BatchImageJob) {
      const body = {
        model: job.model,
        size: job.size,
        quality: job.quality,
        ...(job.inputFidelity ? { inputFidelity: job.inputFidelity } : {}),
        items: job.items.map((item) => ({
          prompt: item.prompt,
          ...(item.references?.length ? { references: item.references.map(toDescriptor) } : {}),
          ...(item.deferredReferences ? { deferredReferences: item.deferredReferences } : {}),
        })),
      }
      return quote('/images/batch-quote', body, 'ao orçar o lote')
    },

    quoteEnhance(prompt: string) {
      return quote('/prompts/quote', { prompt }, 'ao orçar o melhorador de prompt')
    },

    async generateImages(req: ImageGenerationRequest, callOptions?: CallOptions): Promise<GeneratedImage[]> {
      // referências vão só com tipo + bytes; o servidor recalcula hash e
      // dimensões a partir dos bytes e confere com o orçamento
      const body = {
        model: req.model,
        prompt: req.prompt,
        size: req.size,
        quality: req.quality,
        n: req.n,
        ...(req.references?.length ? { references: req.references.map((r) => ({ mimeType: r.mimeType, b64: r.b64 })) } : {}),
        ...(req.references?.length && req.inputFidelity ? { inputFidelity: req.inputFidelity } : {}),
        ...(req.references?.length && req.deferredReferences ? { deferredReferences: req.deferredReferences } : {}),
      }
      const data = (await request('POST', '/images/generate', body, 'ao gerar imagens', callOptions?.quoteId)) as {
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

    async enhancePrompt(prompt: string, callOptions?: CallOptions): Promise<string> {
      const data = (await request('POST', '/prompts/enhance', { prompt }, 'ao melhorar o prompt', callOptions?.quoteId)) as {
        prompt?: unknown
      }
      const text = typeof data?.prompt === 'string' ? data.prompt.trim() : ''
      if (!text) throw new ProviderError('A resposta veio vazia ao tentar melhorar o prompt.')
      return text
    },

    async fetchStatus(): Promise<BackendStatus> {
      return (await request('GET', '/status', undefined, 'ao consultar o status')) as BackendStatus
    },
  }
}
