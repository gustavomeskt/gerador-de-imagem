import { useState } from 'react'

// Campo de texto que só grava ao sair do campo (blur) — evita gravar no
// banco e recalcular prompts a cada tecla.
export function CommitField({
  label,
  value,
  onCommit,
  multiline,
  rows = 2,
  placeholder,
  hint,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
  multiline?: boolean
  rows?: number
  placeholder?: string
  hint?: string
}) {
  const [draft, setDraft] = useState(value)
  // valor mudou por fora (outra ação, outra cena) → recomeça o rascunho
  const [source, setSource] = useState(value)
  if (source !== value) {
    setSource(value)
    setDraft(value)
  }
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <label className="ifs-story-field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={rows} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
      )}
      {hint && <small>{hint}</small>}
    </label>
  )
}
