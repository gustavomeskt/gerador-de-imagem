import { DEFAULT_PROVIDER, isProviderKind } from '../generation/providers'
import type { ProviderKind } from '../generation/types'

// Chave antiga onde a API key da OpenAI ficava salva no navegador. O app não
// lê mais esse valor — a chave passa a morar só no backend. Mantemos o nome
// apenas pra avisar e permitir apagar uma chave que tenha ficado salva.
const LEGACY_API_KEY_STORAGE = 'ifs.openai.apiKey'
const PROVIDER_STORAGE = 'ifs.provider'
const IMAGE_PRESET_STORAGE = 'ifs.imageNode.preset'
const FLOWS_STORAGE = 'ifs.flows'

export interface ImageNodePreset {
  model: string
  size: string
  quality?: string
  count: number
}

export function hasLegacyApiKey(): boolean {
  try {
    return !!localStorage.getItem(LEGACY_API_KEY_STORAGE)
  } catch {
    return false
  }
}

export function removeLegacyApiKey() {
  try {
    localStorage.removeItem(LEGACY_API_KEY_STORAGE)
  } catch {
    // localStorage indisponível (modo privado etc.) — ignora
  }
}

export function loadProviderKind(): ProviderKind {
  try {
    const raw = localStorage.getItem(PROVIDER_STORAGE)
    return isProviderKind(raw) ? raw : DEFAULT_PROVIDER
  } catch {
    return DEFAULT_PROVIDER
  }
}

export function saveProviderKind(kind: ProviderKind) {
  try {
    localStorage.setItem(PROVIDER_STORAGE, kind)
  } catch {
    // ignora
  }
}

export function loadImagePreset(): ImageNodePreset | null {
  try {
    const raw = localStorage.getItem(IMAGE_PRESET_STORAGE)
    return raw ? (JSON.parse(raw) as ImageNodePreset) : null
  } catch {
    return null
  }
}

export function saveImagePreset(preset: ImageNodePreset) {
  try {
    localStorage.setItem(IMAGE_PRESET_STORAGE, JSON.stringify(preset))
  } catch {
    // ignora
  }
}

// Mapa bruto { flowId: FlowRecord } — a tipagem de FlowRecord fica no store,
// aqui só lemos/gravamos JSON genérico pra não criar dependência circular.
export function loadFlowsRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(FLOWS_STORAGE)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveFlowsRaw(flows: Record<string, unknown>): boolean {
  try {
    localStorage.setItem(FLOWS_STORAGE, JSON.stringify(flows))
    return true
  } catch {
    return false
  }
}
