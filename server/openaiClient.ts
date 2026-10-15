import { buildEnhancerBody, buildOpenAIEditForm, buildOpenAIImageBody } from '../src/generation/openaiRequest'
import type { ImageGenerationRequest } from '../src/generation/types'
import { buildStoryInterpretBody, STORY_MODEL_DEFAULT } from '../src/story/llmRequest'
import { HttpError } from './http'

// Única parte do sistema que fala com a OpenAI. A chave entra aqui só no
// cabeçalho Authorization da chamada à OpenAI — nunca em respostas, erros
// ou logs.

export interface UpstreamImage {
  b64: string
  mimeType: string
}

export interface ImageClient {
  generateImages(request: ImageGenerationRequest): Promise<UpstreamImage[]>
  enhancePrompt(prompt: string): Promise<string>
  // Geração orientada por imagens de referência (POST /v1/images/edits,
  // multipart com as fotos em image[] + input_fidelity quando aplicável)
  editImages(request: ImageGenerationRequest): Promise<UpstreamImage[]>
  // Interpretação de UMA parte da copy de uma historinha. Devolve o JSON
  // cru — quem chama valida antes de usar.
  interpretStory(input: StoryChunkInput): Promise<unknown>
}

export interface StoryChunkInput {
  chunk: string
  part: { index: number; total: number }
  libraryNames: string[]
}

// Remove qualquer coisa parecida com chave de API de um texto vindo de fora
// (a OpenAI, por exemplo, ecoa parte da chave em erros de autenticação).
export function redactSecrets(text: string, secret?: string): string {
  let out = text
  if (secret) out = out.split(secret).join('[chave removida]')
  return out.replace(/sk-[A-Za-z0-9_\-*.]{4,}/g, '[chave removida]')
}

function mimeFromFormat(format: unknown): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

export function createOpenAIClient(options: {
  apiKey: string
  baseUrl: string
  imageTimeoutMs: number
  textTimeoutMs: number
  fetchImpl?: typeof fetch
  storyModel?: string
  storyMaxOutputTokens?: number
  storyTimeoutMs?: number
}): ImageClient {
  const { apiKey, baseUrl } = options

  // body: objeto (enviado como JSON) ou FormData (multipart — o fetch define
  // o Content-Type com o boundary)
  async function call(path: string, body: Record<string, unknown> | FormData, timeoutMs: number): Promise<unknown> {
    const fetchImpl = options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers:
          body instanceof FormData
            ? { Authorization: `Bearer ${apiKey}` }
            : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new HttpError(504, 'upstream_timeout', `A OpenAI não respondeu em ${Math.round(timeoutMs / 1000)} s.`)
      }
      throw new HttpError(502, 'upstream_unreachable', `Não foi possível conectar à OpenAI (${(err as Error).name}).`)
    } finally {
      clearTimeout(timer)
    }

    if (res.ok) {
      try {
        return await res.json()
      } catch {
        throw new HttpError(502, 'upstream_invalid', 'Resposta inválida da OpenAI.')
      }
    }

    let upstreamMessage = ''
    try {
      const data = (await res.json()) as { error?: { message?: unknown } }
      if (typeof data?.error?.message === 'string') upstreamMessage = redactSecrets(data.error.message, apiKey)
    } catch {
      // corpo sem JSON
    }

    if (res.status === 401 || res.status === 403) {
      // nunca repassa a mensagem original: ela costuma conter parte da chave
      throw new HttpError(502, 'upstream_auth', 'A OpenAI recusou a chave do servidor. Verifique OPENAI_API_KEY no arquivo .env.')
    }
    if (res.status === 429) {
      throw new HttpError(429, 'upstream_rate_limited', `Limite ou crédito da OpenAI esgotado. ${upstreamMessage}`.trim(), {
        'Retry-After': res.headers.get('retry-after') ?? '20',
      })
    }
    if (res.status === 400 || res.status === 422) {
      throw new HttpError(422, 'upstream_rejected', upstreamMessage || 'A OpenAI recusou o pedido.')
    }
    throw new HttpError(502, 'upstream_error', `Erro ${res.status} na OpenAI. ${upstreamMessage}`.trim())
  }

  function readImages(raw: unknown): UpstreamImage[] {
    const data = raw as { data?: Array<{ b64_json?: unknown }>; output_format?: unknown }
    const images = (data?.data ?? []).flatMap((d) =>
      typeof d?.b64_json === 'string' && d.b64_json ? [{ b64: d.b64_json, mimeType: mimeFromFormat(data.output_format) }] : [],
    )
    if (images.length === 0) throw new HttpError(502, 'upstream_invalid', 'A OpenAI não devolveu nenhuma imagem.')
    return images
  }

  return {
    async generateImages(request) {
      return readImages(await call('/v1/images/generations', buildOpenAIImageBody(request), options.imageTimeoutMs))
    },

    async editImages(request) {
      return readImages(await call('/v1/images/edits', buildOpenAIEditForm(request), options.imageTimeoutMs))
    },

    async enhancePrompt(prompt) {
      const data = (await call('/v1/chat/completions', buildEnhancerBody(prompt), options.textTimeoutMs)) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) {
        throw new HttpError(502, 'upstream_invalid', 'A OpenAI devolveu um prompt vazio.')
      }
      return text.trim()
    },

    async interpretStory(input) {
      const body = buildStoryInterpretBody({
        model: options.storyModel ?? STORY_MODEL_DEFAULT,
        chunk: input.chunk,
        part: input.part,
        libraryNames: input.libraryNames,
        maxOutputTokens: options.storyMaxOutputTokens ?? 16_000,
      })
      const data = (await call('/v1/chat/completions', body, options.storyTimeoutMs ?? options.textTimeoutMs)) as {
        choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>
      }
      const choice = data?.choices?.[0]
      if (typeof choice?.message?.refusal === 'string' && choice.message.refusal) {
        throw new HttpError(502, 'upstream_refused', 'O modelo se recusou a interpretar este trecho da copy.')
      }
      if (choice?.finish_reason === 'length') {
        throw new HttpError(
          502,
          'upstream_truncated',
          'A resposta do modelo foi cortada por tamanho. Diminua STORY_CHUNK_CHARS ou aumente STORY_MAX_OUTPUT_TOKENS no .env.',
        )
      }
      const text = choice?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(502, 'upstream_invalid', 'O modelo devolveu uma interpretação vazia.')
      try {
        return JSON.parse(text)
      } catch {
        throw new HttpError(502, 'upstream_invalid', 'O modelo devolveu uma interpretação que não é JSON válido.')
      }
    },
  }
}
