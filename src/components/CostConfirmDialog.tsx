import { CircleDollarSign, FlaskConical } from 'lucide-react'
import { useEffect } from 'react'
import { useFlowStore } from '../store/useFlowStore'

function formatUsd(value: number): string {
  return value < 0.01 && value > 0 ? '< US$ 0,01' : `US$ ${value.toFixed(2).replace('.', ',')}`
}

// Confirmação explícita antes de qualquer chamada paga: mostra a estimativa
// do servidor e só segue se a pessoa clicar em confirmar. Fechar, apertar Esc
// ou cancelar não faz nenhuma chamada.
export default function CostConfirmDialog() {
  const request = useFlowStore((s) => s.costConfirmation)
  const resolve = useFlowStore((s) => s.resolveCostConfirmation)

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && resolve(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, resolve])

  if (!request) return null
  const { quote, title } = request

  return (
    <div className="ifs-dialog-backdrop" onClick={() => resolve(false)}>
      <div
        className="ifs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ifs-cost-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={quote.paid ? 'ifs-dialog__badge ifs-dialog__badge--paid' : 'ifs-dialog__badge'}>
          {quote.paid ? <CircleDollarSign size={14} /> : <FlaskConical size={14} />}
          {quote.paid ? 'Chamada paga à OpenAI' : 'Servidor em modo simulado — sem cobrança'}
        </div>

        <h2 id="ifs-cost-title">{title}</h2>

        <div className="ifs-dialog__cost">
          <span>{quote.paid ? 'Custo estimado' : 'Custaria (estimativa)'}</span>
          <strong>{formatUsd(quote.estimatedUsd)}</strong>
        </div>

        <ul className="ifs-dialog__breakdown">
          {quote.breakdown.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {quote.notes.length > 0 && (
          <ul className="ifs-dialog__notes">
            {quote.notes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        <div className="ifs-dialog__actions">
          <button type="button" className="ifs-dialog__cancel" onClick={() => resolve(false)}>
            Cancelar
          </button>
          <button type="button" className="ifs-btn-primary" autoFocus onClick={() => resolve(true)}>
            {quote.paid ? `Confirmar e pagar ~${formatUsd(quote.estimatedUsd)}` : 'Confirmar (simulado)'}
          </button>
        </div>
      </div>
    </div>
  )
}
