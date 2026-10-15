import { ArrowDown, ArrowUp, Check, Combine, Copy, RotateCcw, Scissors, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useFlowStore } from '../../store/useFlowStore'
import { useStoryStore } from '../../store/useStoryStore'
import { buildScenePrompt } from '../../story/scenePrompt'
import { SCENE_STATUS_LABELS, type Storyboard, type StoryScene } from '../../story/types'
import { CommitField } from './fields'
import { SceneImagePanel } from './SceneImage'

export default function SceneEditor({
  board,
  scene,
  index,
  onMessage,
}: {
  board: Storyboard
  scene: StoryScene
  index: number
  onMessage: (text: string, error?: boolean) => void
}) {
  const projectId = board.projectId
  const library = useCharacterStore((s) => s.characters)
  const style = useFlowStore((s) => s.flowsData[projectId]?.styleGuide)
  const update = useStoryStore((s) => s.updateScene)
  const setStatus = useStoryStore((s) => s.setSceneStatus)
  const split = useStoryStore((s) => s.splitScene)
  const merge = useStoryStore((s) => s.mergeWithNext)
  const move = useStoryStore((s) => s.moveScene)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [copied, setCopied] = useState(false)

  const promptInfo = useMemo(() => buildScenePrompt(scene, board, library, style), [scene, board, library, style])
  const patch = (p: Parameters<typeof update>[2]) => update(projectId, scene.id, p)
  const isLast = index === board.scenes.length - 1

  function toggleCharacter(key: string) {
    const keys = scene.characterKeys.includes(key) ? scene.characterKeys.filter((k) => k !== key) : [...scene.characterKeys, key]
    patch({ characterKeys: keys, speakerKey: scene.speakerKey && !keys.includes(scene.speakerKey) ? null : scene.speakerKey })
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(promptInfo.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // área de transferência indisponível
    }
  }

  return (
    <div className="ifs-scene-editor" data-testid="scene-editor">
      <div className="ifs-scene-editor__head">
        <h3>
          Cena {index + 1}
          {scene.part && (
            <small>
              {' '}
              (imagem {scene.part.index} de {scene.part.total} do mesmo trecho)
            </small>
          )}
        </h3>
        <span className={`ifs-story-status ifs-story-status--${scene.status}`}>{SCENE_STATUS_LABELS[scene.status]}</span>
      </div>

      <div className="ifs-scene-editor__actions">
        {scene.status !== 'approved' ? (
          <button type="button" className="ifs-btn-primary" onClick={() => setStatus(projectId, scene.id, 'approved')}>
            <Check size={14} /> Aprovar cena
          </button>
        ) : (
          <button type="button" className="ifs-btn-secondary" onClick={() => setStatus(projectId, scene.id, 'reviewed')}>
            Reabrir para revisão
          </button>
        )}
        {scene.status === 'pending' && (
          <button type="button" className="ifs-btn-secondary" onClick={() => setStatus(projectId, scene.id, 'reviewed')}>
            Marcar como revisada
          </button>
        )}
        <button type="button" className="ifs-btn-secondary" title="Dividir em duas imagens" onClick={() => split(projectId, scene.id)}>
          <Scissors size={14} /> Dividir
        </button>
        <button type="button" className="ifs-btn-secondary" disabled={isLast} title="Unir com a próxima cena" onClick={() => merge(projectId, scene.id)}>
          <Combine size={14} /> Unir com a próxima
        </button>
        <button type="button" className="ifs-btn-icon" disabled={index === 0} title="Mover para cima" onClick={() => move(projectId, scene.id, index - 1)}>
          <ArrowUp size={14} />
        </button>
        <button type="button" className="ifs-btn-icon" disabled={isLast} title="Mover para baixo" onClick={() => move(projectId, scene.id, index + 1)}>
          <ArrowDown size={14} />
        </button>
      </div>

      <SceneImagePanel board={board} scene={scene} number={index + 1} onMessage={onMessage} />

      <div className="ifs-scene-editor__excerpt">
        <span>Trecho exato da copy (posição {scene.source.start}–{scene.source.end}, não editável)</span>
        <blockquote>{scene.excerpt}</blockquote>
      </div>

      {scene.flags.length > 0 && (
        <ul className="ifs-scene-editor__flags">
          {scene.flags.map((f, i) => (
            <li key={i}>
              <span>{f}</span>
              <button type="button" title="Resolvido — remover alerta" onClick={() => patch({ flags: scene.flags.filter((_, j) => j !== i) })}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="ifs-scene-editor__cast">
        <legend>Personagens na cena</legend>
        {board.characters.length === 0 && <small>Nenhum personagem no storyboard.</small>}
        {board.characters.map((c) => (
          <label key={c.key}>
            <input type="checkbox" checked={scene.characterKeys.includes(c.key)} onChange={() => toggleCharacter(c.key)} />
            {c.name}
            {!c.libraryId && <em> (sem cadastro)</em>}
          </label>
        ))}
      </fieldset>

      <label className="ifs-story-field">
        <span>Quem fala</span>
        <select value={scene.speakerKey ?? ''} onChange={(e) => patch({ speakerKey: e.target.value || null })}>
          <option value="">— ninguém / narração —</option>
          {board.characters
            .filter((c) => scene.characterKeys.includes(c.key))
            .map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
        </select>
      </label>

      <div className="ifs-scene-editor__grid">
        <CommitField label="Fala (do trecho)" value={scene.dialogue} onCommit={(v) => patch({ dialogue: v })} multiline />
        <CommitField label="Ação" value={scene.action} onCommit={(v) => patch({ action: v })} multiline />
        <CommitField label="Ambiente" value={scene.environment} onCommit={(v) => patch({ environment: v })} />
        <CommitField label="Emoções" value={scene.emotions} onCommit={(v) => patch({ emotions: v })} />
        <CommitField label="Figurino" value={scene.wardrobe} onCommit={(v) => patch({ wardrobe: v })} />
        <CommitField
          label="Objetos importantes"
          value={scene.objects.join(', ')}
          onCommit={(v) => patch({ objects: v.split(',').map((x) => x.trim()).filter(Boolean) })}
          hint="Separe por vírgula."
        />
        <CommitField label="Passagem de tempo" value={scene.timeShift} onCommit={(v) => patch({ timeShift: v })} />
        <CommitField label="Continuidade" value={scene.continuity} onCommit={(v) => patch({ continuity: v })} multiline />
        <CommitField label="Enquadramento" value={scene.framing} onCommit={(v) => patch({ framing: v })} />
        <CommitField
          label="Posições na imagem (esquerda → direita)"
          value={scene.positions ?? ''}
          onCommit={(v) => patch({ positions: v })}
          placeholder="Ex.: Dona Maria à esquerda, Seu João à direita"
        />
        <CommitField label="Posição e ângulo da câmera" value={scene.camera} onCommit={(v) => patch({ camera: v })} />
        <CommitField
          label="Descrição visual (só composição — nada de acontecimento novo)"
          value={scene.visualDescription}
          onCommit={(v) => patch({ visualDescription: v })}
          multiline
        />
        <CommitField
          label="Movimento para o Google Flow (só a ação descrita)"
          value={scene.motion}
          onCommit={(v) => patch({ motion: v })}
          multiline
        />
      </div>

      <div className="ifs-scene-editor__prompt">
        <div className="ifs-scene-editor__prompt-head">
          <span>
            Prompt final {scene.promptOverride ? <b>(editado manualmente)</b> : '(automático)'} · {promptInfo.photoCount} foto(s) de
            referência · guia de estilo {promptInfo.styleSource === 'project' ? 'do projeto' : 'padrão (fotorrealista 9:16, sem texto)'}
          </span>
          <div>
            <button type="button" className="ifs-btn-icon" title="Copiar prompt" onClick={copyPrompt}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {scene.promptOverride !== undefined && (
              <button type="button" className="ifs-btn-icon" title="Voltar ao prompt automático" onClick={() => patch({ promptOverride: undefined })}>
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>
        {promptInfo.cast.length > 0 && (
          <small>
            Personagens com ficha:{' '}
            {promptInfo.cast.map((c) => `${c.name} (${c.photosSent}/${c.photosTotal} foto(s))`).join(', ')}
          </small>
        )}
        {[...promptInfo.warnings].map((w, i) => (
          <small key={i} className="ifs-story-char__warn">
            {w}
          </small>
        ))}
        {editingPrompt ? (
          <CommitField
            label="Editar prompt (substitui o automático)"
            value={scene.promptOverride ?? promptInfo.prompt}
            onCommit={(v) => {
              patch({ promptOverride: v })
              setEditingPrompt(false)
            }}
            multiline
            rows={10}
          />
        ) : (
          <>
            <pre>{promptInfo.prompt}</pre>
            <button type="button" className="ifs-btn-secondary" onClick={() => setEditingPrompt(true)}>
              Editar prompt manualmente
            </button>
          </>
        )}
      </div>
    </div>
  )
}
