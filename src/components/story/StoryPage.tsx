import { ArrowLeft, BookOpen } from 'lucide-react'
import { useState } from 'react'
import { useFlowStore } from '../../store/useFlowStore'
import { useStoryStore, type InterpretResult } from '../../store/useStoryStore'
import StoryCharactersTab from './StoryCharactersTab'
import StoryCopyTab from './StoryCopyTab'
import StoryboardTab from './StoryboardTab'
import StoryImagesTab from './StoryImagesTab'

type Tab = 'copy' | 'characters' | 'storyboard' | 'images'

function resultMessage(r: InterpretResult): { text: string; error: boolean } {
  if (!r.ok) return { text: r.error, error: !r.cancelled }
  const s = r.summary
  const parts = [
    `Interpretação ${r.mode === 'simulated' ? 'SIMULADA' : 'por IA'} concluída: ${r.scenes} cena(s).`,
    s.keptApproved ? `${s.keptApproved} cena(s) aprovada(s) preservada(s).` : '',
    s.replacedReviewed ? `${s.replacedReviewed} cena(s) revisada(s) não aprovada(s) substituída(s) (restaurável em “Versões e histórico”).` : '',
    r.warnings.length ? `${r.warnings.length} aviso(s) — veja na aba Copy.` : '',
  ]
  return { text: parts.filter(Boolean).join(' '), error: false }
}

// Tela "Historinha": copy original → interpretação → revisão do storyboard.
export default function StoryPage({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  const name = useFlowStore((s) => s.flows.find((f) => f.id === flowId)?.name ?? 'Projeto')
  const board = useStoryStore((s) => s.boards[flowId]) ?? useStoryStore.getState().ensureBoard(flowId)
  const interpret = useStoryStore((s) => s.interpret)
  const issue = useStoryStore((s) => s.issue)
  const dismissIssue = useStoryStore((s) => s.dismissIssue)
  const persistent = useStoryStore((s) => s.persistent)
  const [tab, setTab] = useState<Tab>(board.scenes.length ? 'storyboard' : 'copy')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const imageCount = board.scenes.filter((s) => s.officialImageId).length
  const notify = (text: string, error = false) => setMessage({ text, error })
  const pendingChars = board.characters.filter((c) => c.matchStatus === 'ambiguous' || c.matchStatus === 'unregistered').length

  async function handleInterpret() {
    setMessage(null)
    const result = await interpret(flowId)
    setMessage(resultMessage(result))
    if (result.ok) setTab('storyboard')
  }

  return (
    <div className="ifs-story">
      <header className="ifs-story__header">
        <button type="button" className="ifs-flow-header__back" onClick={onBack} title="Voltar ao fluxo">
          <ArrowLeft size={16} />
        </button>
        <BookOpen size={16} />
        <h1>
          Historinha <small>· {name}</small>
        </h1>
        <nav className="ifs-story__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'copy'} onClick={() => setTab('copy')}>
            Copy
          </button>
          <button type="button" role="tab" aria-selected={tab === 'characters'} onClick={() => setTab('characters')}>
            Personagens ({board.characters.length}){pendingChars > 0 && <span className="ifs-story__dot">{pendingChars}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'storyboard'} onClick={() => setTab('storyboard')}>
            Storyboard ({board.scenes.length})
          </button>
          <button type="button" role="tab" aria-selected={tab === 'images'} onClick={() => setTab('images')}>
            Imagens ({imageCount}/{board.scenes.length})
          </button>
        </nav>
      </header>

      {!persistent && (
        <div className="ifs-story__message ifs-story__message--error">
          Armazenamento local indisponível: o storyboard vale só nesta sessão.
        </div>
      )}
      {issue && (
        <div className="ifs-story__message ifs-story__message--error" onClick={dismissIssue}>
          {issue}
        </div>
      )}
      {message && (
        <div
          className={message.error ? 'ifs-story__message ifs-story__message--error' : 'ifs-story__message'}
          onClick={() => setMessage(null)}
          role="status"
        >
          {message.text}
        </div>
      )}

      <main className="ifs-story__main">
        {tab === 'copy' && <StoryCopyTab board={board} onInterpret={handleInterpret} />}
        {tab === 'characters' && <StoryCharactersTab board={board} />}
        {tab === 'storyboard' && <StoryboardTab board={board} onMessage={notify} />}
        {tab === 'images' && <StoryImagesTab board={board} onMessage={notify} />}
      </main>
    </div>
  )
}
