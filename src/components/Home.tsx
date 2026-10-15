import { FileArchive, Plus, Settings, Trash2, UsersRound, Workflow } from 'lucide-react'
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { exportProjectZip } from '../export/exportProject'
import { useFlowStore } from '../store/useFlowStore'
import CharactersPanel from './CharactersPanel'
import SettingsPanel from './SettingsPanel'

interface HomeProps {
  onOpenFlow: (id: string) => void
}

export default function Home({ onOpenFlow }: HomeProps) {
  const [tab, setTab] = useState<'flows' | 'characters' | 'settings'>('flows')
  const flows = useFlowStore((s) => s.flows)
  const createFlow = useFlowStore((s) => s.createFlow)
  const deleteFlow = useFlowStore((s) => s.deleteFlow)

  function handleCreate() {
    onOpenFlow(createFlow())
  }

  async function handleExport(e: ReactMouseEvent, id: string) {
    e.stopPropagation()
    try {
      await exportProjectZip(id)
    } catch (err) {
      alert(`Falha ao exportar: ${err instanceof Error ? err.message : 'erro desconhecido'}`)
    }
  }

  function handleDelete(e: ReactMouseEvent, id: string, name: string) {
    e.stopPropagation()
    if (confirm(`Apagar o fluxo "${name}"? Essa ação não pode ser desfeita.`)) {
      deleteFlow(id)
    }
  }

  return (
    <div className="ifs-home">
      <nav className="ifs-home__rail">
        <button
          type="button"
          className={tab === 'flows' ? 'ifs-home__rail-item ifs-home__rail-item--active' : 'ifs-home__rail-item'}
          onClick={() => setTab('flows')}
        >
          <Workflow size={16} />
          Fluxos
        </button>
        <button
          type="button"
          className={
            tab === 'characters' ? 'ifs-home__rail-item ifs-home__rail-item--active' : 'ifs-home__rail-item'
          }
          onClick={() => setTab('characters')}
        >
          <UsersRound size={16} />
          Personagens
        </button>
        <button
          type="button"
          className={
            tab === 'settings' ? 'ifs-home__rail-item ifs-home__rail-item--active' : 'ifs-home__rail-item'
          }
          onClick={() => setTab('settings')}
        >
          <Settings size={16} />
          Configuração
        </button>
      </nav>

      {tab === 'flows' && (
        <button type="button" className="ifs-home__new-flow-btn ifs-btn-primary" onClick={handleCreate}>
          <Plus size={15} />
          Novo fluxo
        </button>
      )}

      <div className="ifs-home__content">
        {tab === 'flows' ? (
          <div className="ifs-flows">
            <h1>Seus fluxos</h1>

            <div className="ifs-flows__grid">
              {flows.map((f) => (
                <div key={f.id} className="ifs-flow-card" onClick={() => onOpenFlow(f.id)}>
                  <Workflow size={18} />
                  <span>{f.name}</span>
                  <button
                    type="button"
                    className="ifs-flow-card__export"
                    title="Exportar imagens em ZIP"
                    onClick={(e) => handleExport(e, f.id)}
                  >
                    <FileArchive size={14} />
                  </button>
                  <button
                    type="button"
                    className="ifs-flow-card__delete"
                    title="Apagar fluxo"
                    onClick={(e) => handleDelete(e, f.id, f.name)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : tab === 'characters' ? (
          <CharactersPanel />
        ) : (
          <SettingsPanel />
        )}
      </div>
    </div>
  )
}
