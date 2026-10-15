import { renderMockSvg } from '../src/generation/mockProvider'
import type { ImageClient } from './openaiClient'

// Modo simulado do servidor: percorre exatamente o mesmo caminho do modo real
// (validação, orçamento, confirmação, limites), mas em vez de chamar a OpenAI
// devolve imagens de teste. Nada é cobrado.

let sequence = 0

export function createSimulatedClient(options: { latencyMs?: number } = {}): ImageClient {
  const wait = () =>
    options.latencyMs ? new Promise((resolve) => setTimeout(resolve, options.latencyMs)) : Promise.resolve()

  return {
    async generateImages(request) {
      await wait()
      return Array.from({ length: request.n }, () => {
        sequence += 1
        const svg = renderMockSvg({ ...request, prompt: `[servidor simulado] ${request.prompt}`, index: sequence })
        return { b64: Buffer.from(svg, 'utf8').toString('base64'), mimeType: 'image/svg+xml' }
      })
    },

    async enhancePrompt(prompt) {
      await wait()
      return `${prompt}\n\n[servidor simulado] Prompt melhorado de teste, sem alterar o pedido original.`
    },
  }
}
