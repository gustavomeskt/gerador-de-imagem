import { UserPlus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useStoryStore } from '../../store/useStoryStore'
import type { MatchStatus, Storyboard, StoryCharacter } from '../../story/types'
import CharacterEditor from '../CharacterEditor'

const MATCH_LABELS: Record<MatchStatus, string> = {
  auto: 'Associado (mesmo nome)',
  confirmed: 'Confirmado',
  manual: 'Escolhido manualmente',
  ambiguous: 'Ambíguo — confirme',
  unregistered: 'Não cadastrado',
}

export default function StoryCharactersTab({ board }: { board: Storyboard }) {
  const library = useCharacterStore((s) => s.characters)
  const resolveCharacter = useStoryStore((s) => s.resolveCharacter)
  const addLibraryCharacter = useStoryStore((s) => s.addLibraryCharacter)
  const refreshMatches = useStoryStore((s) => s.refreshMatches)
  const [registering, setRegistering] = useState<StoryCharacter | null>(null)
  const projectId = board.projectId

  // cadastrou/excluiu alguém na biblioteca → recalcula as associações
  // automáticas (as confirmadas pela pessoa não mudam)
  const libraryKey = library.map((c) => `${c.id}:${c.name}`).join('|')
  useEffect(() => {
    refreshMatches(projectId)
  }, [libraryKey, projectId, refreshMatches])

  const sceneCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of board.scenes) for (const k of s.characterKeys) m.set(k, (m.get(k) ?? 0) + 1)
    return m
  }, [board.scenes])

  const unlinkedLibrary = library.filter((c) => !board.characters.some((x) => x.libraryId === c.id))

  return (
    <div className="ifs-story-chars">
      <p className="ifs-story-help">
        A associação automática só acontece quando o nome é igual ao de um personagem cadastrado (ignorando acentos e
        tratamentos como “Dona” e “Seu”). Nomes parecidos nunca são associados sozinhos.
      </p>
      {board.characters.length === 0 && <p className="ifs-story-empty">Nenhum personagem identificado ainda. Interprete a copy primeiro.</p>}
      <ul className="ifs-story-chars__list">
        {board.characters.map((c) => {
          const linked = c.libraryId ? library.find((l) => l.id === c.libraryId) : undefined
          const candidates = c.candidates.map((id) => library.find((l) => l.id === id)).filter(Boolean)
          return (
            <li key={c.key} className={`ifs-story-char ifs-story-char--${c.matchStatus}`} data-testid={`story-char-${c.name}`}>
              <div className="ifs-story-char__head">
                <strong>{c.name}</strong>
                <span className={`ifs-story-match ifs-story-match--${c.matchStatus}`}>{MATCH_LABELS[c.matchStatus]}</span>
              </div>
              <small>
                {c.mentions.length > 0 && <>Na copy: {c.mentions.join(', ')} · </>}
                {sceneCount.get(c.key) ?? 0} cena(s)
                {linked && (
                  <>
                    {' '}
                    · biblioteca: <b>{linked.name}</b> ({linked.photos.length} foto(s))
                  </>
                )}
              </small>
              {c.matchStatus === 'ambiguous' && candidates.length > 0 && (
                <small className="ifs-story-char__warn">Possíveis: {candidates.map((x) => x!.name).join(', ')} — escolha abaixo.</small>
              )}
              <div className="ifs-story-char__actions">
                <select
                  aria-label={`Personagem da biblioteca para ${c.name}`}
                  value={c.libraryId ?? ''}
                  onChange={(e) => resolveCharacter(projectId, c.key, e.target.value || null)}
                >
                  <option value="">— sem associação —</option>
                  {[...candidates.map((x) => x!), ...library.filter((l) => !c.candidates.includes(l.id))].map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                {c.matchStatus === 'auto' && c.libraryId && (
                  <button type="button" className="ifs-btn-secondary" onClick={() => resolveCharacter(projectId, c.key, c.libraryId)}>
                    Confirmar
                  </button>
                )}
                {!c.libraryId && (
                  <button type="button" className="ifs-btn-secondary" onClick={() => setRegistering(c)}>
                    <UserPlus size={14} /> Cadastrar na biblioteca
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {unlinkedLibrary.length > 0 && (
        <div className="ifs-story-chars__add">
          <label>
            Adicionar personagem da biblioteca ao storyboard:{' '}
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addLibraryCharacter(projectId, e.target.value)
              }}
            >
              <option value="">escolha…</option>
              {unlinkedLibrary.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {registering && (
        <CharacterEditor
          initialName={registering.name}
          onClose={() => setRegistering(null)}
          onSaved={(id) => resolveCharacter(projectId, registering.key, id)}
        />
      )}
    </div>
  )
}
