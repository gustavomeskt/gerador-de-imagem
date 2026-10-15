import { describe, expect, it } from 'vitest'
import { ProviderError } from '../../generation/types'
import { classifyGenerationError } from '../errors'
import { GenerationQueue, type QueueOptions, type QueueTask, type TaskPatch } from '../queue'

// Relógio e timers manuais: o teste decide quando o tempo passa.
function harness(
  count: number,
  opts: Partial<QueueOptions> & { deps?: Record<number, number[]>; behavior?: (id: string, attempt: number) => Promise<void> | 'hold' } = {},
) {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let timerId = 0
  const tasks: Array<QueueTask & { error?: string; errorKind?: string }> = Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    status: 'pending',
    attempts: 0,
    dependsOn: (opts.deps?.[i + 1] ?? []).map((d) => `t${d}`),
  }))
  const held = new Map<string, { resolve: () => void; reject: (e: unknown) => void; token: string }>()
  let active = 0
  let maxActive = 0
  const started: string[] = []
  const done: string[] = []
  let idle = 0

  const q = new GenerationQueue({
    getTasks: () => tasks,
    update: (id: string, patch: TaskPatch) => {
      const t = tasks.find((x) => x.id === id)!
      Object.assign(t, patch)
    },
    execute: (id, token) => {
      started.push(id)
      active += 1
      maxActive = Math.max(maxActive, active)
      const t = tasks.find((x) => x.id === id)!
      const outcome = opts.behavior?.(id, t.attempts) ?? 'hold'
      const finish = <T,>(p: Promise<T>) =>
        p.then(
          (v) => {
            active -= 1
            const cur = tasks.find((x) => x.id === id)!
            if (cur.token === token && cur.status === 'running') {
              cur.status = 'done'
              done.push(id)
            }
            return v
          },
          (e) => {
            active -= 1
            throw e
          },
        )
      if (outcome === 'hold') {
        return finish(new Promise<void>((resolve, reject) => held.set(id, { resolve, reject, token })))
      }
      return finish(outcome)
    },
    classify: classifyGenerationError,
    concurrency: () => 2,
    chargeRisk: () => true,
    dependencyFailed: (_id, dep) => `depende de ${dep}`,
    onIdle: () => {
      idle += 1
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++timerId
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
    ...opts,
  })

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    now += ms
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
    await flush()
  }
  const release = async (id: string, err?: unknown) => {
    const h = held.get(id)!
    held.delete(id)
    if (err) h.reject(err)
    else h.resolve()
    await flush()
  }
  return { q, tasks, started, done, held, release, advance, flush, stats: () => ({ maxActive, idle }) }
}

const status = (h: ReturnType<typeof harness>) => h.tasks.map((t) => t.status)

