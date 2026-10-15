// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeOpenAI, FAKE_KEY, imagesResponse, startServer, VALID_JOB, type TestServer } from './helpers'

let t: TestServer
let openai: ReturnType<typeof fakeOpenAI>

beforeEach(async () => {
  openai = fakeOpenAI(() => imagesResponse(1))
  t = await startServer({ IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY }, { fetchImpl: openai.fetchImpl })
})
afterEach(() => t.close())

describe('a chave da API nunca chega ao navegador', () => {
  it('/api/status diz só se a chave existe', async () => {
    const res = await t.request('GET', '/api/status')
    expect(res.status).toBe(200)
    expect(res.json.keyConfigured).toBe(true)
    expect(res.json.mode).toBe('openai')
    expect(JSON.stringify(res.json)).not.toContain(FAKE_KEY)
  })

  it('a chave só vai no cabeçalho da chamada à OpenAI', async () => {
    const quote = await t.request('POST', '/api/images/quote', { body: { ...VALID_JOB, totalImages: 1 } })
    const res = await t.request('POST', '/api/images/generate', {
      body: { model: 'gpt-image-1', prompt: VALID_JOB.prompt, size: '1024x1536', quality: 'low', n: 1 },
      headers: { 'X-Cost-Quote': quote.json.quoteId },
    })
    expect(res.status).toBe(200)
    expect(openai.calls).toHaveLength(1)
    expect(new Headers(openai.calls[0].init.headers).get('Authorization')).toBe(`Bearer ${FAKE_KEY}`)
    expect(JSON.stringify(openai.calls[0].body)).not.toContain(FAKE_KEY)
  })

  it('o código do navegador (src/) não referencia a chave nem variáveis secretas', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full)
      }
    }
    walk('src')
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
      expect(code, file).not.toMatch(/OPENAI_API_KEY|process\.env|VITE_OPENAI|Authorization/)
    }
  })
})

describe('acesso restrito ao próprio computador', () => {
  it('recusa Host diferente de localhost (DNS rebinding)', async () => {
    const res = await t.request('GET', '/api/status', { headers: { Host: 'site-malicioso.com' } })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('forbidden_host')
  })

  it('aceita localhost, 127.0.0.1 e [::1]', async () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
      expect((await t.request('GET', '/api/health', { headers: { Host: host } })).status).toBe(200)
    }
  })

  it('recusa Origin de outro site e requisição cross-site', async () => {
    const bad = await t.request('POST', '/api/images/quote', { body: VALID_JOB, headers: { Origin: 'https://site-malicioso.com' } })
    expect(bad.status).toBe(403)
    const cross = await t.request('POST', '/api/images/quote', { body: VALID_JOB, headers: { 'Sec-Fetch-Site': 'cross-site' } })
    expect(cross.status).toBe(403)
    const ok = await t.request('POST', '/api/images/quote', { body: VALID_JOB, headers: { Origin: 'http://localhost:5173' } })
    expect(ok.status).toBe(200)
  })

  it('não responde CORS (nenhum Access-Control-Allow-Origin)', async () => {
    const res = await t.request('OPTIONS', '/api/images/generate', { headers: { Origin: 'http://localhost:5173' } })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.status).toBe(405)
  })

  it('exige JSON (bloqueia formulários e text/plain de outros sites)', async () => {
    const res = await t.request('POST', '/api/images/quote', {
      rawBody: JSON.stringify(VALID_JOB),
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(res.status).toBe(415)
  })

  it('limita o tamanho do corpo', async () => {
    const res = await t.request('POST', '/api/images/quote', { rawBody: `{"prompt":"${'a'.repeat(200_000)}"}` })
    expect(res.status).toBe(413)
    expect(openai.calls).toHaveLength(0)
  })

  it('JSON inválido, rota inexistente e método errado', async () => {
    expect((await t.request('POST', '/api/images/quote', { rawBody: '{quebrado' })).status).toBe(400)
    expect((await t.request('GET', '/api/nada')).status).toBe(404)
    expect((await t.request('GET', '/api/images/generate')).status).toBe(405)
  })

  it('respostas não são guardadas em cache', async () => {
    const res = await t.request('GET', '/api/status')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})
