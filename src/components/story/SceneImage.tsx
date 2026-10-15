import { Check, Download, ImageOff, Loader2, RefreshCw, Star } from 'lucide-react'
import { useState } from 'react'
import { officialVersion } from '../../batch/planner'
import { IMAGE_STATE_LABELS, type SceneImageVersion } from '../../batch/types'
import { isOutdated, sceneImageState, taskForScene } from '../../batch/versions'
import { extensionFor } from '../../lib/binary'
import { FORMAT_LABELS } from '../../batch/format'
import { approveSceneImage, formatMethodOf, regenerateScene, unapproveSceneImage } from '../../store/batchController'
import ImageReviewDialog from './ImageReviewDialog'
import type { Storyboard, StoryScene } from '../../story/types'
import { useAssetSrc } from './useAssetSrc'

function imageFileName(number: number, version: SceneImageVersion) {
  return `cena_${String(number).padStart(3, '0')}${version.simulated ? '_simulada' : ''}.${extensionFor(version.mimeType)}`
}

// Miniatura carregada só quando aparece na tela.
export function VersionThumb({ version, alt, className }: { version: SceneImageVersion | undefined; alt: string; className?: string }) {
  const { ref, src, missing } = useAssetSrc(version?.assetId, version?.src)
  return (
    <div ref={ref} className={`ifs-thumb ${className ?? ''}`}>
      {version && src ? <img src={src} alt={alt} loading="lazy" /> : null}
      {version && !src && !missing ? <Loader2 size={16} className="ifs-spin" /> : null}
      {(!version || missing) && (
        <span className="ifs-thumb__empty">
          <ImageOff size={16} /> {missing ? 'arquivo ausente' : 'sem imagem'}
        </span>
      )}
      {version?.simulated && <span className="ifs-thumb__badge">FICTÍCIA</span>}
    </div>
  )
}

function DownloadButton({ version, number }: { version: SceneImageVersion; number: number }) {
  const { ref, src } = useAssetSrc(version.assetId, version.src)
  return (
    <div ref={ref} className="ifs-inline">
      <a
        className={src ? 'ifs-btn-secondary' : 'ifs-btn-secondary ifs-btn--disabled'}
        href={src}
        download={imageFileName(number, version)}
        title="Baixar a imagem oficial"
      >
        <Download size={14} /> Baixar
      </a>
    </div>
  )
}

// Ações da imagem de uma cena (usadas no cartão e no editor).
export function SceneImageActions({
  board,
  scene,
  number,
  onMessage,
  onReview,
}: {
  board: Storyboard
  scene: StoryScene
  number: number
  onMessage: (text: string, error?: boolean) => void
  onReview?: () => void
}) {
  const official = officialVersion(scene)
  const state = sceneImageState(scene, board.batch)
  const busy = state === 'pending' || state === 'running'
  const [asking, setAsking] = useState(false)

  async function regenerate() {
    setAsking(true)
    const r = await regenerateScene(board.projectId, scene.id)
    setAsking(false)
    if (r.ok) onMessage(`Nova versão da cena ${number} na fila${r.simulated ? ' (simulada)' : ''}. A imagem atual continua guardada.`)
    else onMessage(r.error, !r.cancelled)
  }

  return (
    <div className="ifs-scene-image__actions">
      <button type="button" className="ifs-btn-secondary" disabled={busy || asking || scene.status !== 'approved'} onClick={regenerate} title={scene.status !== 'approved' ? 'Aprove a cena no storyboard antes de gerar' : 'Gerar uma nova versão só desta cena'}>
        {asking ? <Loader2 size={14} className="ifs-spin" /> : <RefreshCw size={14} />} {official ? 'Regenerar' : 'Gerar'}
      </button>
      {official &&
        (scene.imageApprovedAt ? (
          <button type="button" className="ifs-btn-secondary" onClick={() => unapproveSceneImage(board.projectId, scene.id)}>
            Desaprovar
          </button>
        ) : (
          <button type="button" className="ifs-btn-primary" onClick={() => approveSceneImage(board.projectId, scene.id)}>
            <Check size={14} /> Aprovar imagem
          </button>
        ))}
      {official && onReview && (
        <button type="button" className="ifs-btn-secondary" onClick={onReview}>
          Revisar e comparar
        </button>
      )}
      {official && <DownloadButton version={official} number={number} />}
    </div>
  )
}

