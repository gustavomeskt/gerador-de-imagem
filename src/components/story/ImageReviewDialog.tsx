import { Check, Maximize2, RefreshCw, Star, X, XCircle, ZoomIn } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FORMAT_LABELS, MAX_REFRAME_LOSS, reframeRect } from '../../batch/format'
import { officialVersion } from '../../batch/planner'
import { autoChecks, buildChecklist, reviewOf } from '../../batch/review'
import { PROBLEM_LABELS, type ChecklistAnswer, type ProblemTag, type SceneImageVersion } from '../../batch/types'
import { orderedPhotos } from '../../generation/characters'
import {
  adjustFormat,
  analyzeVersionPixels,
  approveVersion,
  formatMethodOf,
  regenerateScene,
  rejectVersion,
  reviewImage,
  setOfficialImage,
} from '../../store/batchController'
import { useCharacterStore } from '../../store/useCharacterStore'
import type { Storyboard, StoryScene } from '../../story/types'
import { useAssetSrc } from './useAssetSrc'

type Notify = (text: string, error?: boolean) => void
type Compare = { kind: 'none' } | { kind: 'version'; id: string } | { kind: 'selfie'; characterId: string; photoId: string } | { kind: 'scene'; sceneId: string }
type Zoom = 1 | 2 | 4

// Imagem ampliável: em 2× e 4× dá para rolar e conferir rosto, mãos e objetos.
function ZoomImage({ src, label, zoom, overlay }: { src?: string; label: string; zoom: Zoom; overlay?: { left: number; top: number; width: number; height: number } }) {
  return (
    <figure className="ifs-review__figure">
      <figcaption>{label}</figcaption>
      <div className="ifs-review__scroll">
        {src ? (
          <div className="ifs-review__frame" style={{ width: `${zoom * 100}%` }}>
            <img src={src} alt={label} />
            {overlay && (
              <div
                className="ifs-review__overlay"
                style={{ left: `${overlay.left}%`, top: `${overlay.top}%`, width: `${overlay.width}%`, height: `${overlay.height}%` }}
                title="Área que ficaria no reenquadramento"
              />
            )}
          </div>
        ) : (
          <span className="ifs-muted">carregando…</span>
        )}
      </div>
    </figure>
  )
}

function VersionImage({ version, label, zoom, overlay }: { version: SceneImageVersion; label: string; zoom: Zoom; overlay?: Parameters<typeof ZoomImage>[0]['overlay'] }) {
  const { ref, src } = useAssetSrc(version.assetId, version.src)
  return (
    <div ref={ref} className="ifs-review__col">
      <ZoomImage src={src} label={label} zoom={zoom} overlay={overlay} />
    </div>
  )
}

