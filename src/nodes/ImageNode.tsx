import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import {
  AlertTriangle,
  ChevronDown,
  Download,
  ImageIcon,
  Loader2,
  RefreshCw,
  Wand2,
  X,
} from 'lucide-react'
import NodeMenu from '../components/NodeMenu'
import { extensionFor } from '../lib/binary'
import {
  clampCount,
  MAX_IMAGES_PER_NODE,
  MODEL_LABELS,
  MODEL_QUALITIES,
  MODEL_SIZES,
  type ImageModel,
} from '../generation/models'
import { useFlowId } from '../store/flowIdContext'
import { useFlowStore, type ImageNodeData, type ImageSlot } from '../store/useFlowStore'


export default function ImageNode({ id, data, selected }: NodeProps & { data: ImageNodeData }) {
  const flowId = useFlowId()
  const updateImageConfig = useFlowStore((s) => s.updateImageConfig)
  const generate = useFlowStore((s) => s.generate)
  const regenerateSlot = useFlowStore((s) => s.regenerateSlot)
  const deleteSlot = useFlowStore((s) => s.deleteSlot)
  const deleteNode = useFlowStore((s) => s.deleteNode)

  const qualities = MODEL_QUALITIES[data.model]
  const sizes = MODEL_SIZES[data.model]
  const isGenerating = data.images.some((img) => img.status === 'loading')

  function handleModelChange(model: ImageModel) {
    const newSizes = MODEL_SIZES[model]
    const newQualities = MODEL_QUALITIES[model]
    updateImageConfig(flowId, id, {
      model,
      size: newSizes[0].value,
      quality: newQualities ? newQualities[0].value : undefined,
    })
  }

  function downloadImage(slot: ImageSlot, index: number) {
    if (!slot.src) return
    const ext = extensionFor(slot.mimeType)
    const link = document.createElement('a')
    link.href = slot.src
    link.download = `imagem-${id}-${index + 1}.${ext}`
    link.click()
  }

  return (
    <div className="ifs-node ifs-node--image">
      <NodeResizer
        minWidth={320}
        minHeight={220}
        isVisible={selected}
        lineStyle={{ borderColor: 'var(--accent)', borderWidth: 1 }}
        handleStyle={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--accent)',
          border: '1.5px solid var(--bg)',
        }}
      />

      <Handle type="target" position={Position.Left} id="prompt-in" className="ifs-handle" />

      <div className="ifs-node__header">
        <div className="ifs-node__header-title">
          <ImageIcon size={15} />
          <span>Gerador de imagens</span>
        </div>
        <NodeMenu onDelete={() => deleteNode(flowId, id)} />
      </div>

      <div className="ifs-image__config nodrag">
        <label>
          Modelo
          <div className="ifs-select-wrap">
            <select value={data.model} onChange={(e) => handleModelChange(e.target.value as ImageModel)}>
              {Object.entries(MODEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="ifs-select-wrap__icon" />
          </div>
        </label>

        <label>
          Proporção
          <div className="ifs-select-wrap">
            <select value={data.size} onChange={(e) => updateImageConfig(flowId, id, { size: e.target.value })}>
              {sizes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="ifs-select-wrap__icon" />
          </div>
        </label>

        {qualities && (
          <label>
            Qualidade
            <div className="ifs-select-wrap">
              <select
                value={data.quality}
                onChange={(e) => updateImageConfig(flowId, id, { quality: e.target.value })}
              >
                {qualities.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="ifs-select-wrap__icon" />
            </div>
          </label>
        )}

        <label>
          Qtd.
          <input
            type="number"
            min={1}
            max={MAX_IMAGES_PER_NODE}
            value={data.count}
            onChange={(e) => updateImageConfig(flowId, id, { count: clampCount(Number(e.target.value) || 1) })}
          />
        </label>

        <button
          type="button"
          className="ifs-generate-btn"
          onClick={() => generate(flowId, id)}
          disabled={isGenerating}
        >
          {isGenerating ? <Loader2 size={14} className="ifs-spin" /> : <Wand2 size={14} />}
          Gerar
        </button>
      </div>

      {data.notice && <div className="ifs-image__notice">{data.notice}</div>}

      {data.images.length > 0 && (
        <div className="ifs-image__row nodrag nowheel">
          {data.images.map((slot, index) => (
            <div key={slot.id} className="ifs-image__slot" style={{ aspectRatio: slot.aspect }}>
              {slot.status === 'loading' && (
                <div className="ifs-image__placeholder">
                  <Loader2 size={20} className="ifs-spin" />
                </div>
              )}

              {slot.status === 'error' && (
                <div className="ifs-image__placeholder ifs-image__placeholder--error" title={slot.error}>
                  <AlertTriangle size={20} />
                </div>
              )}

              {slot.status === 'done' && slot.src && <img src={slot.src} alt={`Gerada ${index + 1}`} />}

              {slot.status === 'done' && slot.unsaved && (
                <div
                  className="ifs-image__unsaved"
                  title="Esta imagem não foi salva no navegador e some ao fechar o app. Baixe ou exporte o ZIP."
                >
                  não salva
                </div>
              )}

              <div className="ifs-image__overlay">
                <button
                  type="button"
                  title="Gerar de novo"
                  onClick={() => regenerateSlot(flowId, id, slot.id)}
                  disabled={slot.status === 'loading'}
                >
                  <RefreshCw size={13} />
                </button>
                {slot.status === 'done' && slot.src && (
                  <button type="button" title="Baixar" onClick={() => downloadImage(slot, index)}>
                    <Download size={13} />
                  </button>
                )}
                <button type="button" title="Remover" onClick={() => deleteSlot(flowId, id, slot.id)}>
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
