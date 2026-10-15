// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../../src/lib/binary'
import { jpegBytes, pngBytes, webpBytes } from '../../src/test/fixtures'
import { fakeOpenAI, FAKE_KEY, imagesResponse, startServer, type TestServer } from './helpers'

let t: TestServer | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

const PHOTO_A = pngBytes(800, 1200, 11)
const PHOTO_B = jpegBytes(864, 1536, 22)

function descriptor(bytes: Uint8Array, mimeType: string, width: number, height: number) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), mimeType, byteLength: bytes.byteLength, width, height }
}
const DESC_A = descriptor(PHOTO_A, 'image/png', 800, 1200)
const DESC_B = descriptor(PHOTO_B, 'image/jpeg', 864, 1536)
const UPLOAD_A = { mimeType: 'image/png', b64: bytesToBase64(PHOTO_A) }
const UPLOAD_B = { mimeType: 'image/jpeg', b64: bytesToBase64(PHOTO_B) }

const BASE = { model: 'gpt-image-1.5', prompt: 'Maria na cozinha', size: '1024x1536', quality: 'low' }
const JOB = { ...BASE, totalImages: 2, references: [DESC_A, DESC_B], inputFidelity: 'high' }
const CALL = { ...BASE, n: 2, references: [UPLOAD_A, UPLOAD_B], inputFidelity: 'high' }

async function openaiServer(env: Record<string, string> = {}) {
  const openai = fakeOpenAI(() => imagesResponse(2))
  const logs: string[] = []
  t = await startServer(
    { IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, ...env },
    { fetchImpl: openai.fetchImpl, log: (line) => logs.push(line) },
  )
  return { t, openai, logs }
}

async function quoteThenGenerate(t: TestServer, job: object = JOB, call: object = CALL) {
  const quote = await t.request('POST', '/api/images/quote', { body: job })
  const gen = await t.request('POST', '/api/images/generate', { body: call, headers: { 'X-Cost-Quote': quote.json?.quoteId ?? '' } })
  return { quote, gen }
}

