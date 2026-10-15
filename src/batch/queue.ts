import type { ImageTaskStatus, TaskErrorKind } from './types'

// Fila de geração: executa as tarefas respeitando o limite de chamadas
// simultâneas, as dependências entre cenas, pausas e novas tentativas.
//
// O estado das tarefas fica no store (e no banco); a fila só lê e pede
// alterações através de `getTasks`/`update`. Assim, o que aparece na tela e
// o que é salvo são sempre a mesma coisa.
//
// Regra de cobrança: só tenta de novo sozinha quando é CERTO que a chamada
// anterior não gerou nada (recusa, fila cheia, limite de requisições). Se não
// dá para saber (tempo esgotado, conexão caída no meio) e o provedor cobra,
// a tarefa fica como "falhou" e a pessoa decide.

export interface QueueTask {
  id: string
  status: ImageTaskStatus
  attempts: number
  dependsOn: string[]
  nextAttemptAt?: number
  token?: string
}

export interface ErrorVerdict {
  kind: 'transient' | 'permanent' | 'uncertain'
  message: string
  retryAfterMs?: number
  rateLimited?: boolean // vale para a fila toda (espera antes de qualquer nova chamada)
}

export interface TaskPatch {
  status?: ImageTaskStatus
  attempts?: number
  error?: string | undefined
  errorKind?: TaskErrorKind | undefined
  nextAttemptAt?: number | undefined
  token?: string
  startedAt?: number
  finishedAt?: number
}

export interface QueueOptions {
  getTasks: () => QueueTask[]
  update: (taskId: string, patch: TaskPatch) => void
  // executa a tarefa; quem executa grava o resultado se o token ainda valer
  execute: (taskId: string, token: string) => Promise<void>
  classify: (err: unknown) => ErrorVerdict
  concurrency: () => number
  // false = a tarefa ainda não pode começar (ex.: sem autorização de custo)
  canStart?: (taskId: string) => boolean
  chargeRisk: () => boolean // o provedor pode cobrar por uma chamada incerta?
  dependencyFailed: (taskId: string, dependencyId: string) => string
  onIdle?: () => void
  onChange?: () => void
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  makeToken?: () => string
}

let tokenCounter = 0

export class GenerationQueue {
  private readonly o: Required<Omit<QueueOptions, 'onIdle' | 'onChange' | 'canStart'>> & Pick<QueueOptions, 'onIdle' | 'onChange' | 'canStart'>
  private paused = false
  private stopped = false
  private holdUntil = 0
  private timer: unknown = null
  private timerAt = 0
  private readonly inFlight = new Set<string>()

  constructor(options: QueueOptions) {
    this.o = {
      maxAttempts: 3,
      baseDelayMs: 2000,
      maxDelayMs: 60_000,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      makeToken: () => `t${Date.now().toString(36)}-${++tokenCounter}-${Math.random().toString(36).slice(2, 8)}`,
      ...options,
    }
  }

  get isPaused() {
    return this.paused
  }

  get running() {
    return this.inFlight.size
  }

  start() {
    this.paused = false
    this.stopped = false
    this.pump()
  }

  // Pausa: nenhuma chamada nova começa; as que já estão em andamento terminam.
  pause() {
    this.paused = true
    this.clearScheduled()
  }

  resume() {
    this.paused = false
    this.pump()
  }

  // Encerra a fila (ex.: projeto apagado). Respostas que chegarem depois são
  // ignoradas por quem executa (o token deixa de valer).
  stop() {
    this.stopped = true
    this.clearScheduled()
  }

  private clearScheduled() {
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
    this.timerAt = 0
  }

  private schedule(at: number) {
    if (this.timer !== null && this.timerAt <= at) return
    this.clearScheduled()
    this.timerAt = at
    this.timer = this.o.setTimer(
      () => {
        this.timer = null
        this.timerAt = 0
        this.pump()
      },
      Math.max(0, at - this.o.now()),
    )
  }

