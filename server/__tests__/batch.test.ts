// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../../src/lib/binary'
import { jpegBytes, pngBytes } from '../../src/test/fixtures'
import { fakeOpenAI, FAKE_KEY, imagesResponse, jsonResponse, startServer, type FakeCall, type TestServer } from './helpers'

let t: TestServer | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

const MARIA = pngBytes(400, 600, 1)
const JOAO = jpegBytes(400, 600, 2)
const PREVIOUS = pngBytes(512, 768, 3) // imagem de uma cena anterior do lote
const desc = (bytes: Uint8Array, mimeType: string, width: number, height: number) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mimeType,
  byteLength: bytes.byteLength,
  width,
  height,
})
const up = (bytes: Uint8Array, mimeType: string) => ({ mimeType, b64: bytesToBase64(bytes) })
const D_MARIA = desc(MARIA, 'image/png', 400, 600)
const D_JOAO = desc(JOAO, 'image/jpeg', 400, 600)

const BASE = { model: 'gpt-image-1.5', size: '1024x1536', quality: 'low', inputFidelity: 'high' }
const ITEMS = [
  { prompt: 'Cena 1: Dona Maria prepara o café.', references: [D_MARIA] },
  { prompt: 'Cena 2: Seu João entra na cozinha.', references: [D_JOAO] },
  { prompt: 'Cena 3: os dois tomam café juntos.', references: [D_MARIA, D_JOAO], deferredReferences: 1 },
]
const call = (prompt: string, references: Array<{ mimeType: string; b64: string }>, extra: object = {}) => ({
  model: BASE.model,
  size: BASE.size,
  quality: BASE.quality,
  inputFidelity: 'high',
  prompt,
  n: 1,
  references,
  ...extra,
})
const CALLS = [
  call(ITEMS[0].prompt, [up(MARIA, 'image/png')]),
  call(ITEMS[1].prompt, [up(JOAO, 'image/jpeg')]),
  call(ITEMS[2].prompt, [up(MARIA, 'image/png'), up(JOAO, 'image/jpeg'), up(PREVIOUS, 'image/png')], { deferredReferences: 1 }),
]

async function openaiServer(handler: (c: FakeCall) => Response = () => imagesResponse(1), env: Record<string, string> = {}) {
  const openai = fakeOpenAI(handler)
  t = await startServer({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, ...env }, { fetchImpl: openai.fetchImpl })
  return { t, openai }
}

const gen = (server: TestServer, body: object, quoteId?: string) =>
  server.request('POST', '/api/images/generate', { body, headers: quoteId ? { 'X-Cost-Quote': quoteId } : {} })