describe('geração com imagens de referência (OpenAI simulada)', () => {
  it('usa o endpoint de edição e os bytes de cada foto chegam intactos, na ordem', async () => {
    const { t, openai } = await openaiServer()
    const { quote, gen } = await quoteThenGenerate(t)
    expect(quote.status).toBe(200)
    expect(gen.status, JSON.stringify(gen.json)).toBe(200)
    expect(gen.json.images).toHaveLength(2)

    expect(openai.calls).toHaveLength(1)
    const call = openai.calls[0]
    expect(call.url).toBe('https://api.openai.com/v1/images/edits')
    const form = call.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('gpt-image-1.5')
    expect(form.get('input_fidelity')).toBe('high')
    expect(form.get('n')).toBe('2')
    const files = form.getAll('image[]') as File[]
    expect(files).toHaveLength(2)
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(PHOTO_A)
    expect(new Uint8Array(await files[1].arrayBuffer())).toEqual(PHOTO_B)
    // multipart: o Content-Type (com boundary) fica por conta do fetch
    expect(new Headers(call.init.headers).has('Content-Type')).toBe(false)
    expect(new Headers(call.init.headers).get('Authorization')).toBe(`Bearer ${FAKE_KEY}`)
  })

  it('o orçamento soma o custo das referências (fidelidade alta custa mais)', async () => {
    const { t } = await openaiServer()
    const plain = await t.request('POST', '/api/images/quote', { body: { ...BASE, totalImages: 2 } })
    const high = await t.request('POST', '/api/images/quote', { body: JOB })
    const low = await t.request('POST', '/api/images/quote', { body: { ...JOB, inputFidelity: 'low' } })
    expect(high.json.estimatedUsd).toBeGreaterThan(low.json.estimatedUsd)
    expect(low.json.estimatedUsd).toBeGreaterThan(plain.json.estimatedUsd)
    expect(high.json.breakdown.join(' ')).toMatch(/2 referência\(s\).*fidelidade alta/)
  })

  it('sem orçamento confirmado não há edição paga (428)', async () => {
    const { t, openai } = await openaiServer()
    const res = await t.request('POST', '/api/images/generate', { body: CALL })
    expect(res.status).toBe(428)
    expect(openai.calls).toHaveLength(0)
  })

  it('trocar a foto, a ordem ou a fidelidade depois do orçamento é recusado', async () => {
    const { t, openai } = await openaiServer()
    const other = pngBytes(800, 1200, 99)
    const swapped = await quoteThenGenerate(t, JOB, { ...CALL, references: [{ mimeType: 'image/png', b64: bytesToBase64(other) }, UPLOAD_B] })
    expect(swapped.gen.status).toBe(409)
    expect(swapped.gen.json.error.code).toBe('quote_mismatch')

    const reordered = await quoteThenGenerate(t, JOB, { ...CALL, references: [UPLOAD_B, UPLOAD_A] })
    expect(reordered.gen.json.error.code).toBe('quote_mismatch')

    const fidelity = await quoteThenGenerate(t, JOB, { ...CALL, inputFidelity: 'low' })
    expect(fidelity.gen.json.error.code).toBe('quote_mismatch')

    const dropped = await quoteThenGenerate(t, JOB, { ...BASE, n: 2 })
    expect(dropped.gen.json.error.code).toBe('quote_mismatch')
    expect(openai.calls).toHaveLength(0)
  })

  it('gpt-image-1-mini: aceita referências, mas não manda input_fidelity alta', async () => {
    const { t, openai } = await openaiServer()
    const mini = { ...BASE, model: 'gpt-image-1-mini' }
    const high = await t.request('POST', '/api/images/quote', { body: { ...mini, totalImages: 1, references: [DESC_A], inputFidelity: 'high' } })
    expect(high.status).toBe(400)
    const { gen } = await quoteThenGenerate(t, { ...mini, totalImages: 1, references: [DESC_A] }, { ...mini, n: 1, references: [UPLOAD_A] })
    expect(gen.status).toBe(200)
    expect((openai.calls[0].init.body as FormData).has('input_fidelity')).toBe(false)
  })

  it('modelos sem suporte a referências (DALL-E) são recusados com mensagem clara', async () => {
    const { t, openai } = await openaiServer()
    const dalle = { model: 'dall-e-3', prompt: 'x', size: '1024x1024', quality: 'standard' }
    const quote = await t.request('POST', '/api/images/quote', { body: { ...dalle, totalImages: 1, references: [DESC_A] } })
    expect(quote.status).toBe(400)
    expect(quote.json.error.code).toBe('references_not_supported')
    const gen = await t.request('POST', '/api/images/generate', { body: { ...dalle, n: 1, references: [UPLOAD_A] }, headers: { 'X-Cost-Quote': 'x' } })
    expect(gen.json.error.code).toBe('references_not_supported')
    expect(openai.calls).toHaveLength(0)
  })

  it('geração tradicional (sem referências) continua no endpoint de geração', async () => {
    const { t, openai } = await openaiServer()
    const { gen } = await quoteThenGenerate(t, { ...BASE, totalImages: 2 }, { ...BASE, n: 2 })
    expect(gen.status).toBe(200)
    expect(openai.calls[0].url).toBe('https://api.openai.com/v1/images/generations')
  })
})

describe('validação dos arquivos no servidor', () => {
  async function expectRejected(references: unknown[], extra: object = {}) {
    const res = await t!.request('POST', '/api/images/generate', {
      body: { ...BASE, n: 1, references, ...extra },
      headers: { 'X-Cost-Quote': 'qualquer' },
    })
    expect(res.status, JSON.stringify(res.json)).toBe(400)
    return res.json.error.message as string
  }

  it('tipo declarado diferente do conteúdo real', async () => {
    await openaiServer()
    expect(await expectRejected([{ mimeType: 'image/png', b64: bytesToBase64(PHOTO_B) }])).toMatch(/não corresponde/)
  })

  it('arquivo que não é imagem suportada (GIF, texto, SVG)', async () => {
    await openaiServer()
    const gif = new TextEncoder().encode('GIF89a' + 'x'.repeat(40))
    expect(await expectRejected([{ mimeType: 'image/png', b64: bytesToBase64(gif) }])).toMatch(/formato não suportado/)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(await expectRejected([{ mimeType: 'image/png', b64: bytesToBase64(svg) }])).toMatch(/formato não suportado/)
  })

  it('base64 inválido, URL no lugar dos dados e campos extras', async () => {
    await openaiServer()
    expect(await expectRejected([{ mimeType: 'image/png', b64: 'não é base64!' }])).toMatch(/base64/)
    expect(await expectRejected([{ mimeType: 'image/png', url: 'https://exemplo.com/foto.png' }])).toMatch(/URLs não são aceitas/)
    expect(await expectRejected(['https://exemplo.com/foto.png'])).toMatch(/formato inválido/)
    expect(await expectRejected([])).toMatch(/pelo menos uma imagem/)
  })

  it('arquivo maior que o limite configurado', async () => {
    await openaiServer({ MAX_REFERENCE_FILE_MB: '0.1' })
    const big = new Uint8Array(150 * 1024)
    big.set(pngBytes(10, 10))
    expect(await expectRejected([{ mimeType: 'image/png', b64: bytesToBase64(big) }])).toMatch(/maior que/)
  })

  it('mais referências que o limite configurado', async () => {
    await openaiServer({ MAX_REFERENCE_IMAGES: '2' })
    const three = [1, 2, 3].map((seed) => ({ mimeType: 'image/png', b64: bytesToBase64(pngBytes(10, 10, seed)) }))
    expect(await expectRejected(three)).toMatch(/No máximo 2/)
  })

  it('inputFidelity sem referências é recusado', async () => {
    await openaiServer()
    const res = await t!.request('POST', '/api/images/quote', { body: { ...BASE, totalImages: 1, inputFidelity: 'high' } })
    expect(res.status).toBe(400)
  })

  it('descritores do orçamento são validados', async () => {
    await openaiServer()
    const bad = await t!.request('POST', '/api/images/quote', {
      body: { ...BASE, totalImages: 1, references: [{ ...DESC_A, sha256: 'curto' }] },
    })
    expect(bad.status).toBe(400)
    const gif = await t!.request('POST', '/api/images/quote', {
      body: { ...BASE, totalImages: 1, references: [{ ...DESC_A, mimeType: 'image/gif' }] },
    })
    expect(gif.status).toBe(400)
  })

  it('corpo acima do limite da edição é cortado (413) antes de decodificar', async () => {
    await openaiServer({ MAX_EDIT_BODY_BYTES: '2048' })
    const big = new Uint8Array(4096)
    big.set(pngBytes(10, 10))
    const res = await t!.request('POST', '/api/images/generate', {
      body: { ...BASE, n: 1, references: [{ mimeType: 'image/png', b64: bytesToBase64(big) }] },
    })
    expect(res.status).toBe(413)
  })
})

