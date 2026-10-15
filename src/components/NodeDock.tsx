import { useReactFlow } from '@xyflow/react'
import { ImagePlus, MessageSquarePlus, UserRoundPlus } from 'lucide-react'
import { useFlowId } from '../store/flowIdContext'
import { useFlowStore } from '../store/useFlowStore'

export default function NodeDock() {
  const flowId = useFlowId()
  const { screenToFlowPosition } = useReactFlow()
  const addPromptNode = useFlowStore((s) => s.addPromptNode)
  const addImageNode = useFlowStore((s) => s.addImageNode)
  const addReferenceNode = useFlowStore((s) => s.addReferenceNode)

  function centerPosition() {
    const x = window.innerWidth / 2 + (Math.random() * 80 - 40)
    const y = window.innerHeight / 2 + (Math.random() * 80 - 40)
    return screenToFlowPosition({ x, y })
  }

  return (
    <div className="ifs-dock">
      <button
        type="button"
        className="ifs-dock__btn"
        title="Novo nó de prompt"
        onClick={() => addPromptNode(flowId, centerPosition())}
      >
        <MessageSquarePlus size={16} />
      </button>
      <button
        type="button"
        className="ifs-dock__btn"
        title="Novo nó de imagem"
        onClick={() => addImageNode(flowId, centerPosition())}
      >
        <ImagePlus size={16} />
      </button>
      <button
        type="button"
        className="ifs-dock__btn"
        title="Novo nó de referência (fotos)"
        onClick={() => addReferenceNode(flowId, centerPosition())}
      >
        <UserRoundPlus size={16} />
      </button>
    </div>
  )
}
