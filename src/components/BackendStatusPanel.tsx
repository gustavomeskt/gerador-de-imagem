import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { BackendStatus } from '../generation/backendProvider'
import { backendProvider } from '../generation/providers'

// Mostra o que o servidor local informa: modo, se há chave configurada (só
// sim/não — a chave nunca sai do servidor), limites e consumo do dia.
export default function BackendStatusPanel() {
  const [status, setStatus] = useState<BackendStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    let active = true
    backendProvider.fetchStatus().then(
      (result) => {
        if (!active) return
        setStatus(result)
        setError(null)
      },
      (err: unknown) => {
        if (!active) return
        setStatus(null)
        setError(err instanceof Error ? err.message : 'Servidor indisponível.')
      },
    )
    return () => {
      active = false
    }
  }, [version])

  return (
    <div className="ifs-backend-status">
      <div className="ifs-backend-status__head">
        <strong>Servidor local</strong>
        <button type="button" onClick={refresh} title="Atualizar status">
          <RefreshCw size={13} />
        </button>
      </div>
      {error && <p className="ifs-backend-status__error">{error}</p>}
      {status && (
        <dl>
          <dt>Modo</dt>
          <dd>
            {status.mode === 'openai' ? (
              <span className="ifs-backend-status__paid">OpenAI real (pago, com confirmação)</span>
            ) : (
              'Simulado (sem chamadas à OpenAI)'
            )}
          </dd>
          <dt>Chave da OpenAI</dt>
          <dd>{status.keyConfigured ? 'Configurada no servidor' : 'Não configurada'}</dd>
          <dt>Uso hoje</dt>
          <dd>
            {status.usageToday.images} de {status.limits.dailyImageLimit} imagens · US$ {status.usageToday.estimatedUsd.toFixed(2)} de
            US$ {status.limits.dailyBudgetUsd.toFixed(2)} (estimado)
          </dd>
          <dt>Limites</dt>
          <dd>
            até US$ {status.limits.maxCostPerJobUsd.toFixed(2)} por geração · {status.limits.maxRequestsPerMinute} req/min ·{' '}
            {status.limits.maxConcurrent} simultâneas
          </dd>
          <dt>Modelos</dt>
          <dd>{status.allowedModels.join(', ')}</dd>
          {status.referenceModels && (
            <>
              <dt>Referências</dt>
              <dd>
                até {status.limits.maxReferenceImages} fotos de até{' '}
                {Math.round((status.limits.maxReferenceBytes ?? 0) / 1024 / 1024)} MB por geração ·{' '}
                {status.referenceModels.length ? status.referenceModels.join(', ') : 'nenhum modelo permitido aceita'}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}