// Painel da imagem da cena: oficial, estado, formato, revisão e versões.
export function SceneImagePanel({ board, scene, number, onMessage }: { board: Storyboard; scene: StoryScene; number: number; onMessage: (text: string, error?: boolean) => void }) {
  const official = officialVersion(scene)
  const state = sceneImageState(scene, board.batch)
  const task = taskForScene(board.batch, scene.id)
  const versions = scene.images ?? []
  const [reviewing, setReviewing] = useState<string | null>(null)

  return (
    <div className="ifs-scene-image" data-testid="scene-image-panel">
      <div className="ifs-scene-image__head">
        <h4>Imagem da cena</h4>
        <span className={`ifs-image-state ifs-image-state--${state}`}>{IMAGE_STATE_LABELS[state]}</span>
        {official && <FormatBadge version={official} />}
        {official && isOutdated(scene, board) && <span className="ifs-image-warn">cena editada depois desta imagem</span>}
      </div>
      {task?.error && (task.status === 'failed' || task.status === 'pending') && (
        <p className={task.status === 'failed' ? 'ifs-image-error' : 'ifs-image-retry'}>{task.error}</p>
      )}
      <div className="ifs-scene-image__single">
        <figure>
          <button type="button" className="ifs-scene-image__open" onClick={() => official && setReviewing(official.id)} disabled={!official} title="Revisar e comparar">
            <VersionThumb version={official} alt={`Cena ${number} — imagem oficial`} className="ifs-thumb--large" />
          </button>
          {official && (
            <figcaption>
              <Star size={12} /> Oficial{scene.imageApprovedAt ? ' · aprovada' : official.review?.status === 'rejected' ? ' · rejeitada' : ' · não aprovada'} · {official.model} · {official.width}×{official.height}
            </figcaption>
          )}
        </figure>
      </div>
      {official && (
        <p className="ifs-scene-image__note">
          {official.simulated ? 'Imagem SIMULADA (fictícia, sem IA) — não serve para animação. ' : ''}
          {official.format.note}
        </p>
      )}
      <SceneImageActions board={board} scene={scene} number={number} onMessage={onMessage} onReview={official ? () => setReviewing(official.id) : undefined} />
      {versions.length > 1 && (
        <div className="ifs-scene-image__versions">
          <span>Versões ({versions.length}) — clique para revisar e comparar:</span>
          <div>
            {versions.map((v, i) => (
              <button
                type="button"
                key={v.id}
                className={v.id === official?.id ? 'ifs-version ifs-version--official' : v.review?.status === 'rejected' ? 'ifs-version ifs-version--rejected' : 'ifs-version'}
                onClick={() => setReviewing(v.id)}
                title={v.id === official?.id ? 'Versão oficial' : 'Revisar esta versão'}
              >
                <VersionThumb version={v} alt={`Versão ${i + 1}`} />
                <small>
                  v{i + 1}
                  {v.id === official?.id ? ' ★' : ''}
                  {v.review?.status === 'rejected' ? ' ✗' : v.review?.status === 'approved' ? ' ✓' : ''}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}
      {reviewing && (
        <ImageReviewDialog board={board} scene={scene} number={number} initialVersionId={reviewing} onClose={() => setReviewing(null)} onMessage={onMessage} />
      )}
    </div>
  )
}

export function FormatBadge({ version }: { version: SceneImageVersion }) {
  const method = formatMethodOf(version)
  return <span className={`ifs-format ifs-format--${method}`} title={version.format.note}>{method === 'unadjusted' ? `${version.width}×${version.height} — não é 9:16` : FORMAT_LABELS[method].split(' (')[0]}</span>
}
