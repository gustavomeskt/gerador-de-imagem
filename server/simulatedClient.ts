import { renderMockSvg } from '../src/generation/mockProvider'
import { simulateInterpretation } from '../src/story/simulatedInterpreter'
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

    async editImages(request) {
      await wait()
      const refs = request.references ?? []
      // mostra na imagem quantas referências chegaram e o começo do hash de
      // cada uma — prova que os bytes chegaram até aqui
      const summary = refs.map((r, i) => `#${i + 1} ${r.mimeType.replace('image/', '')} ${r.width}x${r.height} ${r.sha256.slice(0, 8)}`).join(' | ')
      return Array.from({ length: request.n }, () => {
        sequence += 1
        const svg = renderMockSvg({
          ...request,
          prompt: `[servidor simulado · ${refs.length} referência(s) · fidelidade ${request.inputFidelity ?? 'padrão'}] ${summary} — ${request.prompt}`,
          index: sequence,
        })
        return { b64: Buffer.from(svg, 'utf8').toString('base64'), mimeType: 'image/svg+xml' }
      })
    },

    async enhancePrompt(prompt) {
      await wait()
      return `${prompt}\n\n[servidor simulado] Prompt melhorado de teste, sem alterar o pedido original.`
    },

    // mesmo interpretador por regras do navegador — nenhum modelo de IA
    async interpretStory(input) {
      await wait()
      return simulateInterpretation(input.chunk, input.libraryNames)
    },
  }
}
