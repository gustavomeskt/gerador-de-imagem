import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpError } from './http'

// Controles contra consumo descontrolado: limite de chamadas simultâneas
// (com fila curta), limite de requisições por minuto e um livro-caixa diário
// de imagens e custo estimado, salvo em disco pra valer mesmo depois de
// reiniciar o servidor.

export class ConcurrencyLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private readonly maxConcurrent: number
  private readonly maxQueued: number

  constructor(maxConcurrent: number, maxQueued: number) {
    this.maxConcurrent = maxConcurrent
    this.maxQueued = maxQueued
  }

  get stats() {
    return { active: this.active, queued: this.waiting.length }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueued) {
        throw new HttpError(429, 'server_busy', 'Servidor ocupado com outras gerações. Tente de novo em instantes.', {
          'Retry-After': '5',
        })
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

export class RateLimiter {
  private readonly hits: number[] = []
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(max: number, windowMs = 60_000, now: () => number = Date.now) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
  }

  check() {
    const t = this.now()
    while (this.hits.length > 0 && this.hits[0] <= t - this.windowMs) this.hits.shift()
    if (this.hits.length >= this.max) {
      const retry = Math.ceil((this.hits[0] + this.windowMs - t) / 1000)
      throw new HttpError(429, 'rate_limited', `Muitas requisições. Limite de ${this.max} por minuto.`, {
        'Retry-After': String(Math.max(1, retry)),
      })
    }
    this.hits.push(t)
  }
}

export interface DailyUsage {
  date: string // AAAA-MM-DD (UTC)
  images: number
  estimatedUsd: number
  calls: number
}

export interface Reservation {
  images: number
  usd: number
}

// Livro-caixa diário. Reserva antes da chamada paga (pra duas chamadas
// simultâneas não estourarem o limite juntas), confirma se deu certo e
// devolve se a OpenAI recusou.
export class UsageLedger {
  private usage: DailyUsage
  private readonly file: string | null
  private readonly limits: { dailyImageLimit: number; dailyBudgetUsd: number }
  private readonly now: () => Date

  constructor(options: {
    dataDir: string | null
    dailyImageLimit: number
    dailyBudgetUsd: number
    now?: () => Date
  }) {
    this.now = options.now ?? (() => new Date())
    this.limits = options
    this.file = options.dataDir ? join(options.dataDir, 'usage.json') : null
    this.usage = this.load()
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10)
  }

  private empty(): DailyUsage {
    return { date: this.today(), images: 0, estimatedUsd: 0, calls: 0 }
  }

  private load(): DailyUsage {
    if (!this.file) return this.empty()
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as DailyUsage
      return saved.date === this.today() ? saved : this.empty()
    } catch {
      return this.empty()
    }
  }

  private save() {
    if (!this.file) return
    mkdirSync(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.usage, null, 2))
    renameSync(tmp, this.file)
  }

  current(): DailyUsage {
    if (this.usage.date !== this.today()) this.usage = this.empty()
    return { ...this.usage }
  }

  // Lança 429 se o pedido estourar algum limite do dia.
  assertWithinLimits(images: number, usd: number) {
    const u = this.current()
    if (u.images + images > this.limits.dailyImageLimit) {
      throw new HttpError(
        429,
        'daily_image_limit',
        `Limite diário de imagens atingido (${u.images}/${this.limits.dailyImageLimit}). Ajuste DAILY_IMAGE_LIMIT no .env se for intencional.`,
      )
    }
    if (u.estimatedUsd + usd > this.limits.dailyBudgetUsd + 1e-9) {
      throw new HttpError(
        429,
        'daily_budget',
        `Orçamento diário estimado atingido (US$ ${u.estimatedUsd.toFixed(2)} de US$ ${this.limits.dailyBudgetUsd.toFixed(2)}). Ajuste DAILY_BUDGET_USD no .env se for intencional.`,
      )
    }
  }

  reserve(images: number, usd: number): Reservation {
    this.assertWithinLimits(images, usd)
    this.usage.images += images
    this.usage.estimatedUsd += usd
    this.usage.calls += 1
    this.save()
    return { images, usd }
  }

  refund(reservation: Reservation) {
    this.current()
    this.usage.images = Math.max(0, this.usage.images - reservation.images)
    this.usage.estimatedUsd = Math.max(0, this.usage.estimatedUsd - reservation.usd)
    this.usage.calls = Math.max(0, this.usage.calls - 1)
    this.save()
  }
}
