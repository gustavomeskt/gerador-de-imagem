import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MODEL_MAX_N } from '../src/generation/models'
import type { ReferenceDescriptor } from '../src/generation/references'
import type { CostQuote } from '../src/generation/types'
import { publicConfig, type ServerConfig } from './config'
import { HttpError, readJsonBody, sendError, sendJson } from './http'
import { ConcurrencyLimiter, RateLimiter, UsageLedger, type Reservation } from './limits'
import { createOpenAIClient, redactSecrets, type ImageClient } from './openaiClient'
import { estimateEnhance, estimateImageJob, loadPriceTable, PRICES_REFERENCE_DATE, PRICES_SOURCE, type PriceTable } from './pricing'
import { fingerprint, QuoteStore, type QuoteRecord } from './quotes'
import { checkRequestOrigin } from './security'
import { createSimulatedClient } from './simulatedClient'
import { validateEnhanceBody, validateGenerateBody, validateImageJob } from './validation'

// Rotas do backend:
//   GET  /api/health            → { ok: true }
//   GET  /api/status            → modo, se a chave existe (nunca a chave), limites e uso do dia
//   POST /api/images/quote      → orçamento de um trabalho (todas as imagens de um nó)
//   POST /api/images/generate   → contrato do backendProvider.ts + cabeçalho X-Cost-Quote
//   POST /api/prompts/quote     → orçamento do melhorador de prompt
//   POST /api/prompts/enhance   → contrato do backendProvider.ts + cabeçalho X-Cost-Quote

export const QUOTE_HEADER = 'x-cost-quote'

export interface AppDeps {
  config: ServerConfig
  client: ImageClient
  prices: PriceTable
  ledger: UsageLedger
  quotes: QuoteStore
  limiter: ConcurrencyLimiter
  rateLimiter: RateLimiter
  log?: (line: string) => void
}

export function createDeps(config: ServerConfig, overrides: Partial<AppDeps> & { fetchImpl?: typeof fetch } = {}): AppDeps {
  const client =
    overrides.client ??
    (config.mode === 'openai'
      ? createOpenAIClient({
          apiKey: config.openaiApiKey!,
          baseUrl: config.openaiBaseUrl,
          imageTimeoutMs: config.imageTimeoutMs,
          textTimeoutMs: config.textTimeoutMs,
          fetchImpl: overrides.fetchImpl,
        })
      : createSimulatedClient({ latencyMs: 400 }))

  return {
    config,
    client,
    prices: overrides.prices ?? loadPriceTable(config.priceTableFile),
    ledger:
      overrides.ledger ??
      new UsageLedger({
        dataDir: config.dataDir,
        dailyImageLimit: config.dailyImageLimit,
        dailyBudgetUsd: config.dailyBudgetUsd,
      }),
    quotes: overrides.quotes ?? new QuoteStore(config.quoteTtlMs),
    limiter: overrides.limiter ?? new ConcurrencyLimiter(config.maxConcurrent, config.maxQueued),
    rateLimiter: overrides.rateLimiter ?? new RateLimiter(config.maxRequestsPerMinute),
    log: overrides.log ?? ((line) => console.log(line)),
  }
}

function toQuoteResponse(q: QuoteRecord, deps: AppDeps, breakdown: string[], notes: string[]): CostQuote {
  const simulated = deps.config.mode === 'simulated'
  return {
    quoteId: q.id,
    kind: q.kind,
    expiresAt: new Date(q.expiresAt).toISOString(),
    mode: deps.config.mode,
    paid: !simulated,
    estimatedUsd: Number(q.usd.toFixed(4)),
    images: q.images,
    breakdown,
    notes: simulated
      ? ['Servidor em modo simulado: a OpenAI não será chamada e nada será cobrado. O valor mostra quanto custaria.', ...notes]
      : notes,
  }
}

// O orçamento vale só para exatamente este pedido — inclusive as mesmas
// referências (pelo hash dos bytes), na mesma ordem, e a mesma fidelidade.
function imageFingerprint(p: {
  model: string
  prompt: string
  size: string
  quality?: string
  references?: ReferenceDescriptor[]
  inputFidelity?: string
}) {
  return fingerprint({
    kind: 'images',
    model: p.model,
    prompt: p.prompt,
    size: p.size,
    quality: p.quality,
    references: (p.references ?? []).map((r) => [r.sha256, r.mimeType, r.byteLength, r.width, r.height]),
    inputFidelity: p.inputFidelity,
  })
}

