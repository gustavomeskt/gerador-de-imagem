// Erros de armazenamento traduzidos em mensagens claras pra pessoa usuária.

export type StorageIssueKind = 'quota' | 'unavailable' | 'write' | 'read'

export class StorageError extends Error {
  readonly kind: StorageIssueKind

  constructor(kind: StorageIssueKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StorageError'
    this.kind = kind
  }
}

export const STORAGE_MESSAGES: Record<StorageIssueKind, string> = {
  quota:
    'Sem espaço no armazenamento do navegador. Exporte o projeto em ZIP e apague imagens ou fluxos que não usa mais.',
  unavailable:
    'O armazenamento local do navegador está indisponível (modo privado ou bloqueio de dados do site). Nada será salvo nesta sessão — exporte em ZIP antes de fechar.',
  write: 'Não foi possível salvar no armazenamento local do navegador. Exporte o projeto em ZIP para não perder o trabalho.',
  read: 'Não foi possível ler os dados salvos no navegador.',
}

const QUOTA_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'])

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') return err.name
  return undefined
}

export function isQuotaError(err: unknown): boolean {
  if (QUOTA_NAMES.has(errorName(err) ?? '')) return true
  // transações abortadas carregam o erro original em `error` ou `cause`
  if (err && typeof err === 'object') {
    const inner = (err as { error?: unknown; cause?: unknown }).error ?? (err as { cause?: unknown }).cause
    if (inner && inner !== err) return isQuotaError(inner)
  }
  return false
}

export function toStorageError(err: unknown, fallbackKind: Exclude<StorageIssueKind, 'quota'> = 'write'): StorageError {
  if (err instanceof StorageError) return err
  const kind: StorageIssueKind = isQuotaError(err) ? 'quota' : fallbackKind
  return new StorageError(kind, STORAGE_MESSAGES[kind], { cause: err })
}