describe('fila de geração', () => {
  it('respeita o limite de chamadas simultâneas e processa tudo em ordem', async () => {
    const h = harness(5)
    h.q.start()
    expect(h.started).toEqual(['t1', 't2'])
    await h.release('t1')
    expect(h.started).toEqual(['t1', 't2', 't3'])
    for (const id of ['t2', 't3', 't4', 't5']) await h.release(id)
    expect(h.done).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(h.stats()).toEqual({ maxActive: 2, idle: 1 })
  })

  it('dependência: a cena espera a anterior; se a anterior falha, a dependente não roda', async () => {
    const h = harness(3, { deps: { 2: [1], 3: [2] } })
    h.q.start()
    expect(h.started).toEqual(['t1'])
    await h.release('t1')
    expect(h.started).toEqual(['t1', 't2'])
    await h.release('t2', new ProviderError('Pedido recusado.', { status: 422, code: 'upstream_rejected' }))
    expect(status(h)).toEqual(['done', 'failed', 'failed'])
    expect(h.tasks[2]).toMatchObject({ errorKind: 'dependency', error: 'depende de t2' })
  })

  it('limite de requisições: espera progressiva (Retry-After) e segura a fila toda', async () => {
    const h = harness(2, { concurrency: () => 1 })
    h.q.start()
    await h.release('t1', new ProviderError('Limite.', { status: 429, code: 'upstream_rate_limited', retryAfterMs: 20_000 }))
    expect(h.tasks[0]).toMatchObject({ status: 'pending', errorKind: 'transient', nextAttemptAt: 20_000 })
    expect(h.tasks[0].error).toMatch(/Nova tentativa em 20 s \(tentativa 2 de 3\)/)
    expect(h.started).toEqual(['t1']) // t2 também espera (fila segurada)
    await h.advance(19_000)
    expect(h.started).toEqual(['t1'])
    await h.advance(1_000)
    expect(h.started).toEqual(['t1', 't1'])
    await h.release('t1')
    await h.release('t2')
    expect(status(h)).toEqual(['done', 'done'])
  })

  it('falha transitória repetida desiste depois do máximo de tentativas, com espera crescente', async () => {
    const h = harness(1, { baseDelayMs: 1000 })
    h.q.start()
    const busy = () => new ProviderError('Ocupado.', { status: 429, code: 'server_busy' })
    await h.release('t1', busy())
    expect(h.tasks[0].nextAttemptAt).toBe(1000)
    await h.advance(1000)
    await h.release('t1', busy())
    expect(h.tasks[0].nextAttemptAt).toBe(1000 + 2000)
    await h.advance(2000)
    await h.release('t1', busy())
    expect(h.tasks[0]).toMatchObject({ status: 'failed', attempts: 3 })
    expect(h.tasks[0].error).toMatch(/desistiu depois de 3 tentativas/)
  })

  it('resultado incerto com provedor pago: NÃO repete (evita cobrança duplicada)', async () => {
    const h = harness(1)
    h.q.start()
    await h.release('t1', new ProviderError('A OpenAI não respondeu em 180 s.', { status: 504, code: 'upstream_timeout' }))
    expect(h.tasks[0]).toMatchObject({ status: 'failed', errorKind: 'uncertain', attempts: 1 })
    expect(h.tasks[0].error).toMatch(/pode ter sido cobrada/)
    expect(h.started).toEqual(['t1'])
  })

  it('resultado incerto sem custo (simulado): pode repetir', async () => {
    const h = harness(1, { chargeRisk: () => false })
    h.q.start()
    await h.release('t1', new ProviderError('Sem conexão.', { code: 'network_error' }))
    expect(h.tasks[0].status).toBe('pending')
    await h.advance(2000)
    await h.release('t1')
    expect(h.tasks[0].status).toBe('done')
  })

  it('erro definitivo falha na hora, sem novas tentativas', async () => {
    const h = harness(2)
    h.q.start()
    await h.release('t1', new ProviderError('Prompt recusado.', { status: 422, code: 'upstream_rejected' }))
    expect(h.tasks[0]).toMatchObject({ status: 'failed', errorKind: 'permanent', attempts: 1 })
  })

  it('pausar: as em andamento terminam, nenhuma nova começa; retomar continua de onde parou', async () => {
    const h = harness(4)
    h.q.start()
    h.q.pause()
    await h.release('t1')
    await h.release('t2')
    expect(h.started).toEqual(['t1', 't2'])
    expect(status(h)).toEqual(['done', 'done', 'pending', 'pending'])
    h.q.resume()
    expect(h.started).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('resposta atrasada de uma tentativa antiga é ignorada', async () => {
    const h = harness(1)
    h.q.start()
    // a tarefa foi cancelada e refeita enquanto a chamada antiga estava no ar
    h.tasks[0].token = 'outra-tentativa'
    await h.release('t1', new ProviderError('Limite.', { status: 429, code: 'rate_limited' }))
    expect(h.tasks[0]).toMatchObject({ status: 'running', token: 'outra-tentativa' })
    expect(h.done).toEqual([])
  })

  it('não começa tarefa sem autorização (canStart)', async () => {
    const allowed = new Set(['t2'])
    const h = harness(2, { canStart: (id) => allowed.has(id) })
    h.q.start()
    expect(h.started).toEqual(['t2'])
  })
})
