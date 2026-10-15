import { FlaskConical, Loader2, Save, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useFlowStore } from '../../store/useFlowStore'
import { useStoryStore } from '../../store/useStoryStore'
import type { Storyboard } from '../../story/types'

function formatDate(ts: number) {
  return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export default function StoryCopyTab({
  board,
  onInterpret,
}: {
  board: Storyboard
  onInterpret: () => void
}) {
  const saveCopy = useStoryStore((s) => s.saveCopy)
  const busy = useStoryStore((s) => s.busy[board.projectId] ?? null)
  const providerKind = useFlowStore((s) => s.providerKind)
  const [draft, setDraft] = useState(board.copy)
  const [source, setSource] = useState(board.copy)
  if (source !== board.copy) {
    setSource(board.copy)
    setDraft(board.copy)
  }

  const dirty = draft !== board.copy
  const empty = !draft.trim()

  function handleInterpret() {
    if (dirty) saveCopy(board.projectId, draft)
    onInterpret()
  }

  return (
    <div className="ifs-story-copy">
      <div className={providerKind === 'backend' ? 'ifs-story-mode' : 'ifs-story-mode ifs-story-mode--sim'}>
        <FlaskConical size={14} />
        {providerKind === 'backend' ? (
          <span>
            <strong>Interpretação pelo backend local.</strong> Antes de qualquer chamada o custo é mostrado e precisa ser
            confirmado. Com o servidor em modo simulado, a interpretação é feita por regras, sem IA e sem custo.
          </span>
        ) : (
          <span>
            <strong>INTERPRETAÇÃO SIMULADA</strong> — regras locais, sem IA e sem custo. Serve para testar o fluxo; revise
            todas as cenas. Para usar um modelo de linguagem, escolha o provedor “Backend” nas configurações.
          </span>
        )}
      </div>

      <label className="ifs-story-copy__label" htmlFor="ifs-story-copy">
        Copy da historinha (texto original — o app nunca altera este texto)
      </label>
      <textarea
        id="ifs-story-copy"
        className="ifs-story-copy__text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Cole aqui a copy completa da historinha…"
        spellCheck={false}
      />
      <div className="ifs-story-copy__bar">
        <small>
          {draft.length.toLocaleString('pt-BR')} caracteres ·{' '}
          {dirty ? 'alterações não salvas' : board.copySavedAt ? `salva em ${formatDate(board.copySavedAt)}` : 'ainda não salva'}
        </small>
        <div className="ifs-story-copy__actions">
          <button type="button" className="ifs-btn-secondary" disabled={!dirty || empty} onClick={() => saveCopy(board.projectId, draft)}>
            <Save size={14} /> Salvar copy
          </button>
          <button type="button" className="ifs-btn-primary" disabled={empty || !!busy} onClick={handleInterpret}>
            {busy ? <Loader2 size={14} className="ifs-spin" /> : <Sparkles size={14} />}
            {busy ?? (board.scenes.length ? 'Reinterpretar' : 'Interpretar historinha')}
          </button>
        </div>
      </div>
      {board.scenes.length > 0 && (
        <p className="ifs-story-copy__note">
          Reinterpretar mantém as cenas <strong>aprovadas</strong> exatamente como estão; as demais são substituídas, e a
          versão atual fica guardada em “Versões anteriores” no storyboard.
          {dirty && ' Ao salvar a copy alterada, cada cena é reencontrada no texto novo; as que não forem achadas ficam sinalizadas.'}
        </p>
      )}

      {board.interpretation && (
        <div className="ifs-story-copy__meta">
          <p>
            Última interpretação: {formatDate(board.interpretation.at)} ·{' '}
            {board.interpretation.mode === 'simulated' ? (
              <strong className="ifs-story-badge ifs-story-badge--sim">SIMULADA</strong>
            ) : (
              <strong className="ifs-story-badge ifs-story-badge--ai">IA</strong>
            )}{' '}
            · {board.interpretation.model}
          </p>
          {board.interpretation.warnings.length > 0 && (
            <ul>
              {board.interpretation.warnings.slice(0, 30).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {board.interpretation.warnings.length > 30 && <li>… e mais {board.interpretation.warnings.length - 30} aviso(s).</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
