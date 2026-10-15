// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, publicConfig } from '../config'
import { DEFAULT_PRICES, estimateEnhance, estimateImageJob, loadPriceTable } from '../pricing'
import { fakeOpenAI, FAKE_KEY, quoteAndGenerate, startServer, VALID_JOB, type TestServer } from './helpers'

let t: TestServer | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

describe('configuração segura', () => {
  it('padrões: modo simulado, só 127.0.0.1, sem chave', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({ mode: 'simulated', host: '127.0.0.1', port: 8787, openaiApiKey: undefined })
    expect(c.allowedModels).toHaveLength(6)
    expect(c.allowedModels).toContain("gpt-image-2")
  })

  it('recusa escutar fora do próprio computador', () => {
    for (const HOST of ['0.0.0.0', '192.168.0.10', '::']) {
      expect(() => loadConfig({ HOST })).toThrow(ConfigError)
    }
    expect(loadConfig({ HOST: 'localhost' }).host).toBe('localhost')
  })

  it('modo openai exige chave; valores inválidos são recusados', () => {
    expect(() => loadConfig({ IMAGE_BACKEND_MODE: 'openai' })).toThrow(/OPENAI_API_KEY/)
    expect(() => loadConfig({ IMAGE_BACKEND_MODE: 'producao' })).toThrow(ConfigError)
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError)
    expect(() => loadConfig({ DAILY_BUDGET_USD: '-1' })).toThrow(ConfigError)
    expect(() => loadConfig({ ALLOWED_MODELS: 'gpt-image-1,midjourney' })).toThrow(/midjourney/)
  })

  it('a visão pública da configuração não inclui a chave', () => {
    const pub = publicConfig(loadConfig({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY }))
    expect(pub.keyConfigured).toBe(true)
    expect(JSON.stringify(pub)).not.toContain(FAKE_KEY)
  })
})

describe('modo simulado do servidor', () => {
  it('mesmo caminho (orçamento + confirmação), mas sem chamar a OpenAI e sem consumir o orçamento', async () => {
    const openai = fakeOpenAI(() => {
      throw new Error('não deveria chamar')
    })
    t = await startServer({}, { fetchImpl: openai.fetchImpl })
    const status = await t.request('GET', '/api/status')
    expect(status.json).toMatchObject({ mode: 'simulated', keyConfigured: false })

    const noQuote = await t.request('POST', '/api/images/generate', {
      body: { model: 'gpt-image-1', prompt: 'x', size: '1024x1024', n: 1 },
    })
    expect(noQuote.status).toBe(428)

    const { quote, gen } = await quoteAndGenerate(t)
    expect(quote.json).toMatchObject({ mode: 'simulated', paid: false })
    expect(quote.json.notes[0]).toMatch(/nada será cobrado/)
    expect(gen.status).toBe(200)
    expect(gen.json.images).toHaveLength(2)
    expect(gen.json.images[0].mimeType).toBe('image/svg+xml')
    expect(Buffer.from(gen.json.images[0].b64, 'base64').toString()).toContain('servidor simulado')
    expect(openai.calls).toHaveLength(0)
    expect(t.deps.ledger.current().images).toBe(0)
  })
})

describe('estimativa de custo', () => {
  it('gpt-image por qualidade e tamanho; "auto" orçado como "high"', () => {
    const low = estimateImageJob({ ...VALID_JOB, model: 'gpt-image-1', quality: 'low', prompt: '' }, DEFAULT_PRICES)
    expect(low.usd).toBeCloseTo(0.032, 6)
    const auto = estimateImageJob({ ...VALID_JOB, model: 'gpt-image-1', quality: 'auto', prompt: '' }, DEFAULT_PRICES)
    expect(auto.usd).toBeCloseTo(0.5, 6)
    expect(auto.notes.join(' ')).toMatch(/pior caso/)
  })

  it('dall-e-3 e dall-e-2 (sem custo de texto)', () => {
    expect(
      estimateImageJob({ model: 'dall-e-3', prompt: 'x', size: '1024x1792', quality: 'hd', totalImages: 2 }, DEFAULT_PRICES).usd,
    ).toBeCloseTo(0.24, 6)
    expect(estimateImageJob({ model: 'dall-e-2', prompt: 'x', size: '512x512', totalImages: 3 }, DEFAULT_PRICES).usd).toBeCloseTo(0.054, 6)
  })

  it('soma o texto do prompt nos modelos gpt-image', () => {
    const job = { model: 'gpt-image-1' as const, prompt: 'a'.repeat(4000), size: '1024x1024', quality: 'low', totalImages: 1 }
    expect(estimateImageJob(job, DEFAULT_PRICES).usd).toBeCloseTo(0.011 + (1000 * 5) / 1_000_000, 6)
  })

  it('melhorador: valor máximo pequeno', () => {
    const e = estimateEnhance('gato', DEFAULT_PRICES)
    expect(e.usd).toBeGreaterThan(0)
    expect(e.usd).toBeLessThan(0.02)
  })

  it('tabela de preços pode ser corrigida por arquivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifs-prices-'))
    const file = join(dir, 'precos.json')
    writeFileSync(file, JSON.stringify({ images: { 'dall-e-2': { standard: { '512x512': 1 } } } }))
    const prices = loadPriceTable(file)
    expect(estimateImageJob({ model: 'dall-e-2', prompt: 'x', size: '512x512', totalImages: 2 }, prices).usd).toBe(2)
    expect(prices.images['gpt-image-1']).toEqual(DEFAULT_PRICES.images['gpt-image-1'])
  })
})
