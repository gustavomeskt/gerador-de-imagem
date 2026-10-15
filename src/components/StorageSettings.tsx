import { useEffect, useState } from 'react'
import { useFlowStore } from '../store/useFlowStore'

interface StorageInfo {
  usage?: number
  quota?: number
  persisted?: boolean
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

async function readStorageInfo(): Promise<StorageInfo> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (!storage) return {}
  const [estimate, persisted] = await Promise.all([
    storage.estimate?.().catch(() => undefined),
    storage.persisted?.().catch(() => undefined),
  ])
  return { usage: estimate?.usage, quota: estimate?.quota, persisted }
}

export default function StorageSettings() {
  const persistence = useFlowStore((s) => s.persistence)
  const [info, setInfo] = useState<StorageInfo>({})
  const [requestResult, setRequestResult] = useState<string | null>(null)

  useEffect(() => {
    void readStorageInfo().then(setInfo)
  }, [])

  async function requestPersistence() {
    const granted = await navigator.storage?.persist?.().catch(() => false)
    setRequestResult(
      granted
        ? 'O navegador concedeu armazenamento persistente.'
        : 'O navegador não concedeu agora (isso depende das regras de cada navegador). Continue exportando em ZIP.',
    )
    setInfo(await readStorageInfo())
  }

  return (
    <section className="ifs-settings-panel__storage">
      <h2>Armazenamento</h2>
      <dl>
        <dt>Onde fica</dt>
        <dd>
          {persistence === 'indexeddb'
            ? 'Neste navegador (IndexedDB), salvo automaticamente'
            : 'Indisponível — nada está sendo salvo nesta sessão'}
        </dd>
        <dt>Espaço usado</dt>
        <dd>
          {formatBytes(info.usage)} de {formatBytes(info.quota)} disponíveis
        </dd>
        <dt>Persistente</dt>
        <dd>{info.persisted === undefined ? '—' : info.persisted ? 'Sim' : 'Não (pode ser apagado pelo navegador)'}</dd>
      </dl>

      {persistence === 'indexeddb' && info.persisted === false && (
        <button type="button" className="ifs-btn-primary" onClick={requestPersistence}>
          Pedir armazenamento persistente
        </button>
      )}
      {requestResult && <p>{requestResult}</p>}

      <p className="ifs-settings-panel__limits">
        <strong>Isto não é um backup.</strong> Projetos e imagens ficam só neste navegador, neste computador. Eles
        somem se você limpar os dados do site, usar outro navegador ou outro computador, ou se o navegador precisar de
        espaço. Use o botão de exportar ZIP (no fluxo ou no card do fluxo) para guardar uma cópia das imagens com o
        manifest.json. Evite editar o mesmo fluxo em duas abas ao mesmo tempo: a última gravação prevalece.
      </p>
    </section>
  )
}