  pump() {
    if (this.stopped || this.paused) return
    const now = this.o.now()
    let tasks = this.o.getTasks()
    const byId = new Map(tasks.map((t) => [t.id, t]))

    // dependência que falhou ou foi cancelada: a tarefa não tem como seguir
    for (const t of tasks) {
      if (t.status !== 'pending') continue
      const broken = t.dependsOn.find((d) => {
        const dep = byId.get(d)
        return !dep || dep.status === 'failed' || dep.status === 'cancelled'
      })
      if (broken) {
        this.o.update(t.id, { status: 'failed', errorKind: 'dependency', error: this.o.dependencyFailed(t.id, broken), finishedAt: now })
      }
    }
    tasks = this.o.getTasks()

    const pending = tasks.filter((t) => t.status === 'pending')
    if (pending.length === 0 && this.inFlight.size === 0) {
      this.o.onIdle?.()
      return
    }
    if (this.holdUntil > now) {
      this.schedule(this.holdUntil)
      return
    }

    const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id))
    const ready = pending.filter(
      (t) =>
        !this.inFlight.has(t.id) &&
        t.dependsOn.every((d) => doneIds.has(d)) &&
        (t.nextAttemptAt ?? 0) <= now &&
        (this.o.canStart?.(t.id) ?? true),
    )
    let slots = Math.max(1, this.o.concurrency()) - this.inFlight.size
    for (const t of ready) {
      if (slots <= 0) break
      slots -= 1
      this.launch(t)
    }

    // próxima tentativa agendada
    const waiting = pending.filter((t) => !this.inFlight.has(t.id) && (t.nextAttemptAt ?? 0) > now)
    if (waiting.length) this.schedule(Math.min(...waiting.map((t) => t.nextAttemptAt!)))
    this.o.onChange?.()
  }

  private launch(task: QueueTask) {
    const token = this.o.makeToken()
    this.inFlight.add(task.id)
    this.o.update(task.id, {
      status: 'running',
      attempts: task.attempts + 1,
      token,
      startedAt: this.o.now(),
      nextAttemptAt: undefined,
      error: undefined,
      errorKind: undefined,
    })
    this.o
      .execute(task.id, token)
      .catch((err: unknown) => this.handleError(task.id, token, err))
      .finally(() => {
        this.inFlight.delete(task.id)
        this.pump()
      })
  }

  private handleError(taskId: string, token: string, err: unknown) {
    const current = this.o.getTasks().find((t) => t.id === taskId)
    // tarefa cancelada/refeita enquanto esperava: a resposta é de outra tentativa
    if (!current || current.token !== token || current.status !== 'running') return
    const verdict = this.o.classify(err)
    const now = this.o.now()
    const retryable = verdict.kind === 'transient' || (verdict.kind === 'uncertain' && !this.o.chargeRisk())
    if (retryable && current.attempts < this.o.maxAttempts) {
      const backoff = Math.min(this.o.baseDelayMs * 2 ** (current.attempts - 1), this.o.maxDelayMs)
      const delay = Math.max(verdict.retryAfterMs ?? 0, backoff)
      if (verdict.rateLimited) this.holdUntil = Math.max(this.holdUntil, now + delay)
      this.o.update(taskId, {
        status: 'pending',
        nextAttemptAt: now + delay,
        errorKind: 'transient',
        error: `Nova tentativa em ${Math.round(delay / 1000)} s (tentativa ${current.attempts + 1} de ${this.o.maxAttempts}): ${verdict.message}`,
      })
      return
    }
    const kind: TaskErrorKind = verdict.kind === 'uncertain' ? 'uncertain' : verdict.kind === 'transient' ? 'transient' : 'permanent'
    const message =
      verdict.kind === 'uncertain' && this.o.chargeRisk()
        ? `${verdict.message} Não foi possível saber se a chamada foi processada (pode ter sido cobrada); por segurança não foi repetida automaticamente.`
        : retryable
          ? `${verdict.message} (desistiu depois de ${current.attempts} tentativas)`
          : verdict.message
    this.o.update(taskId, { status: 'failed', errorKind: kind, error: message, finishedAt: now })
  }
}
