import { BACKEND_UNAVAILABLE_MESSAGE, QUOTE_HEADER } from '../generation/backendProvider'
import type { CostQuote } from '../generation/types'
import { simulateInterpretation, SIMULATED_MODEL } from './simulatedInterpreter'
import type { RawInterpretation } from './types'

// Quem interpreta a historinha:
//   • local simulado — regras no navegador, grátis (provedor "Simulado")
//   • backend — rota /api/story/* do servidor local; em modo simulado do
//     servidor também é fictício; em modo openai usa um modelo de linguagem
//     (pago, com orçamento e confirmação).

export interface InterpretationOutput {
  raw: RawInterpretation
  mode: 'simulated' | 'openai'
  model: string
  warnings: string[]
}

export interface StoryInterpreter {
  readonly label: string
  quote?(copy: string, libraryNames: string[]): Promise<CostQuote>
  interpret(copy: string, libraryNames: string[], options?: { quoteId?: string }): Promise<InterpretationOutput>
}

export class InterpreterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterpreterError'
  }
}

export function createLocalSimulatedInterpreter(): StoryInterpreter {
  return {
    label: 'Interpretação simulada (regras locais, sem IA)',
    async interpret(copy, libraryNames) {
      return { raw: simulateInterpretation(copy, libraryNames), mode: 'simulated', model: SIMULATED_MODEL, warnings: [] }
    },
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.error?.message === 'string' ? body.error.message : fallback
  } catch {
    return fallback
  }
}

export function createBackendInterpreter(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): StoryInterpreter {
  const base = options.baseUrl ?? '/api'
  async function post(path: string, body: unknown, quoteId?: string): Promise<unknown> {
    const fetchImpl = options.fetchImpl ?? fetch
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(quoteId ? { [QUOTE_HEADER]: quoteId } : {}) },
        body: JSON.stringify(body),
      })
    } catch {
      throw new InterpreterError(BACKEND_UNAVAILABLE_MESSAGE)
    }
    if ([404, 502, 503, 504].includes(res.status)) throw new InterpreterError(await errorMessage(res, BACKEND_UNAVAILABLE_MESSAGE))
    if (!res.ok) throw new InterpreterError(await errorMessage(res, `Erro ${res.status} na interpretação`))
    return res.json()
  }

  return {
    label: 'Interpretação pelo backend local',
    async quote(copy, libraryNames) {
      return (await post('/story/quote', { copy, libraryNames })) as CostQuote
    },
    async interpret(copy, libraryNames, opts) {
      const data = (await post('/story/interpret', { copy, libraryNames }, opts?.quoteId)) as Partial<InterpretationOutput> & {
        interpretation?: unknown
      }
      if (!data?.interpretation || (data.mode !== 'simulated' && data.mode !== 'openai')) {
        throw new InterpreterError('Resposta inválida do backend na interpretação.')
      }
      return {
        raw: data.interpretation as RawInterpretation,
        mode: data.mode,
        model: typeof data.model === 'string' ? data.model : 'desconhecido',
        warnings: Array.isArray(data.warnings) ? data.warnings.filter((w): w is string => typeof w === 'string') : [],
      }
    },
  }
}
