import { useState } from 'react'
import { useFlowStore } from '../store/useFlowStore'

export default function SettingsPanel() {
  const apiKey = useFlowStore((s) => s.apiKey)
  const setApiKey = useFlowStore((s) => s.setApiKey)

  const [value, setValue] = useState(apiKey)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setApiKey(value.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="ifs-settings-panel">
      <h1>Configuração</h1>
      <p>
        Sua API key da OpenAI fica salva apenas neste navegador (localStorage) e é usada para
        chamar a API de geração de imagens.
      </p>

      <label>
        API key
        <input
          type="password"
          placeholder="sk-..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
      </label>

      <button type="button" className="ifs-btn-primary" onClick={handleSave}>
        {saved ? 'Salvo!' : 'Salvar'}
      </button>
    </div>
  )
}
