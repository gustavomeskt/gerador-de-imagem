import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Loader2, MessageSquareText, Sparkles } from 'lucide-react'
import NodeMenu from '../components/NodeMenu'
import { useFlowId } from '../store/flowIdContext'
import { useFlowStore, type PromptNodeData } from '../store/useFlowStore'

export default function PromptNode({ id, data }: NodeProps & { data: PromptNodeData }) {
  const flowId = useFlowId()
  const updatePromptData = useFlowStore((s) => s.updatePromptData)
  const deleteNode = useFlowStore((s) => s.deleteNode)
  const enhancePrompt = useFlowStore((s) => s.enhancePrompt)

  return (
    <div className="ifs-node ifs-node--prompt">
      <div className="ifs-node__header">
        <div className="ifs-node__header-title">
          <MessageSquareText size={15} />
          <span>Prompt</span>
        </div>
        <NodeMenu onDelete={() => deleteNode(flowId, id)} />
      </div>

      <textarea
        className="nodrag ifs-prompt__textarea"
        placeholder="Descreva a imagem que você quer gerar..."
        value={data.prompt}
        onChange={(e) => updatePromptData(flowId, id, { prompt: e.target.value })}
        rows={5}
      />

      <button
        type="button"
        className="nodrag ifs-enhance-btn"
        onClick={() => enhancePrompt(flowId, id)}
        disabled={data.enhancing || !data.prompt.trim()}
        title="Reescreve o prompt com mais detalhe, do jeito que o ChatGPT faz antes de gerar"
      >
        {data.enhancing ? <Loader2 size={13} className="ifs-spin" /> : <Sparkles size={13} />}
        Melhorar prompt
      </button>

      {data.enhanceError && <div className="ifs-prompt__notice">{data.enhanceError}</div>}

      <Handle type="source" position={Position.Right} id="prompt-out" className="ifs-handle" />
    </div>
  )
}