describe('privacidade e controle de consumo', () => {
  it('os logs não contêm imagens nem prompts', async () => {
    const { t, logs } = await openaiServer()
    await quoteThenGenerate(t)
    await t.request('POST', '/api/images/generate', { body: { ...CALL, references: [{ mimeType: 'image/png', b64: 'xx!' }] } })
    const all = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(all).not.toContain(UPLOAD_A.b64.slice(0, 40))
    expect(all).not.toContain('Maria na cozinha')
    expect(all).not.toMatch(/base64|data:image/)
  })

  it('edições contam nos limites diários e de custo', async () => {
    const { t } = await openaiServer({ DAILY_IMAGE_LIMIT: '2' })
    expect((await quoteThenGenerate(t)).gen.status).toBe(200)
    const next = await t.request('POST', '/api/images/quote', { body: JOB })
    expect(next.status).toBe(429)
    expect(t.deps.ledger.current().images).toBe(2)
  })

  it('custo das referências pode estourar o limite por geração', async () => {
    const { t } = await openaiServer({ MAX_COST_PER_JOB_USD: '0.05' })
    const res = await t.request('POST', '/api/images/quote', { body: JOB })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('job_too_expensive')
  })

  it('/api/status informa limites e modelos de referência', async () => {
    const { t } = await openaiServer({ ALLOWED_MODELS: 'gpt-image-1,dall-e-3' })
    const res = await t.request('GET', '/api/status')
    expect(res.json.referenceModels).toEqual(['gpt-image-1'])
    expect(res.json.limits).toMatchObject({ maxReferenceImages: 6, maxReferenceBytes: 8 * 1024 * 1024 })
  })
})

describe('modo simulado do servidor', () => {
  it('recebe as fotos (mostra o hash de cada uma) sem chamar a OpenAI', async () => {
    const openai = fakeOpenAI(() => {
      throw new Error('não deveria chamar')
    })
    t = await startServer({}, { fetchImpl: openai.fetchImpl })
    const webp = webpBytes(640, 480, 5)
    const desc = descriptor(webp, 'image/webp', 640, 480)
    const { gen } = await quoteThenGenerate(
      t,
      { ...BASE, totalImages: 1, references: [desc], inputFidelity: 'high' },
      { ...BASE, n: 1, references: [{ mimeType: 'image/webp', b64: bytesToBase64(webp) }], inputFidelity: 'high' },
    )
    expect(gen.status).toBe(200)
    const svg = Buffer.from(gen.json.images[0].b64, 'base64').toString()
    expect(svg).toContain('1 referência(s)')
    expect(svg).toContain(desc.sha256.slice(0, 8))
    expect(svg).toContain('640x480')
    expect(openai.calls).toHaveLength(0)
  })
})
