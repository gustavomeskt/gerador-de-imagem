import { AlertTriangle, CheckCheck, History } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { useStoryStore } from '../../store/useStoryStore'
import { uncoveredPassages } from '../../story/interpretation'
import { SCENE_STATUS_LABELS, type Storyboard, type StoryScene } from '../../story/types'
import SceneEditor from './SceneEditor'
import { IMAGE_STATE_LABELS, type SceneImageState } from '../../batch/types'
import { sceneImageState } from '../../batch/versions'

type Filter = 'all' | 'pending' | 'reviewed' | 'approved' | 'flagged'

function formatDate(ts: number) {
  return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

// Card leve (memo + content-visibility no CSS): storyboards de 50+ cenas
// continuam fluidos.
const SceneCard = memo(function SceneCard({
  scene,
  number,
  names,
  selected,
  imageState,
  onSelect,
}: {
  scene: StoryScene
  number: number
  names: string
  selected: boolean
  imageState: SceneImageState
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        className={`ifs-scene-card ifs-scene-card--${scene.status}${selected ? ' ifs-scene-card--selected' : ''}`}
        onClick={() => onSelect(scene.id)}
        data-testid="scene-card"
      >
        <div className="ifs-scene-card__head">
          <span className="ifs-scene-card__num">{number}</span>
          {scene.part && (
            <span className="ifs-scene-card__part">
              {scene.part.index}/{scene.part.total}
            </span>
          )}
          <span className={`ifs-story-status ifs-story-status--${scene.status}`}>{SCENE_STATUS_LABELS[scene.status]}</span>
          {scene.flags.length > 0 && (
            <span className="ifs-scene-card__flags" title={scene.flags.join('\n')}>
              <AlertTriangle size={12} /> {scene.flags.length}
            </span>
          )}
        </div>
        <p className="ifs-scene-card__excerpt">{scene.excerpt}</p>
        <small>
          {names || 'sem personagens'}
          {scene.environment && ` · ${scene.environment}`}
          {imageState !== 'none' && (
            <span className={`ifs-image-state ifs-image-state--${imageState}`}> imagem: {IMAGE_STATE_LABELS[imageState]}</span>
          )}
        </small>
      </button>
    </li>
  )
})

export default function StoryboardTab({ board, onMessage }: { board: Storyboard; onMessage: (text: string, error?: boolean) => void }) {
  const projectId = board.projectId
  const approveAll = useStoryStore((s) => s.approveAll)
  const restoreSnapshot = useStoryStore((s) => s.restoreSnapshot)
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const nameOf = useMemo(() => new Map(board.characters.map((c) => [c.key, c.name])), [board.characters])
  const counts = useMemo(() => {
    const c = { pending: 0, reviewed: 0, approved: 0, flagged: 0 }
    for (const s of board.scenes) {
      c[s.status] += 1
      if (s.flags.length) c.flagged += 1
    }
    return c
  }, [board.scenes])
  const gaps = useMemo(() => (board.scenes.length ? uncoveredPassages(board.copy, board.scenes) : []), [board.copy, board.scenes])

  const visible = board.scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => filter === 'all' || (filter === 'flagged' ? scene.flags.length > 0 : scene.status === filter))
  const selectedIndex = board.scenes.findIndex((s) => s.id === selectedId)
  const selected = selectedIndex >= 0 ? board.scenes[selectedIndex] : null

  function handleApproveAll() {
    const notApproved = board.scenes.length - counts.approved
    if (
      notApproved > 0 &&
      !window.confirm(
        `Aprovar o storyboard completo marca ${notApproved} cena(s) ainda não aprovada(s) como aprovada(s)` +
          `${counts.flagged ? ` — ${counts.flagged} cena(s) têm alertas para revisão` : ''}. Continuar?`,
      )
    ) {
      return
    }
    approveAll(projectId)
  }

  if (board.scenes.length === 0) {
    return <p className="ifs-story-empty">Nenhuma cena ainda. Cole a copy na aba “Copy” e clique em “Interpretar historinha”.</p>
  }

  return (
    <div className="ifs-storyboard">
      <div className="ifs-storyboard__summary">
        <span>
          <strong>{board.scenes.length}</strong> cena(s) · {counts.pending} pendente(s) · {counts.reviewed} revisada(s) ·{' '}
          {counts.approved} aprovada(s){counts.flagged ? ` · ${counts.flagged} com alerta` : ''}
        </span>
        {board.approvedAt ? (
          <span className="ifs-story-status ifs-story-status--approved">Storyboard aprovado em {formatDate(board.approvedAt)}</span>
        ) : (
          <button type="button" className="ifs-btn-primary" onClick={handleApproveAll}>
            <CheckCheck size={14} /> Aprovar storyboard completo
          </button>
        )}
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filtrar cenas">
          <option value="all">Todas</option>
          <option value="pending">Pendentes</option>
          <option value="reviewed">Revisadas</option>
          <option value="approved">Aprovadas</option>
          <option value="flagged">Com alerta</option>
        </select>
        <button type="button" className="ifs-btn-secondary" onClick={() => setShowHistory((v) => !v)}>
          <History size={14} /> Versões e histórico
        </button>
      </div>

      {gaps.length > 0 && (
        <div className="ifs-storyboard__gaps">
          <AlertTriangle size={14} /> {gaps.length} trecho(s) da copy sem cena:{' '}
          {gaps.slice(0, 3).map((g, i) => (
            <q key={i}>{g.length > 60 ? `${g.slice(0, 60)}…` : g}</q>
          ))}
          {gaps.length > 3 && ' …'}
        </div>
      )}

      {showHistory && (
        <div className="ifs-storyboard__history">
          <h4>Versões anteriores (restauráveis)</h4>
          {board.snapshots.length === 0 && <small>Nenhuma versão anterior.</small>}
          <ul>
            {board.snapshots
              .map((snap, i) => ({ snap, i }))
              .reverse()
              .map(({ snap, i }) => (
                <li key={snap.at + '-' + i}>
                  {formatDate(snap.at)} — {snap.reason} ({snap.scenes.length} cenas,{' '}
                  {snap.scenes.filter((s) => s.status === 'approved').length} aprovadas){' '}
                  <button
                    type="button"
                    className="ifs-btn-secondary"
                    onClick={() => {
                      if (window.confirm('Restaurar esta versão? A versão atual também fica guardada.')) restoreSnapshot(projectId, i)
                    }}
                  >
                    Restaurar
                  </button>
                </li>
              ))}
          </ul>
          <h4>Histórico de revisões</h4>
          <ol className="ifs-storyboard__log">
            {[...board.history].reverse().slice(0, 100).map((h, i) => (
              <li key={i}>
                <small>{formatDate(h.at)}</small> {h.action}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="ifs-storyboard__body">
        <ol className="ifs-storyboard__cards">
          {visible.map(({ scene, index }) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              number={index + 1}
              names={scene.characterKeys.map((k) => nameOf.get(k) ?? '?').join(', ')}
              selected={scene.id === selectedId}
              imageState={sceneImageState(scene, board.batch)}
              onSelect={setSelectedId}
            />
          ))}
          {visible.length === 0 && <li className="ifs-story-empty">Nenhuma cena neste filtro.</li>}
        </ol>
        <div className="ifs-storyboard__editor">
          {selected ? (
            <SceneEditor key={selected.id} board={board} scene={selected} index={selectedIndex} onMessage={onMessage} />
          ) : (
            <p className="ifs-story-empty">Selecione uma cena para revisar, editar e aprovar.</p>
          )}
        </div>
      </div>
    </div>
  )
}
