// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConcurrencyLimiter, RateLimiter, UsageLedger } from '../limits'
import { QuoteStore } from '../quotes'
import { fakeOpenAI, FAKE_KEY, imagesResponse, quoteAndGenerate, startServer, VALID_JOB, type TestServer } from './helpers'

let t: TestServer | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

async function openaiServer(env: Record<string, string>, handler: Parameters<typeof fakeOpenAI>[0] = () => imagesResponse(2)) {
  const openai = fakeOpenAI(handler)
  t = await startServer({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, ...env }, { fetchImpl: openai.fetchImpl })
  return { t, openai }
}

describe('proteção contra consumo descontrolado', () => {
  it('limite de chamadas por minuto', async () => {
    const { t } = await openaiServer({ MAX_REQUESTS_PER_MINUTE: '2' })
    expect((await quoteAndGenerate(t)).gen.status).toBe(200)
    expect((await quoteAndGenerate(t)).gen.status).toBe(200)
    const third = await quoteAndGenerate(t)
    expect(third.gen.status).toBe(429)
    expect(third.gen.json.error.code).toBe('rate_limited')
    expect(third.gen.headers['retry-after']).toBeDefined()
  })

  it('limite diário de imagens (no orçamento e na geração)', async () => {
    const { t, openai } = await openaiServer({ DAILY_IMAGE_LIMIT: '3' })
    const tooMany = await t.request('POST', '/api/images/quote', { body: { ...VALID_JOB, totalImages: 4 } })
    expect(tooMany.status).toBe(429)
    expect(tooMany.json.error.code).toBe('daily_image_limit')

    expect((await quoteAndGenerate(t)).gen.status).toBe(200) // 2 de 3
    const next = await t.request('POST', '/api/images/quote', { body: VALID_JOB })
    expect(next.status).toBe(429)
    expect(openai.calls).toHaveLength(1)
  })

  it('orçamento diário estimado em US$', async () => {
    const { t } = await openaiServer({ DAILY_BUDGET_USD: '0.05' })
    expect((await quoteAndGenerate(t)).gen.status).toBe(200) // ~0,032
    const res = await t.request('POST', '/api/images/quote', { body: VALID_JOB })
    expect(res.status).toBe(429)
    expect(res.json.error.code).toBe('daily_budget')
  })

  it('custo máximo por geração', async () => {
    const { t } = await openaiServer({ MAX_COST_PER_JOB_USD: '0.5' })
    const res = await t.request('POST', '/api/images/quote', {
      body: { ...VALID_JOB, quality: 'high', totalImages: 4 }, // 4 × 0,25 = US$ 1
    })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe('job_too_expensive')
  })

  it('chamadas simultâneas acima do limite (sem fila) recebem 429', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { t } = await openaiServer({ MAX_CONCURRENT_REQUESTS: '1', MAX_QUEUED_REQUESTS: '0' }, async () => {
      await gate
      return imagesResponse(2)
    })
    const first = quoteAndGenerate(t)
    await new Promise((r) => setTimeout(r, 50))
    const second = await quoteAndGenerate(t)
    expect(second.gen.status).toBe(429)
    expect(second.gen.json.error.code).toBe('server_busy')
    release()
    expect((await first).gen.status).toBe(200)
    // a reserva da chamada recusada foi devolvida
    expect(t.deps.ledger.current().images).toBe(2)
  })
})

describe('peças de controle', () => {
  it('ConcurrencyLimiter respeita o máximo e a fila', async () => {
    const limiter = new ConcurrencyLimiter(2, 1)
    let running = 0
    let peak = 0
    const task = () =>
      limiter.run(async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 20))
        running -= 1
      })
    const results = await Promise.allSettled([task(), task(), task(), task()])
    expect(peak).toBe(2)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1) // 2 rodando + 1 na fila
  })

  it('RateLimiter libera depois da janela', () => {
    let now = 0
    const rl = new RateLimiter(1, 60_000, () => now)
    rl.check()
    expect(() => rl.check()).toThrow()
    now = 60_001
    expect(() => rl.check()).not.toThrow()
  })

  it('UsageLedger salva em disco, sobrevive a reinício e zera no dia seguinte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifs-ledger-'))
    let day = new Date('2026-10-15T10:00:00Z')
    const make = () => new UsageLedger({ dataDir: dir, dailyImageLimit: 10, dailyBudgetUsd: 1, now: () => day })

    const a = make()
    const r = a.reserve(3, 0.3)
    expect(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))).toMatchObject({ images: 3 })

    const b = make() // "reiniciou o servidor"
    expect(b.current()).toMatchObject({ date: '2026-10-15', images: 3 })
    expect(() => b.reserve(8, 0.1)).toThrow(/Limite diário de imagens/)
    expect(() => b.reserve(1, 0.8)).toThrow(/Orçamento diário/)
    b.refund(r)
    expect(b.current().images).toBe(0)

    day = new Date('2026-10-16T00:00:01Z')
    b.reserve(2, 0.1)
    expect(make().current()).toMatchObject({ date: '2026-10-16', images: 2 })
  })

  it('QuoteStore vence orçamentos pelo tempo', () => {
    let now = 0
    const store = new QuoteStore(1000, () => now)
    const q = store.create({ kind: 'images', fingerprint: 'f', images: 1, calls: 1, usd: 0.1 })
    now = 1001
    expect(() => store.consume(q.id, { kind: 'images', fingerprint: 'f', images: 1 })).toThrow(/vencido/)
  })
})
