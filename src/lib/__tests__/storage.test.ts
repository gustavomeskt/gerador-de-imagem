import { beforeEach, describe, expect, it } from 'vitest'
import { hasLegacyApiKey, loadProviderKind, removeLegacyApiKey, saveProviderKind } from '../storage'

describe('storage', () => {
  beforeEach(() => localStorage.clear())

  it('usa o provedor simulado por padrão e ignora valores inválidos', () => {
    expect(loadProviderKind()).toBe('mock')
    localStorage.setItem('ifs.provider', 'openai-direto')
    expect(loadProviderKind()).toBe('mock')
    saveProviderKind('backend')
    expect(loadProviderKind()).toBe('backend')
  })

  it('detecta e apaga a API key antiga do navegador', () => {
    expect(hasLegacyApiKey()).toBe(false)
    localStorage.setItem('ifs.openai.apiKey', 'sk-antiga')
    expect(hasLegacyApiKey()).toBe(true)
    removeLegacyApiKey()
    expect(hasLegacyApiKey()).toBe(false)
    expect(localStorage.getItem('ifs.openai.apiKey')).toBeNull()
  })
})
