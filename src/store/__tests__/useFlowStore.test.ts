import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeneratedImage, ImageGenerationRequest, ImageProvider } from '../../generation/types'

// Provedor controlado pelo teste: cada chamada fica pendente até o teste
// decidir resolver/rejeitar, pra simular corridas (ex.: remover uma imagem
// enquanto as outras ainda carregam).
const testing = vi.hoisted(() => {
  interface Pending {
    request: ImageGenerationRequest
    resolve: (images: GeneratedImage[]) => void
    reject: (err: Error) => void
  }
  const state = {
    pending: [] as Pending[],
    providerKinds: [] as string[],
  }
  return state
})

vi.mock('../../generation/providers', () => ({
  getProvider: (kind: string): ImageProvider => {
    testing.providerKinds.push(kind)
    return {
      kind: 'mock',
      label: 'teste',
      generateImages: (request) =>
        new Promise((resolve, reject) => testing.pending.push({ request, resolve, reject })),
      enhancePrompt: async (prompt) => `${prompt} (melhorado)`,
    }
  },
  isProviderKind: (v: unknown) => v === 'mock' || v === 'backend',
  DEFAULT_PROVIDER: 'mock',
  PROVIDER_KINDS: ['mock', 'backend'],
}))

// recorte de verdade precisa de canvas; aqui só marcamos que passou por ele
vi.mock('../../lib/image', () => ({
  cropToAspect: async (src: string) => `${src}#crop`,
}))

const { useFlowStore, flushDirtyFlows } = await import('../useFlowStore')
type ImageFlowNode = import('../useFlowStore').ImageFlowNode

const img = (src: string): GeneratedImage => ({ src, mimeType: 'image/svg+xml' })

async function settle() {
  // deixa as promessas encadeadas (allSettled + recorte) terminarem
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setupFlow(prompt = 'Uma mulher na cozinha') {
  const store = useFlowStore.getState()
  const flowId = store.createFlow()
  store.addPromptNode(flowId, { x: 0, y: 0 })
  store.addImageNode(flowId, { x: 400, y: 0 })
  const [promptNode, imageNode] = useFlowStore.getState().flowsData[flowId].nodes
  store.updatePromptData(flowId, promptNode.id, { prompt })
  store.onConnect(flowId, {
    source: promptNode.id,
    sourceHandle: 'prompt-out',
    target: imageNode.id,
    targetHandle: 'prompt-in',
  })
  return { flowId, promptId: promptNode.id, imageId: imageNode.id }
}

function imageNode(flowId: string, imageId: string): ImageFlowNode {
  return useFlowStore.getState().flowsData[flowId].nodes.find((n) => n.id === imageId) as ImageFlowNode
}

beforeEach(() => {
  testing.pending.length = 0
  testing.providerKinds.length = 0
})

describe('geração no store', () => {
  it('avisa quando não há prompt conectado e não chama o provedor', async () => {
    const store = useFlowStore.getState()
    const flowId = store.createFlow()
    store.addImageNode(flowId, { x: 0, y: 0 })
    const id = useFlowStore.getState().flowsData[flowId].nodes[0].id

    await store.generate(flowId, id)

    expect(imageNode(flowId, id).data.notice).toMatch(/Conecte um nó de prompt/)
    expect(testing.pending).toHaveLength(0)
  })

  it('gera N imagens com o provedor selecionado, sem API key', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.setProviderKind('mock')
    store.updateImageConfig(flowId, imageId, { model: 'gpt-image-1.5', size: '1024x1024', count: 3 })

    const running = store.generate(flowId, imageId)
    expect(imageNode(flowId, imageId).data.images.map((s) => s.status)).toEqual(['loading', 'loading', 'loading'])
    expect(testing.providerKinds).toEqual(['mock'])
    expect(testing.pending[0].request).toEqual({
      model: 'gpt-image-1.5',
      prompt: 'Uma mulher na cozinha',
      size: '1024x1024',
      quality: undefined,
      n: 3,
    })

    testing.pending[0].resolve([img('a'), img('b'), img('c')])
    await running

    const slots = imageNode(flowId, imageId).data.images
    expect(slots.map((s) => [s.status, s.src])).toEqual([
      ['done', 'a'],
      ['done', 'b'],
      ['done', 'c'],
    ])
    expect(imageNode(flowId, imageId).data.notice).toBeUndefined()
  })

  it('BUG corrigido: remover uma imagem durante a geração não desalinha as outras', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'dall-e-3', size: '1024x1024', count: 3 })

    const running = store.generate(flowId, imageId)
    const [first, second, third] = imageNode(flowId, imageId).data.images
    expect(testing.pending).toHaveLength(3) // dall-e-3: uma chamada por imagem

    store.deleteSlot(flowId, imageId, first.id)
    testing.pending[0].resolve([img('primeira')])
    testing.pending[1].resolve([img('segunda')])
    testing.pending[2].resolve([img('terceira')])
    await running

    const slots = imageNode(flowId, imageId).data.images
    expect(slots.map((s) => s.id)).toEqual([second.id, third.id])
    expect(slots.map((s) => s.src)).toEqual(['segunda', 'terceira'])
  })

  it('falha parcial mantém as imagens que deram certo e avisa', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'dall-e-3', size: '1024x1024', count: 2 })

    const running = store.generate(flowId, imageId)
    testing.pending[0].resolve([img('ok')])
    testing.pending[1].reject(new Error('limite de requisições'))
    await running

    const node = imageNode(flowId, imageId)
    expect(node.data.images.map((s) => s.status)).toEqual(['done', 'error'])
    expect(node.data.images[1].error).toBe('limite de requisições')
    expect(node.data.notice).toBe('1 de 2 imagens falharam: limite de requisições')
  })

  it('aplica o recorte nos formatos 9:16', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'gpt-image-1.5', size: '1024x1536', count: 1 })

    const running = store.generate(flowId, imageId)
    testing.pending[0].resolve([img('vertical')])
    await running

    const [slot] = imageNode(flowId, imageId).data.images
    expect(slot.src).toBe('vertical#crop')
    expect(slot.aspect).toBeCloseTo(9 / 16)
  })
})

