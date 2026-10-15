import { Copy, Download, Pencil, Plus, Trash2, Upload, UserRound } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { orderedPhotos, type Character } from '../generation/characters'
import { projectsUsingCharacter } from '../store/characterUsage'
import { useCharacterStore } from '../store/useCharacterStore'
import { useFlowStore } from '../store/useFlowStore'
import CharacterEditor from './CharacterEditor'

// Seção "Personagens": biblioteca permanente, independente dos projetos.
export default function CharactersPanel() {
  const characters = useCharacterStore((s) => s.characters)
  const issue = useCharacterStore((s) => s.issue)
  const dismissIssue = useCharacterStore((s) => s.dismissIssue)
  const duplicateCharacter = useCharacterStore((s) => s.duplicateCharacter)
  const deleteCharacter = useCharacterStore((s) => s.deleteCharacter)
  // re-renderiza quando os projetos mudam (contagem de uso)
  useFlowStore((s) => s.flowsData)

  const [editing, setEditing] = useState<Character | 'new' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)

  function handleDelete(c: Character) {
    const usage = projectsUsingCharacter(c.id)
    const text = usage.length
      ? `"${c.name}" é usado em ${usage.length} projeto(s): ${usage.map((u) => `${u.flowName} (${u.nodeCount} nó(s))`).join(', ')}.\n\n` +
        'Ao excluir, esses nós vão mostrar um aviso e não vão gerar até você trocar o personagem (ou restaurar um backup). ' +
        'As imagens já geradas não são apagadas.\n\nExcluir mesmo assim?'
      : `Excluir "${c.name}" da biblioteca? As fotos dele serão apagadas deste navegador.`
    if (confirm(text)) void deleteCharacter(c.id)
  }

  async function handleExport() {
    setBusy(true)
    try {
      const { exportLibraryBackup } = await import('../export/libraryBackup')
      const manifest = await exportLibraryBackup()
      setMessage(
        `Backup exportado: ${manifest.characterCount} personagem(ns), ${manifest.photoCount} foto(s)` +
          (manifest.missingPhotos.length ? ` — ${manifest.missingPhotos.length} foto(s) ausente(s) ficaram de fora.` : '.'),
      )
    } catch (err) {
      setMessage(`Falha ao exportar: ${err instanceof Error ? err.message : 'erro desconhecido'}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const { importLibraryBackup } = await import('../export/libraryBackup')
      const r = await importLibraryBackup(file)
      const parts = [
        r.imported.length ? `${r.imported.length} importado(s)` : null,
        r.updated.length ? `${r.updated.length} atualizado(s)` : null,
        r.skipped.length ? `${r.skipped.length} já estavam atualizados` : null,
        r.errors.length ? `${r.errors.length} com problema: ${r.errors.join('; ')}` : null,
      ].filter(Boolean)
      setMessage(`Backup restaurado: ${parts.join(' · ') || 'nada a importar'}.`)
    } catch (err) {
      setMessage(`Backup recusado: ${err instanceof Error ? err.message : 'arquivo inválido'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ifs-characters">
      <div className="ifs-characters__head">
        <h1>Personagens</h1>
        <div className="ifs-characters__actions">
          <button type="button" className="ifs-dialog__cancel" onClick={handleExport} disabled={busy || characters.length === 0}>
            <Download size={14} /> Exportar backup
          </button>
          <button type="button" className="ifs-dialog__cancel" onClick={() => importInput.current?.click()} disabled={busy}>
            <Upload size={14} /> Importar backup
          </button>
          <button type="button" className="ifs-btn-primary" onClick={() => setEditing('new')}>
            <Plus size={14} /> Novo personagem
          </button>
          <input ref={importInput} type="file" accept=".zip,application/zip" hidden onChange={handleImport} />
        </div>
      </div>
      <p className="ifs-characters__intro">
        Cadastre cada pessoa uma vez e use em qualquer historinha: as fotos vão de verdade para o modelo junto com a ficha
        permanente. O backup (ZIP) leva fichas e fotos originais para outro navegador ou computador.
      </p>

      {issue && (
        <div className="ifs-characters__message ifs-characters__message--error" onClick={dismissIssue}>
          {issue}
        </div>
      )}
      {message && (
        <div className="ifs-characters__message" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}

      {characters.length === 0 ? (
        <p className="ifs-characters__empty">Nenhum personagem cadastrado ainda.</p>
      ) : (
        <div className="ifs-characters__grid">
          {characters.map((c) => {
            const photo = orderedPhotos(c)[0]
            const usage = projectsUsingCharacter(c.id)
            return (
              <div key={c.id} className="ifs-character-card" data-character-id={c.id}>
                <div className="ifs-character-card__photo">
                  {photo?.src && !photo.missing ? <img src={photo.src} alt={c.name} /> : <UserRound size={28} />}
                </div>
                <div className="ifs-character-card__body">
                  <strong>{c.name}</strong>
                  <span>{c.apparentAge || 'idade não informada'}</span>
                  <small>
                    {c.photos.length} foto(s) · v{c.version} · {usage.length ? `usado em ${usage.length} projeto(s)` : 'não usado'}
                  </small>
                </div>
                <div className="ifs-character-card__actions">
                  <button type="button" title="Ver / editar" onClick={() => setEditing(c)}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" title="Duplicar" onClick={() => void duplicateCharacter(c.id)}>
                    <Copy size={14} />
                  </button>
                  <button type="button" title="Excluir" onClick={() => handleDelete(c)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && <CharacterEditor character={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
