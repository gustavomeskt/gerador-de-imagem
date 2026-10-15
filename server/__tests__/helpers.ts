import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'vitest'
import { createDeps, createHttpServer, type AppDeps } from '../app'
import { loadConfig } from '../config'
import { UsageLedger } from '../limits'

// Chave FALSA usada nos testes. Toda resposta do servidor é conferida pra
// garantir que ela (ou qualquer pedaço "sk-...") nunca aparece.
export const FAKE_KEY = 'sk-test-NAO-E-UMA-CHAVE-REAL-0123456789abcdef'

export interface TestServer {
  url: string
  deps: AppDeps
  server: Server
  request: (method: string, path: string, options?: RequestOptions) => Promise<TestResponse>
  close: () => Promise<void>
}

export interface RequestOptions {
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
}

export interface TestResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function startServer(
  env: Record<string, string> = {},
  overrides: Partial<AppDeps> & { fetchImpl?: typeof fetch } = {},
): Promise<TestServer> {
  const config = loadConfig({ SERVER_DATA_DIR: '', ...env })
  const deps = createDeps(config, {
    ledger: new UsageLedger({ dataDir: null, dailyImageLimit: config.dailyImageLimit, dailyBudgetUsd: config.dailyBudgetUsd }),
    log: () => {},
    ...overrides,
  })
  const server = createHttpServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  // http.request em vez de fetch: permite mandar qualquer cabeçalho (Host, Origin...)
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    new Promise<TestResponse>((resolve, reject) => {
      const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
      const headers: Record<string, string> = {
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      }
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          // nenhuma resposta pode conter a chave ou algo com cara de chave
          expect(text).not.toContain(FAKE_KEY)
          expect(text).not.toMatch(/sk-[A-Za-z0-9]/)
          let json: unknown = null
          try {
            json = JSON.parse(text)
          } catch {
            // sem JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      })
      req.on('error', reject)
      if (payload !== undefined) req.write(payload)
      req.end()
    })

  return {
    url: `http://127.0.0.1:${port}`,
    deps,
    server,
    request,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// "OpenAI" falsa: registra as chamadas e responde conforme o cenário.
export interface FakeCall {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

export function fakeOpenAI(handler: (call: FakeCall) => Response | Promise<Response>) {
  const calls: FakeCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { calls, fetchImpl }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function imagesResponse(n: number): Response {
  return jsonResponse(200, { data: Array.from({ length: n }, (_, i) => ({ b64_json: Buffer.from(`png-${i}`).toString('base64') })) })
}

export const VALID_JOB = { model: 'gpt-image-1', prompt: 'Senhora na cozinha', size: '1024x1536', quality: 'low', totalImages: 2 }
export const VALID_CALL = { model: 'gpt-image-1', prompt: 'Senhora na cozinha', size: '1024x1536', quality: 'low', n: 2 }

export async function quoteAndGenerate(t: TestServer, job = VALID_JOB, call = VALID_CALL) {
  const quote = await t.request('POST', '/api/images/quote', { body: job })
  const gen = await t.request('POST', '/api/images/generate', { body: call, headers: { 'X-Cost-Quote': quote.json?.quoteId ?? '' } })
  return { quote, gen }
}
