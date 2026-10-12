import { MoreVertical, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface NodeMenuProps {
  onDelete: () => void
}

export default function NodeMenu({ onDelete }: NodeMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  return (
    <div className="ifs-node-menu nodrag" ref={rootRef}>
      <button
        type="button"
        className="ifs-node-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        title="Mais opções"
      >
        <MoreVertical size={14} />
      </button>

      {open && (
        <div className="ifs-node-menu__dropdown">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            <Trash2 size={13} />
            Excluir nó
          </button>
        </div>
      )}
    </div>
  )
}
