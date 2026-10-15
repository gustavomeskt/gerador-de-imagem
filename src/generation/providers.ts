import { createBackendProvider } from './backendProvider'
import { createMockProvider } from './mockProvider'
import type { ImageProvider, ProviderKind } from './types'

export const PROVIDER_KINDS: ProviderKind[] = ['mock', 'backend']

export const DEFAULT_PROVIDER: ProviderKind = 'mock'

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as string[]).includes(value)
}

const instances: Partial<Record<ProviderKind, ImageProvider>> = {}

function create(kind: ProviderKind): ImageProvider {
  switch (kind) {
    case 'mock':
      return createMockProvider({ latencyMs: 600 })
    case 'backend':
      return createBackendProvider()
  }
}

export function getProvider(kind: ProviderKind): ImageProvider {
  return (instances[kind] ??= create(kind))
}
