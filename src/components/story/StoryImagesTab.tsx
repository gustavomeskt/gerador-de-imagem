import { FileArchive, Images, Loader2, Pause, Play, RotateCcw, XCircle } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { officialVersion } from '../../batch/planner'
import { IMAGE_STATE_LABELS, type SceneImageState } from '../../batch/types'
import { isOutdated, sceneImageState, taskForScene } from '../../batch/versions'
import { exportProjectZip } from '../../export/exportProject'
import { cancelPending, pauseBatch, resumeBatch, retryFailed } from '../../store/batchController'
import type { Storyboard, StoryScene } from '../../story/types'
import BatchDialog from './BatchDialog'
import { SceneImageActions, SceneImagePanel, VersionThumb } from './SceneImage'

type Notify = (text: string, error?: boolean) => void

const ImageCard = memo(function ImageCard({
  board,
  scene,
  number,
  state,
  names,
  onOpen,
  onMessage,
}: {
  board: Storyboard
  scene: StoryScene
  number: number
  state: SceneImageState
  names: string
  onOpen: (id: string) => void
  onMessage: Notify
}) {
  const official = officialVersion(scene)
  const task = taskForScene(board.batch, scene.id)
  return (
    <li className={`ifs-image-card ifs-image-card--${state}`} data-testid="image-card">
      <button type="button" className="ifs-image-card__open" onClick={() => onOpen(scene.id)} title="Ver versões e detalhes">
        <VersionThumb version={official} alt={`Cena ${number}`} />
        {state === 'running' && (
          <span className="ifs-image-card__overlay">
            <Loader2 size={18} className="ifs-spin" /> gerando…
          </span>
        )}
      </button>
      <div className="ifs-image-card__body">
        <div className="ifs-image-card__head">
          <strong>Cena {number}</strong>
          <span className={`ifs-image-state ifs-image-state--${state}`}>{IMAGE_STATE_LABELS[state]}</span>
          {(scene.images?.length ?? 0) > 1 && <small>{scene.images!.length} versões</small>}
        </div>
        <small className="ifs-image-card__names">{names || 'sem personagens'}</small>
        <p className="ifs-image-card__excerpt">{scene.excerpt}</p>
        {official && isOutdated(scene, board) && <small className="ifs-image-warn">cena editada depois desta imagem</small>}
        {task?.error && (task.status === 'failed' || task.status === 'pending') && (
          <small className={task.status === 'failed' ? 'ifs-image-error' : 'ifs-image-retry'}>{task.error}</small>
        )}
        <SceneImageActions board={board} scene={scene} number={number} onMessage={onMessage} />
      </div>
    </li>
  )
})

