import { ProviderError } from '../generation/types'
import type { ErrorVerdict } from './queue'

// Classifica um erro de geração para a fila decidir se pode tentar de novo.
//   transient — certamente nada foi gerado/cobrado; tentar de novo é seguro
//   uncertain — não dá para saber se a chamada foi processada
//   permanent — repetir não adianta (pedido inválido, autorização, etc.)

const TRANSIENT_CODES = new Set(['server_busy', 'rate_limited', 'upstream_rate_limited'])
const RATE_CODES = new Set(['rate_limited', 'upstream_rate_limited'])
const UNCERTAIN_CODES = new Set(['upstream_timeout', 'upstream_unreachable', 'upstream_error', 'upstream_invalid', 'network_error', 'internal_error'])

export function classifyGenerationError(err: unknown): ErrorVerdict {
  const message = err instanceof Error && err.message ? err.message : 'Falha ao gerar a imagem.'
  // (confere pelo formato, não por instanceof: o erro pode vir de outro
  // pacote/instância do módulo)
  if (err instanceof ProviderError || (err instanceof Error && err.name === 'ProviderError')) {
    const e = err as ProviderError
    const code = e.code ?? ''
    if (TRANSIENT_CODES.has(code) || (e.status === 429 && !code)) {
      return { kind: 'transient', message, retryAfterMs: e.retryAfterMs, rateLimited: RATE_CODES.has(code) || e.status === 429 }
    }
    if (UNCERTAIN_CODES.has(code) || (e.status !== undefined && e.status >= 500)) return { kind: 'uncertain', message }
    if (e.status !== undefined) return { kind: 'permanent', message }
    // ProviderError sem status: veio do provedor simulado do navegador
    return { kind: 'permanent', message }
  }
  // erro inesperado no navegador (ex.: falha ao ler uma foto)
  return { kind: 'permanent', message }
}
