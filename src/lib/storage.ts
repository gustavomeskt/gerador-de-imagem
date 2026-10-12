const API_KEY_STORAGE = 'ifs.openai.apiKey'
const IMAGE_PRESET_STORAGE = 'ifs.imageNode.preset'
const FLOWS_STORAGE = 'ifs.flows'

export interface ImageNodePreset {
  model: string
  size: string
  quality?: string
  count: number
}

export function loadApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function saveApiKey(key: string) {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key)
    else localStorage.removeItem(API_KEY_STORAGE)
  } catch {
    // localStorage indisponível (modo privado etc.) — ignora
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
