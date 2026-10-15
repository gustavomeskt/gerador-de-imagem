import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertTriangle, ImageUp, RefreshCw, UserRound, X } from 'lucide-react'
import { useRef, type ChangeEvent } from 'react'
import NodeMenu from '../components/NodeMenu'
import {
  DEFAULT_MAX_REFERENCE_BYTES,
  DEFAULT_MAX_REFERENCES,
  REFERENCE_MIME_TYPES,
  REFERENCE_ROLE_LABELS,
  type ReferenceRole,
} from '../generation/references'
import { useFlowId } from '../store/flowIdContext'
import { useFlowStore, type ReferenceNodeData } from '../store/useFlowStore'

const ACCEPT = REFERENCE_MIME_TYPES.join(',')

// Nó de Referência: um assunto (pessoa, roupa, objeto ou estilo) com uma ou
// mais fotos. Conecte a saída dele na entrada "referências" de um nó de
// Imagem — as fotos vão junto no pedido ao modelo.
export default function ReferenceNode({ id, data }: NodeProps & { data: ReferenceNodeData }) {
  const flowId = useFlowId()
  const updateReferenceData = useFlowStore((s) => s.updateReferenceData)
  const addReferenceImages = useFlowStore((s) => s.addReferenceImages)
  const replaceReferenceImage = useFlowStore((s) => s.replaceReferenceImage)
  const removeReferenceImage = useFlowStore((s) => s.removeReferenceImage)
  const deleteNode = useFlowStore((s) => s.deleteNode)

  const addInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replacingId = useRef<string | null>(null)

  function handleAdd(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length > 0) void addReferenceImages(flowId, id, files)
  }

  function handleReplace(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file && replacingId.current) void replaceReferenceImage(flowId, id, replacingId.current, file)
    replacingId.current = null
  }

  function startReplace(imageId: string) {
    replacingId.current = imageId
    replaceInput.current?.click()
  }

  const full = data.images.length >= DEFAULT_MAX_REFERENCES

  return (
    <div className="ifs-node ifs-node--reference">
      <div className="ifs-node__header">
        <div className="ifs-node__header-title">
          <UserRound size={15} />
          <span>Referência</span>
        </div>
        <NodeMenu onDelete={() => deleteNode(flowId, id)} />
      </div>

      <div className="ifs-reference__fields nodrag">
        <label>
          Nome / quem é
          <input
            type="text"
            placeholder="Ex.: Dona Maria"
            value={data.label}
            maxLength={60}
            onChange={(e) => updateReferenceData(flowId, id, { label: e.target.value })}
          />
        </label>
        <label>
          Tipo
          <select
            value={data.role}
            onChange={(e) => updateReferenceData(flowId, id, { role: e.target.value as ReferenceRole })}
          >
            {Object.entries(REFERENCE_ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {data.role === 'character' && (
          <label className="ifs-reference__check">
            <input
              type="checkbox"
              checked={data.preserveClothing}
              onChange={(e) => updateReferenceData(flowId, id, { preserveClothing: e.target.checked })}
            />
            Manter a roupa da foto
          </label>
        )}
      </div>

      {data.images.length > 0 && (
        <div className="ifs-reference__grid nodrag nowheel">
          {data.images.map((img) => (
            <div key={img.id} className="ifs-reference__thumb" title={`${img.name} — ${img.width}×${img.height}`}>
              {img.missing || !img.src ? (
                <div className="ifs-reference__missing">
                  <AlertTriangle size={16} />
                  <span>arquivo não encontrado</span>
                </div>
              ) : (
                <img src={img.src} alt={img.name} />
              )}
              {img.unsaved && <div className="ifs-image__unsaved">não salva</div>}
              <div className="ifs-image__overlay">
                <button type="button" title="Substituir foto" onClick={() => startReplace(img.id)}>
                  <RefreshCw size={13} />
                </button>
                <button type="button" title="Remover foto" onClick={() => removeReferenceImage(flowId, id, img.id)}>
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="nodrag ifs-enhance-btn"
        onClick={() => addInput.current?.click()}
        disabled={full}
        title={`PNG, JPG ou WebP, até ${DEFAULT_MAX_REFERENCE_BYTES / 1024 / 1024} MB cada`}
      >
        <ImageUp size={13} />
        {full ? `Limite de ${DEFAULT_MAX_REFERENCES} fotos` : `Adicionar fotos (${data.images.length}/${DEFAULT_MAX_REFERENCES})`}
      </button>

      {data.notice && <div className="ifs-prompt__notice">{data.notice}</div>}

      <input ref={addInput} type="file" accept={ACCEPT} multiple hidden onChange={handleAdd} />
      <input ref={replaceInput} type="file" accept={ACCEPT} hidden onChange={handleReplace} />

      <Handle type="source" position={Position.Right} id="ref-out" className="ifs-handle ifs-handle--ref" />
    </div>
  )
}
