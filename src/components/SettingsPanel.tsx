import { useState } from 'react'
import { SIMULATE_ERROR_TOKEN } from '../generation/mockProvider'
import { getProvider, PROVIDER_KINDS } from '../generation/providers'
import type { ProviderKind } from '../generation/types'
import { hasLegacyApiKey, removeLegacyApiKey } from '../lib/storage'
import { useFlowStore } from '../store/useFlowStore'

const PROVIDER_HELP: Record<ProviderKind, string> = {
  mock: `Gera imagens de teste localmente, sem rede e sem custo. Pra testar o caminho de erro, inclua ${SIMULATE_ERROR_TOKEN} no prompt.`,
  backend:
    'Usa a OpenAI através do backend seguro: a chave da API fica só no servidor, nunca no navegador. ' +
    'Precisa do servidor da API rodando (ele será implementado numa próxima etapa).',
}

export default function SettingsPanel() {
  const providerKind = useFlowStore((s) => s.providerKind)
  const setProviderKind = useFlowStore((s) => s.setProviderKind)
  const [legacyKey, setLegacyKey] = useState(hasLegacyApiKey)

  function handleRemoveLegacyKey() {
    removeLegacyApiKey()
    setLegacyKey(false)
  }

  return (
    <div className="ifs-settings-panel">
      <h1>Configuração</h1>
      <p>
        Escolha de onde vêm as imagens. Nenhuma chave de API é guardada neste navegador — o acesso
        real à OpenAI passa sempre pelo backend seguro.
      </p>

      <fieldset className="ifs-settings-panel__providers">
        <legend>Provedor de geração</legend>
        {PROVIDER_KINDS.map((kind) => (
          <label key={kind} className="ifs-settings-panel__provider">
            <input
              type="radio"
              name="provider"
              value={kind}
              checked={providerKind === kind}
              onChange={() => setProviderKind(kind)}
            />
            <span>
              <strong>{getProvider(kind).label}</strong>
              <small>{PROVIDER_HELP[kind]}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {legacyKey && (
        <div className="ifs-settings-panel__warning">
          <p>
            Uma API key de uma versão anterior ainda está salva neste navegador. Ela não é mais usada;
            recomendamos apagá-la.
          </p>
          <button type="button" className="ifs-btn-primary" onClick={handleRemoveLegacyKey}>
            Apagar chave antiga
          </button>
        </div>
      )}
    </div>
  )
}
