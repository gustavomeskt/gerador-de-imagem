import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CostQuote, GeneratedImage, ImageGenerationRequest, ImageJob, ImageProvider } from '../../generation/types'
import { svgImage as img } from '../../test/fixtures'
import { AWAITING_CONFIRMATION_MESSAGE, GENERATION_CANCELLED_MESSAGE, useFlowStore, type ImageFlowNode } from '../useFlowStore'

// Provedor "pago" de teste: exige orçamento antes de gerar.
const paid = vi.hoisted(() => ({
  quotes: [] as unknown[],
  calls: [] as Array<{ request: unknown; quoteId?: string }>,
  enhanceCalls: [] as Array<{ prompt: string; quoteId?: string }>,
  quoteError: null as Error | null,
}))

function makeQuote(kind: 'images' | 'enhance', images: number): CostQuote {
  return {
    quoteId: `q-${paid.quotes.length}`,
    kind,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mode: 'openai',
    paid: true,
    estimatedUsd: 0.25 * images,
    images,
    breakdown: [`${images} × US$ 0.25`],
    notes: [],
  }
}

vi.mock('../../generation/providers', () => {
  const provider: ImageProvider = {
    kind: 'backend',
    label: 'pago (teste)',
    async quoteImages(job: ImageJob) {
      if (paid.quoteError) throw paid.quoteError
      paid.quotes.push(job)
      return makeQuote('images', job.totalImages)
    },
    async quoteEnhance(prompt: string) {
      paid.quotes.push({ prompt })
      return makeQuote('enhance', 0)
    },
    async generateImages(request: ImageGenerationRequest, options) {
      paid.calls.push({ request, quoteId: options?.quoteId })
      return Array.from({ length: request.n }, (_, i): GeneratedImage => img(`paga-${i}`))
    },
    async enhancePrompt(prompt, options) {
      paid.enhanceCalls.push({ prompt, quoteId: options?.quoteId })
      return `${prompt} (melhorado)`
    },
  }
  return {
    getProvider: () => provider,
    isProviderKind: (v: unknown) => v === 'mock' || v === 'backend',
    DEFAULT_PROVIDER: 'mock',
    PROVIDER_KINDS: ['mock', 'backend'],
    backendProvider: provider,
  }
})
vi.mock('../../lib/image', async () => ({ cropToAspect: (await import('./testProvider')).fakeCrop }))

await useFlowStore.getState().hydrate()

function setupFlow() {
  const s = useFlowStore.getState()
  const flowId = s.createFlow()
  s.updateStyleGuide(flowId, { enabled: false }) // guia de estilo testado à parte
  s.addPromptNode(flowId, { x: 0, y: 0 })
  s.addImageNode(flowId, { x: 400, y: 0 })
  const [p, i] = useFlowStore.getState().flowsData[flowId].nodes
  s.updatePromptData(flowId, p.id, { prompt: 'cena paga' })
  s.updateImageConfig(flowId, i.id, { model: 'gpt-image-1', size: '1024x1024', quality: 'low', count: 2 })
  s.onConnect(flowId, { source: p.id, sourceHandle: 'prompt-out', target: i.id, targetHandle: 'prompt-in' })
  return { flowId, promptId: p.id, imageId: i.id }
}

const node = (flowId: string, id: string) =>
  useFlowStore.getState().flowsData[flowId].nodes.find((n) => n.id === id) as ImageFlowNode

async function waitForConfirmation() {
  await vi.waitFor(() => expect(useFlowStore.getState().costConfirmation).not.toBeNull())
  return useFlowStore.getState().costConfirmation!
}

beforeEach(() => {
  paid.quotes.length = 0
  paid.calls.length = 0
  paid.enhanceCalls.length = 0
  paid.quoteError = null
})

