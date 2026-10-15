import { Check, Download, ImageOff, Loader2, RefreshCw, Star } from 'lucide-react'
import { useState } from 'react'
import { officialVersion } from '../../batch/planner'
import { IMAGE_STATE_LABELS, type SceneImageVersion } from '../../batch/types'
import { isOutdated, sceneImageState, taskForScene } from '../../batch/versions'
import { extensionFor } from '../../lib/binary'
import { approveSceneImage, regenerateScene, setOfficialImage, unapproveSceneImage } from '../../store/batchController'
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
}: {
  board: Storyboard
  scene: StoryScene
  number: number
  onMessage: (text: string, error?: boolean) => void
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
      {official && <DownloadButton version={official} number={number} />}
    </div>
  )
}

// Painel completo: imagem oficial, estado, erro, versões e comparação.
export function SceneImagePanel({ board, scene, number, onMessage }: { board: Storyboard; scene: StoryScene; number: number; onMessage: (text: string, error?: boolean) => void }) {
  const official = officialVersion(scene)
  const state = sceneImageState(scene, board.batch)
  const task = taskForScene(board.batch, scene.id)
  const versions = scene.images ?? []
  const [compareId, setCompareId] = useState<string | null>(null)
  const compare = versions.find((v) => v.id === compareId && v.id !== official?.id)

  return (
    <div className="ifs-scene-image" data-testid="scene-image-panel">
      <div className="ifs-scene-image__head">
        <h4>Imagem da cena</h4>
        <span className={`ifs-image-state ifs-image-state--${state}`}>{IMAGE_STATE_LABELS[state]}</span>
        {official && isOutdated(scene, board) && <span className="ifs-image-warn">cena editada depois desta imagem</span>}
      </div>
      {task?.error && (task.status === 'failed' || task.status === 'pending') && (
        <p className={task.status === 'failed' ? 'ifs-image-error' : 'ifs-image-retry'}>{task.error}</p>
      )}
      <div className={compare ? 'ifs-scene-image__compare' : 'ifs-scene-image__single'}>
        <figure>
          <VersionThumb version={official} alt={`Cena ${number} — imagem oficial`} className="ifs-thumb--large" />
          {official && (
            <figcaption>
              <Star size={12} /> Oficial{scene.imageApprovedAt ? ' · aprovada' : ' · não aprovada'} · {official.model} · {official.width}×{official.height}
            </figcaption>
          )}
        </figure>
        {compare && (
          <figure>
            <VersionThumb version={compare} alt={`Cena ${number} — versão para comparar`} className="ifs-thumb--large" />
            <figcaption>
              Versão de {new Date(compare.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{' '}
              <button
                type="button"
                className="ifs-btn-secondary"
                onClick={() => {
                  if (!scene.imageApprovedAt || window.confirm('A imagem oficial atual está aprovada. Trocar pela versão escolhida? (A atual continua guardada.)')) {
                    setOfficialImage(board.projectId, scene.id, compare.id)
                    setCompareId(null)
                  }
                }}
              >
                Tornar oficial
              </button>
            </figcaption>
          </figure>
        )}
      </div>
      {official && (
        <p className="ifs-scene-image__note">
          {official.simulated ? 'Imagem SIMULADA (fictícia, sem IA). ' : ''}
          {official.format.note}
        </p>
      )}
      <SceneImageActions board={board} scene={scene} number={number} onMessage={onMessage} />
      {versions.length > 1 && (
        <div className="ifs-scene-image__versions">
          <span>Versões ({versions.length}) — clique para comparar com a oficial:</span>
          <div>
            {versions.map((v, i) => (
              <button
                type="button"
                key={v.id}
                className={v.id === official?.id ? 'ifs-version ifs-version--official' : v.id === compareId ? 'ifs-version ifs-version--compare' : 'ifs-version'}
                onClick={() => setCompareId(v.id === official?.id ? null : v.id)}
                title={v.id === official?.id ? 'Versão oficial' : 'Comparar com a oficial'}
              >
                <VersionThumb version={v} alt={`Versão ${i + 1}`} />
                <small>v{i + 1}{v.id === official?.id ? ' ★' : ''}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
