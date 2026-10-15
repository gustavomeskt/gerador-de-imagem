// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { buildOpenAIImageBody, PROMPT_ENHANCER_MAX_OUTPUT_TOKENS } from '../../src/generation/openaiRequest'
import { createDeps } from '../app'
import { loadConfig } from '../config'
import { createOpenAIClient, redactSecrets } from '../openaiClient'
import {
  fakeOpenAI,
  FAKE_KEY,
  imagesResponse,
  jsonResponse,
  quoteAndGenerate,
  startServer,
  VALID_CALL,
  VALID_JOB,
  type TestServer,
} from './helpers'

let t: TestServer | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

async function openaiServer(handler: Parameters<typeof fakeOpenAI>[0], env: Record<string, string> = {}) {
  const openai = fakeOpenAI(handler)
  t = await startServer({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, ...env }, { fetchImpl: openai.fetchImpl })
  return { t, openai }
}

describe('confirmação de custo (orçamento obrigatório)', () => {
  it('orçamento mostra custo estimado e detalhamento', async () => {
    const { t } = await openaiServer(() => imagesResponse(2))
    const res = await t.request('POST', '/api/images/quote', { body: VALID_JOB })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ kind: 'images', mode: 'openai', paid: true, images: 2 })
    expect(res.json.estimatedUsd).toBeCloseTo(0.032, 3) // 2 × 0,016 + texto do prompt
    expect(res.json.breakdown[0]).toMatch(/2 × US\$ 0\.0160/)
    expect(typeof res.json.quoteId).toBe('string')
  })

  it('sem orçamento confirmado não há chamada paga (428)', async () => {
    const { t, openai } = await openaiServer(() => imagesResponse(2))
    const res = await t.request('POST', '/api/images/generate', { body: VALID_CALL })
    expect(res.status).toBe(428)
    expect(res.json.error.code).toBe('confirmation_required')
    expect(openai.calls).toHaveLength(0)
  })

  it('pedido diferente do orçado, orçamento reutilizado ou inventado são recusados', async () => {
    const { t, openai } = await openaiServer(() => imagesResponse(2))
    const quote = await t.request('POST', '/api/images/quote', { body: VALID_JOB })
    const id = quote.json.quoteId

    const other = await t.request('POST', '/api/images/generate', {
      body: { ...VALID_CALL, prompt: 'outro prompt' },
      headers: { 'X-Cost-Quote': id },
    })
    expect(other.status).toBe(409)
    expect(other.json.error.code).toBe('quote_mismatch')

    const pricier = await t.request('POST', '/api/images/generate', {
      body: { ...VALID_CALL, quality: 'high' },
      headers: { 'X-Cost-Quote': id },
    })
    expect(pricier.json.error.code).toBe('quote_mismatch')

    const ok = await t.request('POST', '/api/images/generate', { body: VALID_CALL, headers: { 'X-Cost-Quote': id } })
    expect(ok.status).toBe(200)
    const reused = await t.request('POST', '/api/images/generate', { body: VALID_CALL, headers: { 'X-Cost-Quote': id } })
    expect(reused.status).toBe(409)

    const invented = await t.request('POST', '/api/images/generate', { body: VALID_CALL, headers: { 'X-Cost-Quote': 'inventado' } })
    expect(invented.status).toBe(409)
    expect(openai.calls).toHaveLength(1)
  })

  it('pedir mais imagens do que o orçado é recusado', async () => {
    const { t } = await openaiServer(() => imagesResponse(2))
    const quote = await t.request('POST', '/api/images/quote', { body: { ...VALID_JOB, totalImages: 1 } })
    const res = await t.request('POST', '/api/images/generate', { body: VALID_CALL, headers: { 'X-Cost-Quote': quote.json.quoteId } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('quote_exhausted')
  })

  it('um trabalho de dall-e-3 vira várias chamadas de 1 imagem com o mesmo orçamento', async () => {
    const { t, openai } = await openaiServer(() => imagesResponse(1))
    const job = { model: 'dall-e-3', prompt: 'gato', size: '1024x1024', quality: 'standard', totalImages: 2 }
    const call = { model: 'dall-e-3', prompt: 'gato', size: '1024x1024', quality: 'standard', n: 1 }
    const quote = await t.request('POST', '/api/images/quote', { body: job })
    const headers = { 'X-Cost-Quote': quote.json.quoteId }
    expect((await t.request('POST', '/api/images/generate', { body: call, headers })).status).toBe(200)
    expect((await t.request('POST', '/api/images/generate', { body: call, headers })).status).toBe(200)
    expect((await t.request('POST', '/api/images/generate', { body: call, headers })).status).toBe(409)
    expect(openai.calls).toHaveLength(2)
  })
})