function quoteIdFrom(req: IncomingMessage): string | undefined {
  const value = req.headers[QUOTE_HEADER]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Executa a chamada (paga, no modo openai) dentro dos limites: reserva no
// livro-caixa, respeita a fila de concorrência e devolve a reserva se a
// OpenAI recusar. Em timeout a reserva fica (a OpenAI pode ter cobrado).
async function runPaid<T>(deps: AppDeps, images: number, usd: number, task: () => Promise<T>): Promise<T> {
  const paid = deps.config.mode === 'openai'
  let reservation: Reservation | null = null
  if (paid) reservation = deps.ledger.reserve(images, usd)
  try {
    return await deps.limiter.run(task)
  } catch (err) {
    if (reservation && !(err instanceof HttpError && err.code === 'upstream_timeout')) deps.ledger.refund(reservation)
    throw err
  }
}

async function route(req: IncomingMessage, res: ServerResponse, deps: AppDeps) {
  const { config } = deps
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  checkRequestOrigin(req, config)

  const allow = (method: string) => {
    if (req.method !== method) throw new HttpError(405, 'method_not_allowed', `Use ${method} nesta rota.`, { Allow: method })
  }

  switch (path) {
    case '/api/health':
      allow('GET')
      return sendJson(res, 200, { ok: true })

    case '/api/status':
      allow('GET')
      return sendJson(res, 200, {
        ...publicConfig(config),
        usageToday: deps.ledger.current(),
        load: deps.limiter.stats,
        prices: { referenceDate: PRICES_REFERENCE_DATE, source: PRICES_SOURCE },
      })

    case '/api/images/quote': {
      allow('POST')
      const job = validateImageJob(await readJsonBody(req, config.maxBodyBytes), config)
      const estimate = estimateImageJob(job, deps.prices)
      if (config.mode === 'openai') {
        if (estimate.usd > config.maxCostPerJobUsd) {
          throw new HttpError(
            422,
            'job_too_expensive',
            `Custo estimado (US$ ${estimate.usd.toFixed(2)}) acima do limite por geração (US$ ${config.maxCostPerJobUsd.toFixed(2)}). Reduza a quantidade/qualidade ou ajuste MAX_COST_PER_JOB_USD.`,
          )
        }
        deps.ledger.assertWithinLimits(job.totalImages, estimate.usd)
      }
      const quote = deps.quotes.create({
        kind: 'images',
        fingerprint: imageFingerprint(job),
        images: job.totalImages,
        calls: Math.ceil(job.totalImages / MODEL_MAX_N[job.model]),
        usd: estimate.usd,
      })
      return sendJson(res, 200, toQuoteResponse(quote, deps, estimate.breakdown, estimate.notes))
    }

    case '/api/images/generate': {
      allow('POST')
      // limite maior: as fotos de referência vêm no corpo (base64)
      const request = validateGenerateBody(await readJsonBody(req, config.maxEditBodyBytes), config)
      deps.rateLimiter.check()
      const usd = deps.quotes.consume(quoteIdFrom(req), {
        kind: 'images',
        fingerprint: imageFingerprint(request),
        images: request.n,
      })
      const images = await runPaid(deps, request.n, usd, () =>
        request.references ? deps.client.editImages(request) : deps.client.generateImages(request),
      )
      return sendJson(res, 200, { images })
    }

    case '/api/prompts/quote': {
      allow('POST')
      const { prompt } = validateEnhanceBody(await readJsonBody(req, config.maxBodyBytes))
      const estimate = estimateEnhance(prompt, deps.prices)
      if (config.mode === 'openai') deps.ledger.assertWithinLimits(0, estimate.usd)
      const quote = deps.quotes.create({
        kind: 'enhance',
        fingerprint: fingerprint({ kind: 'enhance', prompt }),
        images: 0,
        calls: 1,
        usd: estimate.usd,
      })
      return sendJson(res, 200, toQuoteResponse(quote, deps, estimate.breakdown, estimate.notes))
    }

    case '/api/prompts/enhance': {
      allow('POST')
      const { prompt } = validateEnhanceBody(await readJsonBody(req, config.maxBodyBytes))
      deps.rateLimiter.check()
      const usd = deps.quotes.consume(quoteIdFrom(req), {
        kind: 'enhance',
        fingerprint: fingerprint({ kind: 'enhance', prompt }),
        images: 0,
      })
      const enhanced = await runPaid(deps, 0, usd, () => deps.client.enhancePrompt(prompt))
      return sendJson(res, 200, { prompt: enhanced })
    }

    default:
      throw new HttpError(404, 'not_found', 'Rota não encontrada.')
  }
}

export function createRequestHandler(deps: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now()
    try {
      await route(req, res, deps)
    } catch (err) {
      const httpError =
        err instanceof HttpError
          ? err
          : new HttpError(500, 'internal_error', 'Erro interno no servidor.')
      if (!(err instanceof HttpError)) {
        deps.log?.(`[erro] ${redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err), deps.config.openaiApiKey)}`)
      }
      if (!res.headersSent) sendError(res, httpError)
      else res.destroy()
    } finally {
      // log sem corpo, sem cabeçalhos e sem prompt
      deps.log?.(`${req.method} ${(req.url ?? '').split('?')[0]} → ${res.statusCode} (${Date.now() - started} ms)`)
    }
  }
}

export function createHttpServer(deps: AppDeps): Server {
  const server = createServer(createRequestHandler(deps))
  // tempo pra receber cabeçalhos e corpo (não limita a espera pela OpenAI)
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  return server
}