describe('confirmação explícita antes de chamadas pagas', () => {
  it('mostra o orçamento e só gera depois de confirmar, com o quoteId', async () => {
    const { flowId, imageId } = setupFlow()
    const running = useFlowStore.getState().generate(flowId, imageId)

    const request = await waitForConfirmation()
    expect(request.title).toBe('Gerar 2 imagem(ns)')
    expect(request.quote.estimatedUsd).toBe(0.5)
    expect(paid.quotes[0]).toEqual({ model: 'gpt-image-1', size: '1024x1024', quality: 'low', prompt: 'cena paga', totalImages: 2 })
    expect(paid.calls).toHaveLength(0) // nada foi chamado ainda
    expect(node(flowId, imageId).data.notice).toBe(AWAITING_CONFIRMATION_MESSAGE)

    useFlowStore.getState().resolveCostConfirmation(true)
    await running

    expect(paid.calls).toEqual([{ request: expect.objectContaining({ n: 2 }), quoteId: 'q-1' }])
    expect(node(flowId, imageId).data.images.map((s) => s.status)).toEqual(['done', 'done'])
    expect(useFlowStore.getState().costConfirmation).toBeNull()
  })

  it('cancelar não faz nenhuma chamada e mantém as imagens que já existiam', async () => {
    const { flowId, imageId } = setupFlow()
    const first = useFlowStore.getState().generate(flowId, imageId)
    await waitForConfirmation()
    useFlowStore.getState().resolveCostConfirmation(true)
    await first
    const before = node(flowId, imageId).data.images
    paid.calls.length = 0

    const second = useFlowStore.getState().generate(flowId, imageId)
    await waitForConfirmation()
    useFlowStore.getState().resolveCostConfirmation(false)
    await second

    expect(paid.calls).toHaveLength(0)
    expect(node(flowId, imageId).data.images).toEqual(before)
    expect(node(flowId, imageId).data.notice).toBe(GENERATION_CANCELLED_MESSAGE)
  })

  it('regerar uma imagem pede orçamento de 1 imagem', async () => {
    const { flowId, imageId } = setupFlow()
    const first = useFlowStore.getState().generate(flowId, imageId)
    await waitForConfirmation()
    useFlowStore.getState().resolveCostConfirmation(true)
    await first

    const slot = node(flowId, imageId).data.images[1]
    const regen = useFlowStore.getState().regenerateSlot(flowId, imageId, slot.id)
    const request = await waitForConfirmation()
    expect(request.title).toBe('Gerar de novo 1 imagem')
    expect((paid.quotes.at(-1) as ImageJob).totalImages).toBe(1)
    useFlowStore.getState().resolveCostConfirmation(true)
    await regen
    expect(paid.calls.at(-1)).toEqual({ request: expect.objectContaining({ n: 1 }), quoteId: 'q-2' })
    expect(node(flowId, imageId).data.notice).toBeUndefined()
  })

  it('erro ao orçar (servidor fora, limite atingido) aparece no nó e nada é gerado', async () => {
    const { flowId, imageId } = setupFlow()
    paid.quoteError = new Error('Limite diário de imagens atingido (50/50).')
    await useFlowStore.getState().generate(flowId, imageId)
    expect(node(flowId, imageId).data.notice).toBe('Limite diário de imagens atingido (50/50).')
    expect(useFlowStore.getState().costConfirmation).toBeNull()
    expect(paid.calls).toHaveLength(0)
  })

  it('melhorar prompt também pede confirmação', async () => {
    const { flowId, promptId } = setupFlow()
    const cancelled = useFlowStore.getState().enhancePrompt(flowId, promptId)
    await waitForConfirmation()
    useFlowStore.getState().resolveCostConfirmation(false)
    await cancelled
    expect(paid.enhanceCalls).toHaveLength(0)

    const confirmed = useFlowStore.getState().enhancePrompt(flowId, promptId)
    const request = await waitForConfirmation()
    expect(request.title).toBe('Melhorar prompt')
    useFlowStore.getState().resolveCostConfirmation(true)
    await confirmed
    expect(paid.enhanceCalls).toEqual([{ prompt: 'cena paga', quoteId: 'q-2' }])
  })

  it('um novo pedido de confirmação cancela o anterior (nunca dois abertos)', async () => {
    const a = setupFlow()
    const b = setupFlow()
    const first = useFlowStore.getState().generate(a.flowId, a.imageId)
    await waitForConfirmation()
    const second = useFlowStore.getState().generate(b.flowId, b.imageId)
    await vi.waitFor(() => expect(paid.quotes).toHaveLength(2))
    await first // o primeiro foi cancelado automaticamente
    expect(node(a.flowId, a.imageId).data.notice).toBe(GENERATION_CANCELLED_MESSAGE)
    useFlowStore.getState().resolveCostConfirmation(true)
    await second
    expect(paid.calls).toHaveLength(1)
  })
})