export default function ImageReviewDialog({
  board,
  scene,
  number,
  initialVersionId,
  onClose,
  onMessage,
}: {
  board: Storyboard
  scene: StoryScene
  number: number
  initialVersionId?: string
  onClose: () => void
  onMessage: Notify
}) {
  const library = useCharacterStore((s) => s.characters)
  const versions = useMemo(() => scene.images ?? [], [scene.images])
  const official = officialVersion(scene)
  const [selectedId, setSelectedIdRaw] = useState<string | undefined>(initialVersionId ?? official?.id ?? versions.at(-1)?.id)
  const selected = versions.find((v) => v.id === selectedId) ?? official ?? versions.at(-1)
  const [compare, setCompare] = useState<Compare>({ kind: 'none' })
  const [zoom, setZoom] = useState<Zoom>(1)
  const [problems, setProblems] = useState<ProblemTag[]>(() => reviewOf(selected).problems)
  const [note, setNote] = useState(() => reviewOf(selected).note)
  const [reframe, setReframe] = useState<number | null>(null)
  // trocar de versão recomeça a marcação de problemas daquela versão
  function setSelectedId(id: string | undefined) {
    setSelectedIdRaw(id)
    const v = versions.find((x) => x.id === id)
    setProblems(reviewOf(v).problems)
    setNote(reviewOf(v).note)
    setReframe(null)
  }

  // imagem sem análise de pixels (ex.: o app fechou logo depois de gerar): faz agora
  const pendingAnalysis = selected && !selected.analysis ? selected.id : null
  useEffect(() => {
    if (pendingAnalysis) void analyzeVersionPixels(board.projectId, scene.id, pendingAnalysis)
  }, [pendingAnalysis, board.projectId, scene.id])

  const cast = scene.characterKeys
    .map((k) => board.characters.find((c) => c.key === k))
    .map((c) => (c?.libraryId ? library.find((l) => l.id === c.libraryId) : undefined))
    .filter((c): c is NonNullable<typeof c> => !!c)
  const otherScenes = board.scenes
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.id !== scene.id && officialVersion(s) && s.characterKeys.some((k) => scene.characterKeys.includes(k)))

  if (!selected) {
    return null
  }
  const review = reviewOf(selected)
  const checklist = buildChecklist(scene, board)
  const checks = autoChecks(selected)
  const method = formatMethodOf(selected)
  const rect = reframe !== null && selected.width && selected.height ? reframeRect(selected.width, selected.height, reframe) : null
  const overlay = rect
    ? { left: (rect.sx / selected.width!) * 100, top: (rect.sy / selected.height!) * 100, width: (rect.sw / selected.width!) * 100, height: (rect.sh / selected.height!) * 100 }
    : undefined

  function answer(id: string, value: ChecklistAnswer) {
    reviewImage(board.projectId, scene.id, selected!.id, { checklist: { ...review.checklist, [id]: value } })
  }

  function approve() {
    let r = approveVersion(board.projectId, scene.id, selected!.id)
    if (!r.ok && r.needsConfirmation && window.confirm(r.error)) r = approveVersion(board.projectId, scene.id, selected!.id, { confirmReplace: true })
    if (r.ok) onMessage(`Imagem da cena ${number} aprovada.`)
    else if (!r.needsConfirmation) onMessage(r.error, true)
  }

  function reject() {
    let r = rejectVersion(board.projectId, scene.id, selected!.id, problems, note)
    if (!r.ok && r.needsConfirmation && window.confirm(r.error)) r = rejectVersion(board.projectId, scene.id, selected!.id, problems, note, { confirmApproved: true })
    if (r.ok) onMessage(`Imagem da cena ${number} rejeitada. Use "Regenerar só as rejeitadas" ou regenere esta cena.`)
  }

  async function adjust(kind: 'expanded' | 'reframed') {
    if (scene.imageApprovedAt && scene.officialImageId === selected!.id && !window.confirm('Esta imagem está aprovada. A versão 9:16 nova vira a oficial e precisará ser aprovada de novo. Continuar?')) return
    let r = await adjustFormat(board.projectId, scene.id, selected!.id, kind, { offset: reframe ?? 0.5 })
    if (!r.ok && r.needsConfirmation && window.confirm(`${r.error}\n\nConfirmar o corte?`)) {
      r = await adjustFormat(board.projectId, scene.id, selected!.id, kind, { offset: reframe ?? 0.5, confirmLoss: true })
    }
    if (r.ok) {
      setSelectedId(r.versionId)
      setReframe(null)
      onMessage(`Versão ${FORMAT_LABELS[kind]} criada para a cena ${number}. A original continua guardada.`)
    } else if (!r.needsConfirmation) onMessage(r.error, true)
  }

  let compareView: React.ReactNode = null
  if (compare.kind === 'version') {
    const v = versions.find((x) => x.id === compare.id)
    if (v) compareView = <VersionImage version={v} label={`Versão v${versions.indexOf(v) + 1}`} zoom={zoom} />
  } else if (compare.kind === 'scene') {
    const other = board.scenes.find((s) => s.id === compare.sceneId)
    const v = other && officialVersion(other)
    if (v) compareView = <VersionImage version={v} label={`Cena ${board.scenes.indexOf(other!) + 1} (oficial)`} zoom={zoom} />
  } else if (compare.kind === 'selfie') {
    const c = library.find((l) => l.id === compare.characterId)
    const p = c?.photos.find((x) => x.id === compare.photoId)
    compareView = (
      <div className="ifs-review__col">
        <ZoomImage src={p?.src} label={`Foto original de ${c?.name ?? '?'}`} zoom={zoom} />
      </div>
    )
  }

  return (
    <div className="ifs-dialog-backdrop" onClick={onClose}>
      <div className="ifs-dialog ifs-review" role="dialog" aria-modal="true" aria-label={`Revisar imagem da cena ${number}`} onClick={(e) => e.stopPropagation()}>
        <div className="ifs-dialog__header">
          <h2>
            Revisar imagem — cena {number}
            {selected.simulated && <span className="ifs-thumb__badge ifs-review__sim">IMAGEM SIMULADA (fictícia)</span>}
          </h2>
          <button type="button" className="ifs-dialog__close" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </div>
        <blockquote className="ifs-images__quote">{scene.excerpt}</blockquote>

        <div className="ifs-review__toolbar">
          <label>
            Versão:{' '}
            <select value={selected.id} onChange={(e) => setSelectedId(e.target.value)} aria-label="Versão em revisão">
              {versions.map((v, i) => (
                <option key={v.id} value={v.id}>
                  v{i + 1} {v.id === official?.id ? '★ oficial' : ''} · {FORMAT_LABELS[formatMethodOf(v)]} · {reviewOf(v).status === 'approved' ? 'aprovada' : reviewOf(v).status === 'rejected' ? 'rejeitada' : 'a revisar'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Comparar com:{' '}
            <select
              aria-label="Comparar com"
              value={compare.kind === 'none' ? '' : compare.kind === 'version' ? `v:${compare.id}` : compare.kind === 'scene' ? `s:${compare.sceneId}` : `f:${compare.characterId}:${compare.photoId}`}
              onChange={(e) => {
                const [kind, a, b] = e.target.value.split(':')
                setCompare(kind === 'v' ? { kind: 'version', id: a } : kind === 's' ? { kind: 'scene', sceneId: a } : kind === 'f' ? { kind: 'selfie', characterId: a, photoId: b } : { kind: 'none' })
              }}
            >
              <option value="">nada</option>
              {cast.flatMap((c) =>
                orderedPhotos(c)
                  .filter((p) => !p.missing)
                  .map((p, i) => (
                    <option key={p.id} value={`f:${c.id}:${p.id}`}>
                      Foto original de {c.name}{i === 0 ? ' (principal)' : ` (${i + 1})`}
                    </option>
                  )),
              )}
              {versions
                .filter((v) => v.id !== selected.id)
                .map((v) => (
                  <option key={v.id} value={`v:${v.id}`}>
                    Outra versão: v{versions.indexOf(v) + 1}
                  </option>
                ))}
              {otherScenes.map(({ s, i }) => (
                <option key={s.id} value={`s:${s.id}`}>
                  Cena {i + 1} (mesmo personagem)
                </option>
              ))}
            </select>
          </label>
          <span className="ifs-review__zoom">
            <ZoomIn size={14} />
            {([1, 2, 4] as Zoom[]).map((z) => (
              <button key={z} type="button" className={zoom === z ? 'ifs-btn-primary' : 'ifs-btn-secondary'} onClick={() => setZoom(z)}>
                {z === 1 ? <Maximize2 size={12} /> : `${z}×`}
              </button>
            ))}
          </span>
        </div>

        <div className="ifs-review__body">
          <div className={compareView ? 'ifs-review__stage ifs-review__stage--two' : 'ifs-review__stage'}>
            <VersionImage version={selected} label={`v${versions.indexOf(selected) + 1}${selected.id === official?.id ? ' ★ oficial' : ''} — ${selected.width}×${selected.height}`} zoom={zoom} overlay={overlay} />
            {compareView}
          </div>

          <aside className="ifs-review__side">
            <section>
              <h4>Verificação automática (pixels da imagem)</h4>
              <ul className="ifs-review__checks">
                {checks.map((c) => (
                  <li key={c.id} className={`ifs-check--${c.result}`}>
                    <strong>{c.result === 'ok' ? '✓' : c.result === 'warning' ? '!' : '?'} {c.label}:</strong> {c.detail}
                  </li>
                ))}
              </ul>
              <small className="ifs-muted">Indicadores técnicos. Não provam que o rosto, a roupa ou a ação estão certos — isso é revisão humana (abaixo).</small>
            </section>

            {method === 'unadjusted' && (
              <section>
                <h4>Formato 9:16</h4>
                <p className="ifs-muted">{selected.format.note}</p>
                <div className="ifs-scene-image__actions">
                  <button type="button" className="ifs-btn-primary" onClick={() => adjust('expanded')}>
                    Expandir para 9:16 (sem corte)
                  </button>
                  <button type="button" className="ifs-btn-secondary" onClick={() => setReframe(reframe === null ? 0.5 : null)}>
                    {reframe === null ? 'Reenquadrar…' : 'Cancelar reenquadramento'}
                  </button>
                </div>
                {rect && (
                  <div className="ifs-review__reframe">
                    <label>
                      Posição do corte
                      <input type="range" min={0} max={1} step={0.05} value={reframe ?? 0.5} onChange={(e) => setReframe(Number(e.target.value))} />
                    </label>
                    <small className={rect.lossPercent > MAX_REFRAME_LOSS ? 'ifs-warn' : 'ifs-muted'}>
                      Fica de fora: {rect.lossPercent}% (esquerda {rect.lost.left}px, direita {rect.lost.right}px, topo {rect.lost.top}px, base {rect.lost.bottom}px). Confira se nenhum rosto, mão ou objeto fica fora do quadro verde.
                    </small>
                    <button type="button" className="ifs-btn-secondary" onClick={() => adjust('reframed')}>
                      Reenquadrar (corta {rect.lossPercent}%)
                    </button>
                  </div>
                )}
              </section>
            )}

            <section>
              <h4>Revisão humana</h4>
              <ul className="ifs-review__list">
                {checklist.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.label}
                      {item.detail && <small> — {item.detail}</small>}
                    </span>
                    <span className="ifs-review__answers">
                      {(['ok', 'problem', 'na'] as ChecklistAnswer[]).map((a) => (
                        <button key={a} type="button" className={review.checklist[item.id] === a ? `ifs-answer ifs-answer--${a} ifs-answer--on` : 'ifs-answer'} onClick={() => answer(item.id, a)}>
                          {a === 'ok' ? 'OK' : a === 'problem' ? 'Problema' : 'N/A'}
                        </button>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h4>Problemas encontrados</h4>
              <div className="ifs-review__tags">
                {(Object.keys(PROBLEM_LABELS) as ProblemTag[]).map((tag) => (
                  <label key={tag} className={problems.includes(tag) ? 'ifs-tag ifs-tag--on' : 'ifs-tag'}>
                    <input type="checkbox" checked={problems.includes(tag)} onChange={(e) => setProblems((p) => (e.target.checked ? [...p, tag] : p.filter((x) => x !== tag)))} />
                    {PROBLEM_LABELS[tag]}
                  </label>
                ))}
              </div>
              <textarea className="ifs-review__note" rows={2} placeholder="Observação (opcional)" value={note} onChange={(e) => setNote(e.target.value)} />
            </section>

            <div className="ifs-review__decision">
              <span className="ifs-muted">
                Estado: {review.status === 'approved' ? 'aprovada' : review.status === 'rejected' ? `rejeitada (${review.problems.map((p) => PROBLEM_LABELS[p]).join(', ') || 'sem motivo marcado'})` : 'a revisar'}
              </span>
              <button type="button" className="ifs-btn-primary" onClick={approve}>
                <Check size={14} /> Aprovar esta imagem
              </button>
              <button type="button" className="ifs-btn-secondary" onClick={reject}>
                <XCircle size={14} /> Rejeitar
              </button>
              {selected.id !== official?.id && (
                <button
                  type="button"
                  className="ifs-btn-secondary"
                  onClick={() => {
                    if (!scene.imageApprovedAt || window.confirm('A imagem oficial atual está aprovada. Trocar? (A atual continua guardada.)')) setOfficialImage(board.projectId, scene.id, selected.id)
                  }}
                >
                  <Star size={14} /> Tornar oficial
                </button>
              )}
              <button
                type="button"
                className="ifs-btn-secondary"
                disabled={scene.status !== 'approved'}
                onClick={async () => {
                  const r = await regenerateScene(board.projectId, scene.id)
                  onMessage(r.ok ? `Nova versão da cena ${number} na fila. A atual continua guardada.` : r.error, !r.ok && !r.cancelled)
                }}
              >
                <RefreshCw size={14} /> Regenerar esta cena
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