describe('regerar uma imagem', () => {
  async function generateOne(size = '1024x1024') {
    const ids = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(ids.flowId, ids.imageId, { model: 'gpt-image-1.5', size, count: 2 })
    const running = store.generate(ids.flowId, ids.imageId)
    testing.pending[0].resolve([img('aprovada'), img('ruim')])
    await running
    testing.pending.length = 0
    return ids
  }

  it('troca só a imagem escolhida e preserva as outras', async () => {
    const { flowId, imageId } = await generateOne()
    const store = useFlowStore.getState()
    const [approved, bad] = imageNode(flowId, imageId).data.images

    const running = store.regenerateSlot(flowId, imageId, bad.id)
    expect(imageNode(flowId, imageId).data.images[0]).toEqual(approved)
    expect(testing.pending[0].request.n).toBe(1)
    testing.pending[0].resolve([img('corrigida')])
    await running

    const slots = imageNode(flowId, imageId).data.images
    expect(slots[0]).toEqual(approved)
    expect(slots[1]).toMatchObject({ id: bad.id, status: 'done', src: 'corrigida' })
  })

  it('BUG corrigido: a proporção do slot acompanha a configuração atual', async () => {
    const { flowId, imageId } = await generateOne('1024x1024')
    const store = useFlowStore.getState()
    const [, bad] = imageNode(flowId, imageId).data.images
    expect(bad.aspect).toBe(1)

    store.updateImageConfig(flowId, imageId, { size: '1024x1536' })
    const running = store.regenerateSlot(flowId, imageId, bad.id)
    expect(imageNode(flowId, imageId).data.images[1].aspect).toBeCloseTo(9 / 16)
    testing.pending[0].resolve([img('vertical')])
    await running

    const slot = imageNode(flowId, imageId).data.images[1]
    expect(slot.aspect).toBeCloseTo(9 / 16)
    expect(slot.src).toBe('vertical#crop')
  })

  it('se a regeração falhar, mantém a imagem anterior', async () => {
    const { flowId, imageId } = await generateOne()
    const store = useFlowStore.getState()
    const [, bad] = imageNode(flowId, imageId).data.images

    const running = store.regenerateSlot(flowId, imageId, bad.id)
    testing.pending[0].reject(new Error('servidor fora do ar'))
    await running

    const node = imageNode(flowId, imageId)
    expect(node.data.images[1]).toEqual(bad)
    expect(node.data.notice).toMatch(/imagem anterior foi mantida.*servidor fora do ar/)
  })
})

describe('persistência e outros', () => {
  it('não salva imagens no localStorage, só a estrutura', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'gpt-image-1.5', size: '1024x1024', count: 1 })
    const running = store.generate(flowId, imageId)
    testing.pending[0].resolve([img('data:image/svg+xml;base64,PESADO')])
    await running

    flushDirtyFlows()
    const saved = JSON.parse(localStorage.getItem('ifs.flows') ?? '{}')
    const savedImage = saved[flowId].nodes.find((n: { id: string }) => n.id === imageId)
    expect(savedImage.data.images).toEqual([])
    expect(JSON.stringify(saved)).not.toContain('PESADO')
  })

  it('apagar o fluxo durante a geração não o recria', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    const running = store.generate(flowId, imageId)
    store.deleteFlow(flowId)
    testing.pending[0].resolve([img('tarde demais')])
    await running
    await settle()

    expect(useFlowStore.getState().flowsData[flowId]).toBeUndefined()
  })

  it('melhora o prompt pelo provedor', async () => {
    const { flowId, promptId } = setupFlow('gato')
    await useFlowStore.getState().enhancePrompt(flowId, promptId)
    const node = useFlowStore.getState().flowsData[flowId].nodes.find((n) => n.id === promptId)
    expect(node?.data.prompt).toBe('gato (melhorado)')
  })

  it('o store não guarda nem lê API key', () => {
    localStorage.setItem('ifs.openai.apiKey', 'sk-antiga')
    expect(JSON.stringify(Object.keys(useFlowStore.getState()))).not.toMatch(/apiKey/i)
  })
})
