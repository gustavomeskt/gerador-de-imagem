import { AlertTriangle, CircleDollarSign, FlaskConical, Images, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CONTINUITY_LABELS, type BatchScope, type BatchSettings, type ContinuityMode } from '../../batch/types'
import { MODEL_LABELS, MODEL_QUALITIES, MODEL_SIZES, type ImageModel } from '../../generation/models'
import { isNineSixteen } from '../../batch/format'
import { REFERENCE_SUPPORT } from '../../generation/references'
import { DEFAULT_BATCH_SETTINGS, formatNoteFor, previewBatch, startBatch, type StartResult } from '../../store/batchController'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useFlowStore } from '../../store/useFlowStore'
import type { Storyboard } from '../../story/types'

const BATCH_MODELS: ImageModel[] = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']

// tamanhos verticais oferecidos no lote: 9:16 nativo quando o modelo tem;
// senão o retrato do modelo (2:3), que depois é expandido sem corte
function verticalSizes(model: ImageModel) {
  const sizes = MODEL_SIZES[model]
  const native = sizes.filter((s) => {
    const [w, h] = s.value.split('x').map(Number)
    return isNineSixteen(w, h)
  })
  return native.length ? native : sizes.filter((s) => s.value === '1024x1536')
}

// Antes de gerar: o que vai ser gerado, o que ficou de fora e por quê, as
// opções e o aviso de custo. Nada é chamado até a pessoa confirmar.
export default function BatchDialog({
  board,
  initialScope = 'all',
  onClose,
  onDone,
}: {
  board: Storyboard
  initialScope?: BatchScope
  onClose: () => void
  onDone: (r: StartResult) => void
}) {
  const providerKind = useFlowStore((s) => s.providerKind)
  const library = useCharacterStore((s) => s.characters)
  const [settings, setSettings] = useState<BatchSettings>(() => ({ ...DEFAULT_BATCH_SETTINGS, ...(board.batch?.settings ?? {}) }))
  const [scope, setScope] = useState<BatchScope>(initialScope)
  const [selected, setSelected] = useState<string[]>([])
  const [starting, setStarting] = useState(false)

  const plan = useMemo(
    () => previewBatch(board.projectId, settings, scope, selected),
    // a biblioteca entra na dependência: cadastrar/editar personagem muda o plano
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, settings, scope, selected, library, providerKind],
  )
  const fidelityOptions = REFERENCE_SUPPORT[settings.model]?.fidelity ?? []
  const excluded = plan.scenes.filter((s) => !s.included && s.reason && !['não selecionada', 'já tem imagem', 'imagem não rejeitada'].includes(s.reason))
  const warned = plan.scenes.filter((s) => s.included && s.warnings.length > 0)
  const set = (patch: Partial<BatchSettings>) => setSettings((s) => ({ ...s, ...patch }))

  async function handleStart() {
    setStarting(true)
    const result = await startBatch(board.projectId, settings, scope, selected)
    setStarting(false)
    onDone(result)
    if (result.ok) onClose()
  }

  return (
    <div className="ifs-dialog-backdrop" onClick={onClose}>
      <div className="ifs-dialog ifs-dialog--wide ifs-batch-dialog" role="dialog" aria-modal="true" aria-label="Gerar imagens do storyboard" onClick={(e) => e.stopPropagation()}>
        <div className="ifs-dialog__header">
          <h2>
            <Images size={16} /> Gerar imagens do storyboard
          </h2>
          <button type="button" className="ifs-dialog__close" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </div>

        {providerKind === 'mock' ? (
          <div className="ifs-story-mode ifs-story-mode--sim">
            <FlaskConical size={14} />
            <span>
              <strong>Provedor simulado: as imagens serão FICTÍCIAS</strong> (desenhos de teste com o texto da cena), sem IA e
              sem custo. Servem para conferir o fluxo inteiro.
            </span>
          </div>
        ) : (
          <div className="ifs-story-mode">
            <CircleDollarSign size={14} />
            <span>
              <strong>Backend local.</strong> Ao continuar, o servidor calcula o custo estimado do lote inteiro e você precisa
              confirmar antes de qualquer cobrança. Com o servidor em modo simulado, nada é cobrado e as imagens são fictícias.
            </span>
          </div>
        )}

        <div className="ifs-batch-dialog__grid">
          <fieldset>
            <legend>O que gerar</legend>
            {(
              [
                ['all', 'Todas as cenas aprovadas'],
                ['pending', 'Só as cenas ainda sem imagem'],
                ['rejected', 'Só as imagens rejeitadas na revisão'],
                ['selected', 'Só as cenas que eu escolher'],
              ] as Array<[BatchScope, string]>
            ).map(([value, label]) => (
              <label key={value} className="ifs-radio">
                <input type="radio" name="scope" checked={scope === value} onChange={() => setScope(value)} /> {label}
              </label>
            ))}
            {scope === 'selected' && (
              <div className="ifs-batch-dialog__pick">
                {board.scenes.map((s, i) => (
                  <label key={s.id} className={s.status === 'approved' ? '' : 'ifs-muted'}>
                    <input
                      type="checkbox"
                      checked={selected.includes(s.id)}
                      onChange={(e) => setSelected((list) => (e.target.checked ? [...list, s.id] : list.filter((x) => x !== s.id)))}
                    />{' '}
                    {i + 1}. {s.excerpt.slice(0, 60)}
                    {s.excerpt.length > 60 ? '…' : ''}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend>Modelo e qualidade</legend>
            <label className="ifs-story-field">
              <span>Modelo</span>
              <select
                value={settings.model}
                onChange={(e) => {
                  const model = e.target.value as ImageModel
                  set({ model, size: verticalSizes(model)[0].value, quality: settings.quality })
                }}
              >
                {BATCH_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {MODEL_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="ifs-story-field">
              <span>Tamanho</span>
              <select value={settings.size} onChange={(e) => set({ size: e.target.value })}>
                {verticalSizes(settings.model).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {verticalSizes(settings.model)[0].value === '1024x1536' && (
              <label className="ifs-radio">
                <input type="checkbox" checked={!!settings.autoExpand} onChange={(e) => set({ autoExpand: e.target.checked })} /> Criar a versão 9:16
                expandida automaticamente (sem corte)
              </label>
            )}
            <label className="ifs-story-field">
              <span>Qualidade</span>
              <select value={settings.quality} onChange={(e) => set({ quality: e.target.value })}>
                {(MODEL_QUALITIES[settings.model] ?? []).map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            {fidelityOptions.length > 1 && (
              <label className="ifs-story-field">
                <span>Fidelidade às fotos</span>
                <select value={settings.inputFidelity ?? 'high'} onChange={(e) => set({ inputFidelity: e.target.value as 'high' | 'low' })}>
                  <option value="high">Alta (recomendada para rostos)</option>
                  <option value="low">Baixa (mais barata)</option>
                </select>
              </label>
            )}
            <label className="ifs-story-field">
              <span>Imagens ao mesmo tempo</span>
              <select value={settings.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>Continuidade entre cenas</legend>
            {(Object.keys(CONTINUITY_LABELS) as ContinuityMode[]).map((mode) => (
              <label key={mode} className="ifs-radio">
                <input type="radio" name="continuity" checked={settings.continuity === mode} onChange={() => set({ continuity: mode })} />{' '}
                {CONTINUITY_LABELS[mode]}
              </label>
            ))}
            <small>As fotos dos personagens sempre têm prioridade; a imagem de outra cena só entra se couber no limite.</small>
          </fieldset>
        </div>

        <div className="ifs-batch-dialog__summary" data-testid="batch-summary">
          <p>
            <strong>{plan.summary.images}</strong> imagem(ns) serão geradas — uma por cena, cada uma com o próprio prompt e as
            fotos dos personagens da cena · {MODEL_LABELS[settings.model]} · {settings.size}
          </p>
          <p className="ifs-muted">{formatNoteFor(settings)}</p>
          <ul>
            <li className={plan.summary.storyboardApproved ? 'ifs-ok' : 'ifs-warn'}>
              {plan.summary.storyboardApproved ? 'Storyboard revisado e aprovado.' : `Storyboard ainda não aprovado por completo: ${plan.summary.notApproved} cena(s) não aprovada(s) ficam de fora.`}
            </li>
            {plan.summary.ambiguous.length > 0 && <li className="ifs-warn">Personagens ambíguos (confirme na aba Personagens): {plan.summary.ambiguous.join(', ')}.</li>}
            {plan.summary.unregistered.length > 0 && <li className="ifs-warn">Sem cadastro (vão sem foto de referência): {plan.summary.unregistered.join(', ')}.</li>}
            {plan.summary.blocked > 0 && <li className="ifs-warn">{plan.summary.blocked} cena(s) precisam de revisão e ficam de fora.</li>}
            {plan.summary.flagged > 0 && <li className="ifs-warn">{plan.summary.flagged} cena(s) incluídas têm alertas de revisão no storyboard.</li>}
            {plan.summary.withDependencies > 0 && <li>{plan.summary.withDependencies} cena(s) esperam a cena anterior (continuidade encadeada).</li>}
          </ul>
          {plan.errors.map((e) => (
            <p key={e} className="ifs-image-error">
              {e}
            </p>
          ))}
          {(excluded.length > 0 || warned.length > 0) && (
            <details>
              <summary>
                <AlertTriangle size={12} /> Detalhes por cena ({excluded.length} fora, {warned.length} com aviso)
              </summary>
              <ul className="ifs-batch-dialog__details">
                {excluded.map((s) => (
                  <li key={s.sceneId}>
                    Cena {s.number}: fora — {s.reason}
                    {s.blocking.length ? `: ${s.blocking.join(' ')}` : ''}
                  </li>
                ))}
                {warned.map((s) => (
                  <li key={s.sceneId}>
                    Cena {s.number}: {s.warnings.join(' ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="ifs-dialog__actions">
          <button type="button" className="ifs-btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="ifs-btn-primary" disabled={starting || plan.summary.images === 0} onClick={handleStart}>
            {starting ? <Loader2 size={14} className="ifs-spin" /> : <Images size={14} />}
            {providerKind === 'mock' ? `Gerar ${plan.summary.images} imagem(ns) simuladas` : `Ver custo e gerar ${plan.summary.images} imagem(ns)`}
          </button>
        </div>
      </div>
    </div>
  )
}