describe('lote do storyboard: orçamento e autorização por cena', () => {
  it('orça o lote inteiro (uma imagem por cena) e autoriza exatamente cada cena uma vez', async () => {
    const { t, openai } = await openaiServer()
    const quote = await t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })
    expect(quote.status).toBe(200)
    expect(quote.json).toMatchObject({ kind: 'batch', images: 3, paid: true, mode: 'openai' })
    expect(quote.json.breakdown[0]).toMatch(/3 imagem\(ns\), uma por cena/)
    expect(quote.json.breakdown[2]).toMatch(/1 delas de cenas anteriores/)
    const id = quote.json.quoteId

    for (const body of CALLS) expect((await gen(t, body, id)).status).toBe(200)
    expect(openai.calls).toHaveLength(3)
    // cada chamada levou o prompt da própria cena
    expect(openai.calls.map((c) => (c.init.body as FormData).get('prompt'))).toEqual(ITEMS.map((i) => i.prompt))
    expect((openai.calls[2].init.body as FormData).getAll('image[]')).toHaveLength(3)

    // a mesma cena de novo: já usada
    const again = await gen(t, CALLS[0], id)
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('quote_exhausted')
  })

  it('mudar cena, modelo, qualidade ou referências invalida a autorização', async () => {
    const { t, openai } = await openaiServer()
    const id = (await t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })).json.quoteId
    const variants = [
      { ...CALLS[0], prompt: 'Cena 1: Dona Maria prepara o café e dança.' },
      { ...CALLS[0], quality: 'high' },
      { ...CALLS[0], model: 'gpt-image-1' },
      { ...CALLS[0], references: [up(JOAO, 'image/jpeg')] },
      { ...CALLS[0], inputFidelity: 'low' },
      { ...CALLS[0], n: 2 },
      // cena 3 sem dizer que a última referência é de cena anterior
      { ...CALLS[2], deferredReferences: undefined },
    ]
    for (const v of variants) {
      const res = await gen(t, v, id)
      expect(res.status, JSON.stringify(v).slice(0, 80)).toBe(409)
    }
    expect(openai.calls).toHaveLength(0)
    // sem orçamento nenhum: 428
    expect((await gen(t, CALLS[0])).status).toBe(428)
  })

  it('recusa da OpenAI (nada cobrado) devolve a cena ao lote; timeout não devolve', async () => {
    let n = 0
    const { t } = await openaiServer(() => {
      n += 1
      if (n === 1) return jsonResponse(429, { error: { message: 'Rate limit' } })
      return imagesResponse(1)
    })
    const id = (await t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })).json.quoteId
    const first = await gen(t, CALLS[0], id)
    expect(first.status).toBe(429)
    expect(first.headers['retry-after']).toBeTruthy()
    expect((await gen(t, CALLS[0], id)).status).toBe(200)

    await t.close()
    const slow = await openaiServer(
      // "OpenAI" que nunca responde (só desiste quando o servidor aborta)
      (c) =>
        new Promise<Response>((_, reject) =>
          c.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ) as unknown as Response,
      { OPENAI_IMAGE_TIMEOUT_MS: '1000' },
    )
    const id2 = (await slow.t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })).json.quoteId
    const timeout = await gen(slow.t, CALLS[1], id2)
    expect(timeout.status).toBe(504)
    const retry = await gen(slow.t, CALLS[1], id2)
    expect(retry.status).toBe(409)
    expect(retry.json.error.code).toBe('quote_exhausted')
  })

  it('limites do lote: quantidade, custo total e custo por cena', async () => {
    const { t, openai } = await openaiServer(undefined, { MAX_IMAGES_PER_BATCH: '2' })
    const tooMany = await t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })
    expect(tooMany.status).toBe(400)
    expect(tooMany.json.error.message).toMatch(/limite de 2 imagens/)
    await t.close()

    const cheap = await openaiServer(undefined, { MAX_COST_PER_BATCH_USD: '0.01' })
    const pricey = await cheap.t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })
    expect(pricey.status).toBe(422)
    expect(pricey.json.error.code).toBe('batch_too_expensive')
    await cheap.t.close()

    const perScene = await openaiServer(undefined, { MAX_COST_PER_JOB_USD: '0.001' })
    const res = await perScene.t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('job_too_expensive')
    expect(openai.calls).toHaveLength(0)
  })

  it('valida itens: campos estranhos, URLs, referências demais e cena anterior sem fotos', async () => {
    t = await startServer()
    const bad: Array<[object, RegExp]> = [
      [{ ...BASE, items: [] }, /pelo menos uma cena/],
      [{ ...BASE, items: [{ prompt: 'x', url: 'http://exemplo.com/a.png' }] }, /campo não permitido "url"/],
      [{ ...BASE, items: [{ prompt: 'x', references: [D_MARIA], deferredReferences: 6 }] }, /no máximo 6/],
      [{ ...BASE, items: [{ prompt: 'x', deferredReferences: 1 }] }, /exigem as fotos dos personagens/],
      [{ ...BASE, model: 'dall-e-3', size: '1024x1792', quality: 'standard', inputFidelity: undefined, items: [{ prompt: 'x', references: [D_MARIA] }] }, /não aceita imagens de referência/],
    ]
    for (const [body, message] of bad) {
      const res = await t.request('POST', '/api/images/batch-quote', { body })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.json.error.message).toMatch(message)
    }
  })

  it('modo simulado: mesmo caminho, sem cobrança, e a imagem mostra as referências recebidas', async () => {
    t = await startServer()
    const quote = await t.request('POST', '/api/images/batch-quote', { body: { ...BASE, items: ITEMS } })
    expect(quote.json).toMatchObject({ kind: 'batch', paid: false, mode: 'simulated' })
    const res = await gen(t, CALLS[2], quote.json.quoteId)
    expect(res.status).toBe(200)
    const svg = Buffer.from(res.json.images[0].b64, 'base64').toString('utf8')
    expect(svg).toContain('3 referência(s)')
  })

  it('gpt-image-2: 9:16 nativo (1152x2048) aceito; input_fidelity recusado (o SDK manda omitir); preço marcado como não confirmado', async () => {
    const { t, openai } = await openaiServer()
    const items = [{ prompt: 'Cena 1', references: [D_MARIA] }]
    const bad = await t.request('POST', '/api/images/batch-quote', { body: { model: 'gpt-image-2', size: '1152x2048', quality: 'medium', inputFidelity: 'high', items } })
    expect(bad.status).toBe(400)
    const q = await t.request('POST', '/api/images/batch-quote', { body: { model: 'gpt-image-2', size: '1152x2048', quality: 'medium', items } })
    expect(q.status).toBe(200)
    expect(q.json.notes.join(' ')).toMatch(/gpt-image-2: preço NÃO confirmado/)
    const odd = await t.request('POST', '/api/images/batch-quote', { body: { model: 'gpt-image-2', size: '1080x1920', quality: 'medium', items } })
    expect(odd.status).toBe(400) // 1080 não é múltiplo de 16
    const gen = await gen2(t, q.json.quoteId)
    expect(gen.status).toBe(200)
    const form = openai.calls[0].init.body as FormData
    expect(form.get('size')).toBe('1152x2048')
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('input_fidelity')).toBeNull()
  })
})

const gen2 = (server: TestServer, quoteId: string) =>
  server.request('POST', '/api/images/generate', {
    body: { model: 'gpt-image-2', size: '1152x2048', quality: 'medium', prompt: 'Cena 1', n: 1, references: [up(MARIA, 'image/png')] },
    headers: { 'X-Cost-Quote': quoteId },
  })
