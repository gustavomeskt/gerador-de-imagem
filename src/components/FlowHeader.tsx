import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { useFlowStore } from '../store/useFlowStore'

interface FlowHeaderProps {
  flowId: string
  onBack: () => void
}

export default function FlowHeader({ flowId, onBack }: FlowHeaderProps) {
  const name = useFlowStore((s) => s.flows.find((f) => f.id === flowId)?.name ?? 'Fluxo')
  const renameFlow = useFlowStore((s) => s.renameFlow)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  function startEditing() {
    setDraft(name)
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    renameFlow(flowId, draft)
  }

  return (
    <div className="ifs-flow-header">
      <button type="button" className="ifs-flow-header__back" onClick={onBack} title="Voltar">
        <ArrowLeft size={16} />
      </button>
      {editing ? (
        <input
          className="nodrag ifs-flow-header__input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      ) : (
        <span onClick={startEditing} title="Clique para renomear">
          {name}
        </span>
      )}
    </div>
  )
}