export default function StoryImagesTab({ board, onMessage }: { board: Storyboard; onMessage: Notify }) {
  const [dialog, setDialog] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const run = board.batch

  const nameOf = useMemo(() => new Map(board.characters.map((c) => [c.key, c.name])), [board.characters])
  const states = board.scenes.map((s) => sceneImageState(s, run))
  const counts = states.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
  const tasks = run?.tasks ?? []
  const finished = tasks.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled').length
  const pending = tasks.filter((t) => t.status === 'pending').length
  const running = tasks.filter((t) => t.status === 'running').length
  const failed = tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').length
  const progress = tasks.length ? Math.round((finished / tasks.length) * 100) : 0
  const openIndex = board.scenes.findIndex((s) => s.id === openId)

  async function act(fn: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>, okText: string) {
    setWorking(true)
    const r = await fn()
    setWorking(false)
    if (r.ok) onMessage(okText)
    else if ('error' in r && r.error) onMessage(r.error, !r.cancelled)
  }

  async function handleExport() {
    setWorking(true)
    try {
      const manifest = await exportProjectZip(board.projectId)
      const sb = manifest.storyboard
      onMessage(
        sb
          ? `ZIP exportado: ${sb.imagesExported} de ${sb.sceneCount} cena(s) com imagem oficial${sb.simulatedImages ? ` (${sb.simulatedImages} simulada(s))` : ''}, prompts, copy e roteiro para o Google Flow.`
          : 'ZIP exportado.',
      )
    } catch (err) {
      onMessage(`Falha ao exportar: ${err instanceof Error ? err.message : 'erro desconhecido'}`, true)
    } finally {
      setWorking(false)
    }
  }

  if (board.scenes.length === 0) {
    return <p className="ifs-story-empty">Nenhuma cena ainda. Interprete a copy e aprove o storyboard antes de gerar as imagens.</p>
  }

  return (
    <div className="ifs-images">
      <div className="ifs-images__bar">
        <button type="button" className="ifs-btn-primary" onClick={() => setDialog(true)} disabled={pending + running > 0}>
          <Images size={14} /> Gerar todas as imagens
        </button>
        {run && (run.state === 'running' && (pending > 0 || running > 0) ? (
          <button type="button" className="ifs-btn-secondary" onClick={() => pauseBatch(board.projectId)}>
            <Pause size={14} /> Pausar
          </button>
        ) : pending > 0 ? (
          <button type="button" className="ifs-btn-secondary" disabled={working} onClick={() => act(() => resumeBatch(board.projectId), 'Geração retomada.')}>
            <Play size={14} /> Retomar
          </button>
        ) : null)}
        {pending > 0 && (
          <button type="button" className="ifs-btn-secondary" onClick={() => cancelPending(board.projectId)}>
            <XCircle size={14} /> Cancelar pendentes
          </button>
        )}
        {failed > 0 && pending + running === 0 && (
          <button type="button" className="ifs-btn-secondary" disabled={working} onClick={() => act(() => retryFailed(board.projectId), 'Cenas com falha na fila de novo.')}>
            <RotateCcw size={14} /> Gerar de novo as com falha ({failed})
          </button>
        )}
        <button type="button" className="ifs-btn-secondary" disabled={working} onClick={handleExport} title="ZIP com imagens oficiais, prompts, copy, storyboard e roteiro para o Google Flow">
          <FileArchive size={14} /> Exportar para o Google Flow (ZIP)
        </button>
      </div>

      {run && (
        <div className="ifs-images__progress" data-testid="batch-progress">
          <div className="ifs-progress">
            <div className="ifs-progress__bar" style={{ width: `${progress}%` }} />
          </div>
          <span>
            Lote: {finished}/{tasks.length} ({progress}%) · {running} gerando · {pending} na fila
            {run.simulated ? ' · IMAGENS SIMULADAS (fictícias)' : ''}
            {run.estimatedUsd !== null ? ` · custo estimado confirmado: US$ ${run.estimatedUsd.toFixed(2).replace('.', ',')}` : ''}
            {run.state === 'paused' ? ` · PAUSADO${run.pausedReason ? ` — ${run.pausedReason}` : ''}` : ''}
          </span>
        </div>
      )}
      <p className="ifs-images__counts">
        {(Object.keys(IMAGE_STATE_LABELS) as SceneImageState[])
          .filter((s) => counts[s])
          .map((s) => `${IMAGE_STATE_LABELS[s]}: ${counts[s]}`)
          .join(' · ')}
      </p>

      <ol className="ifs-images__grid">
        {board.scenes.map((scene, i) => (
          <ImageCard
            key={scene.id}
            board={board}
            scene={scene}
            number={i + 1}
            state={states[i]}
            names={scene.characterKeys.map((k) => nameOf.get(k) ?? '?').join(', ')}
            onOpen={setOpenId}
            onMessage={onMessage}
          />
        ))}
      </ol>

      {openIndex >= 0 && (
        <div className="ifs-dialog-backdrop" onClick={() => setOpenId(null)}>
          <div className="ifs-dialog ifs-dialog--wide" role="dialog" aria-modal="true" aria-label={`Cena ${openIndex + 1}`} onClick={(e) => e.stopPropagation()}>
            <div className="ifs-dialog__header">
              <h2>Cena {openIndex + 1}</h2>
              <button type="button" className="ifs-dialog__close" onClick={() => setOpenId(null)} title="Fechar">
                <XCircle size={16} />
              </button>
            </div>
            <blockquote className="ifs-images__quote">{board.scenes[openIndex].excerpt}</blockquote>
            <SceneImagePanel board={board} scene={board.scenes[openIndex]} number={openIndex + 1} onMessage={onMessage} />
          </div>
        </div>
      )}

      {dialog && <BatchDialog board={board} onClose={() => setDialog(false)} onDone={(r) => (r.ok ? onMessage(`${r.images} imagem(ns) na fila${r.simulated ? ' — SIMULADAS (fictícias)' : ''}.`) : onMessage(r.error, !r.cancelled))} />}
    </div>
  )
}
