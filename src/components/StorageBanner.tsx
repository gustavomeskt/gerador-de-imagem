import { AlertTriangle, X } from 'lucide-react'
import { useFlowStore } from '../store/useFlowStore'

// Aviso global de problemas de armazenamento (falta de espaço, banco
// indisponível, falha de gravação).
export default function StorageBanner() {
  const issue = useFlowStore((s) => s.storageIssue)
  const dismiss = useFlowStore((s) => s.dismissStorageIssue)
  if (!issue) return null

  return (
    <div className="ifs-storage-banner" role="alert">
      <AlertTriangle size={16} />
      <span>{issue.message}</span>
      <button type="button" onClick={dismiss} title="Fechar aviso">
        <X size={14} />
      </button>
    </div>
  )
}