describe('geração com respostas simuladas da OpenAI', () => {
  it('encaminha só o pedido validado e devolve no contrato do frontend', async () => {
    const { t, openai } = await openaiServer(() => imagesResponse(2))
    const { gen } = await quoteAndGenerate(t)
    expect(gen.status).toBe(200)
    expect(gen.json.images).toEqual([
      { b64: Buffer.from('png-0').toString('base64'), mimeType: 'image/png' },
      { b64: Buffer.from('png-1').toString('base64'), mimeType: 'image/png' },
    ])
    expect(openai.calls[0].url).toBe('https://api.openai.com/v1/images/generations')
    expect(openai.calls[0].body).toEqual(buildOpenAIImageBody(VALID_CALL as never))

    const usage = t.deps.ledger.current()
    expect(usage.images).toBe(2)
    expect(usage.estimatedUsd).toBeCloseTo(0.032, 3)
  })

  it('chave recusada pela OpenAI (401): mensagem própria, sem eco da chave, e devolve a reserva', async () => {
    const { t } = await openaiServer(() =>
      jsonResponse(401, { error: { message: `Incorrect API key provided: ${FAKE_KEY.slice(0, 12)}****cdef.` } }),
    )
    const { gen } = await quoteAndGenerate(t)
    expect(gen.status).toBe(502)
    expect(gen.json.error.code).toBe('upstream_auth')
    expect(gen.json.error.message).toMatch(/OPENAI_API_KEY/)
    expect(t.deps.ledger.current().images).toBe(0)
  })

  it('pedido recusado pela OpenAI (400) vira 422 com a mensagem limpa', async () => {
    const { t } = await openaiServer(() =>
      jsonResponse(400, { error: { message: `Your request was rejected by the safety system (key ${FAKE_KEY})` } }),
    )
    const { gen } = await quoteAndGenerate(t)
    expect(gen.status).toBe(422)
    expect(gen.json.error.message).toMatch(/safety system/)
    expect(gen.json.error.message).toContain('[chave removida]')
  })

  it('limite da OpenAI (429) e erro interno da OpenAI (500)', async () => {
    let status = 429
    const { t } = await openaiServer(() => jsonResponse(status, { error: { message: 'Rate limit reached' } }))
    const first = await quoteAndGenerate(t)
    expect(first.gen.status).toBe(429)
    expect(first.gen.json.error.code).toBe('upstream_rate_limited')
    status = 500
    const second = await quoteAndGenerate(t)
    expect(second.gen.status).toBe(502)
    expect(t.deps.ledger.current().images).toBe(0)
  })

  it('OpenAI fora do ar (erro de rede)', async () => {
    const { t } = await openaiServer(() => {
      throw new TypeError('fetch failed')
    })
    const { gen } = await quoteAndGenerate(t)
    expect(gen.status).toBe(502)
    expect(gen.json.error.code).toBe('upstream_unreachable')
  })

  it('timeout: responde 504 e mantém a reserva (a OpenAI pode ter cobrado)', async () => {
    const config = loadConfig({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, SERVER_DATA_DIR: '' })
    const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch
    const client = createOpenAIClient({ apiKey: FAKE_KEY, baseUrl: config.openaiBaseUrl, imageTimeoutMs: 50, textTimeoutMs: 50, fetchImpl: hanging })
    t = await startServer({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY }, { client })
    const { gen } = await quoteAndGenerate(t)
    expect(gen.status).toBe(504)
    expect(gen.json.error.code).toBe('upstream_timeout')
    expect(t.deps.ledger.current().images).toBe(2)
    void createDeps
  })

  it('resposta sem imagens é tratada como erro', async () => {
    const { t } = await openaiServer(() => jsonResponse(200, { data: [] }))
    const { gen } = await quoteAndGenerate(t)
    expect(gen.status).toBe(502)
  })
})

describe('melhorador de prompt', () => {
  it('orçamento + confirmação + chamada com teto de tokens', async () => {
    const { t, openai } = await openaiServer(() =>
      jsonResponse(200, { choices: [{ message: { content: '  prompt detalhado  ' } }] }),
    )
    const noQuote = await t.request('POST', '/api/prompts/enhance', { body: { prompt: 'gato' } })
    expect(noQuote.status).toBe(428)

    const quote = await t.request('POST', '/api/prompts/quote', { body: { prompt: 'gato' } })
    expect(quote.json).toMatchObject({ kind: 'enhance', paid: true, images: 0 })
    expect(quote.json.estimatedUsd).toBeLessThan(0.02)

    const res = await t.request('POST', '/api/prompts/enhance', {
      body: { prompt: 'gato' },
      headers: { 'X-Cost-Quote': quote.json.quoteId },
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ prompt: 'prompt detalhado' })
    expect(openai.calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(openai.calls[0].body.max_completion_tokens).toBe(PROMPT_ENHANCER_MAX_OUTPUT_TOKENS)
  })

  it('orçamento de imagem não serve para o melhorador', async () => {
    const { t } = await openaiServer(() => jsonResponse(200, {}))
    const quote = await t.request('POST', '/api/images/quote', { body: VALID_JOB })
    const res = await t.request('POST', '/api/prompts/enhance', {
      body: { prompt: 'gato' },
      headers: { 'X-Cost-Quote': quote.json.quoteId },
    })
    expect(res.status).toBe(409)
  })
})

describe('redactSecrets', () => {
  it('remove a chave e qualquer coisa com cara de chave', () => {
    expect(redactSecrets(`erro ${FAKE_KEY} fim`, FAKE_KEY)).toBe('erro [chave removida] fim')
    expect(redactSecrets('Incorrect API key provided: sk-proj-abc1****wxyz.')).not.toMatch(/sk-/)
    expect(redactSecrets('mensagem normal')).toBe('mensagem normal')
  })
})
