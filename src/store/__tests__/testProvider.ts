import type { GeneratedImage, ImageGenerationRequest, ImageProvider } from '../../generation/types'
import { dataUrlToBytes } from '../../lib/binary'
import { labelFromDataUrl, svgImage } from '../../test/fixtures'

// Provedor controlado pelo teste: cada chamada fica pendente até o teste
// decidir resolver/rejeitar, pra simular corridas (ex.: remover uma imagem
// enquanto as outras ainda carregam).
export interface PendingCall {
  request: ImageGenerationRequest
  resolve: (images: GeneratedImage[]) => void
  reject: (err: Error) => void
}

interface TestingState {
  pending: PendingCall[]
  providerKinds: string[]
}

// guardado no globalThis pra sobreviver ao vi.resetModules() (que simula
// recarregar a página e recriaria este módulo)
const holder = globalThis as typeof globalThis & { __ifsTesting?: TestingState }
export const testing: TestingState = (holder.__ifsTesting ??= { pending: [], providerKinds: [] })

export function testProvider(kind: string): ImageProvider {
  testing.providerKinds.push(kind)
  return {
    kind: 'mock',
    label: 'teste',
    generateImages: (request) => new Promise((resolve, reject) => testing.pending.push({ request, resolve, reject })),
    enhancePrompt: async (prompt) => `${prompt} (melhorado)`,
  }
}

// recorte de verdade precisa de canvas: aqui marca o rótulo com "#crop"
export async function fakeCrop(src: string): Promise<string> {
  const label = labelFromDataUrl(src) ?? new TextDecoder().decode(dataUrlToBytes(src).bytes)
  return svgImage(`${label}#crop`).src
}
