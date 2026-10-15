import { describe, expect, it } from 'vitest'
import { isQuotaError, StorageError, STORAGE_MESSAGES, toStorageError } from '../errors'

describe('erros de armazenamento', () => {
  it('reconhece falta de espaço, inclusive embrulhada numa transação abortada', () => {
    expect(isQuotaError(new DOMException('cheio', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true)
    expect(isQuotaError({ name: 'AbortError', error: new DOMException('cheio', 'QuotaExceededError') })).toBe(true)
    expect(isQuotaError(new Error('outra coisa'))).toBe(false)
  })

  it('traduz para mensagens claras', () => {
    const quota = toStorageError(new DOMException('cheio', 'QuotaExceededError'))
    expect(quota).toBeInstanceOf(StorageError)
    expect(quota.kind).toBe('quota')
    expect(quota.message).toBe(STORAGE_MESSAGES.quota)
    expect(quota.message).toMatch(/Exporte o projeto em ZIP/)

    expect(toStorageError(new Error('x')).kind).toBe('write')
    expect(toStorageError(new Error('x'), 'read').kind).toBe('read')

    const original = new StorageError('unavailable', 'msg')
    expect(toStorageError(original)).toBe(original)
  })
})
