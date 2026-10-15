import { ArrowLeft, FileArchive, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { exportProjectZip } from '../export/exportProject'
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
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  function startEditing() {
    setDraft(name)
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    renameFlow(flowId, draft)
  }

  async function handleExport() {
    setExporting(true)
    setExportMessage(null)
    try {
      const manifest = await exportProjectZip(flowId)
      const skipped = manifest.skipped.length
      setExportMessage(
        manifest.imageCount === 0
          ? 'ZIP exportado sem imagens (nenhuma imagem pronta neste fluxo).'
          : `ZIP exportado com ${manifest.imageCount} imagem(ns)${skipped ? ` — ${skipped} ignorada(s), veja o manifest.json` : ''}.`,
      )
    } catch (err) {
      setExportMessage(`Falha ao exportar: ${err instanceof Error ? err.message : 'erro desconhecido'}`)
    } finally {
      setExporting(false)
    }
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
      <button
        type="button"
        className="ifs-flow-header__back"
        onClick={handleExport}
        disabled={exporting}
        title="Exportar imagens do fluxo em ZIP (com manifest.json)"
      >
        {exporting ? <Loader2 size={15} className="ifs-spin" /> : <FileArchive size={15} />}
      </button>
      {exportMessage && (
        <small className="ifs-flow-header__message" onClick={() => setExportMessage(null)}>
          {exportMessage}
        </small>
      )}
    </div>
  )
}
