import { beforeEach, describe, expect, it, vi } from 'vitest'
import { repository } from '../../persistence/repository'
import { labelFromBytes, labelFromDataUrl, svgImage as img } from '../../test/fixtures'
import { flushDirtyFlows, useFlowStore, type ImageFlowNode, type ImageSlot } from '../useFlowStore'
import { testing } from './testProvider'

vi.mock('../../generation/providers', async () => {
  const { testProvider } = await import('./testProvider')
  return {
    getProvider: testProvider,
    isProviderKind: (v: unknown) => v === 'mock' || v === 'backend',
    DEFAULT_PROVIDER: 'mock',
    PROVIDER_KINDS: ['mock', 'backend'],
  }
})

vi.mock('../../lib/image', async () => ({ cropToAspect: (await import('./testProvider')).fakeCrop }))

await useFlowStore.getState().hydrate()

// rótulo da imagem de um slot, lendo do banco quando ela foi salva
async function labelOf(slot: ImageSlot): Promise<string | undefined> {
  if (slot.assetId) {
    const asset = await repository.getAsset(slot.assetId)
    return asset && labelFromBytes(asset.bytes)
  }
  return slot.src ? labelFromDataUrl(slot.src) : undefined
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
  useFlowStore.getState().dismissStorageIssue()
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

  it('gera N imagens com o provedor selecionado, sem API key, e salva cada uma', async () => {
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
    expect(slots.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect(slots.every((s) => s.assetId && !s.unsaved)).toBe(true)
    expect(await Promise.all(slots.map(labelOf))).toEqual(['a', 'b', 'c'])
    expect(imageNode(flowId, imageId).data.notice).toBeUndefined()

    // o arquivo salvo guarda a origem da imagem
    const asset = await repository.getAsset(slots[0].assetId!)
    expect(asset).toMatchObject({
      projectId: flowId,
      kind: 'generated',
      width: 100,
      height: 100,
      source: { nodeId: imageId, slotId: slots[0].id, prompt: 'Uma mulher na cozinha', model: 'gpt-image-1.5', provider: 'mock' },
    })
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
    expect(await Promise.all(slots.map(labelOf))).toEqual(['segunda', 'terceira'])
    // a imagem do slot removido não fica guardada à toa
    const stored = await repository.listAssetsByProject(flowId)
    expect(stored.map((a) => labelFromBytes(a.bytes)).sort()).toEqual(['segunda', 'terceira'])
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
    expect(await labelOf(slot)).toBe('vertical#crop')
    expect(slot.aspect).toBeCloseTo(9 / 16)
  })

  it('nova geração que falha por completo mantém as imagens anteriores (e os arquivos)', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'gpt-image-1.5', size: '1024x1024', count: 2 })
    const first = store.generate(flowId, imageId)
    testing.pending[0].resolve([img('aprovada-1'), img('aprovada-2')])
    await first
    const approved = imageNode(flowId, imageId).data.images

    const second = store.generate(flowId, imageId)
    testing.pending[1].reject(new Error('servidor fora do ar'))
    await second

    const node = imageNode(flowId, imageId)
    expect(node.data.images).toEqual(approved)
    expect(node.data.notice).toMatch(/imagens anteriores foram mantidas.*servidor fora do ar/)
    expect((await repository.listAssetsByProject(flowId)).length).toBe(2)
  })

  it('nova geração bem-sucedida substitui as imagens e apaga os arquivos antigos', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'gpt-image-1.5', size: '1024x1024', count: 1 })
    const first = store.generate(flowId, imageId)
    testing.pending[0].resolve([img('velha')])
    await first

    const second = store.generate(flowId, imageId)
    testing.pending[1].resolve([img('nova')])
    await second

    const stored = await repository.listAssetsByProject(flowId)
    expect(stored.map((a) => labelFromBytes(a.bytes))).toEqual(['nova'])
  })
})

describe('regerar uma imagem', () => {
  async function generateTwo(size = '1024x1024') {
    const ids = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(ids.flowId, ids.imageId, { model: 'gpt-image-1.5', size, count: 2 })
    const running = store.generate(ids.flowId, ids.imageId)
    testing.pending[0].resolve([img('aprovada'), img('ruim')])
    await running
    testing.pending.length = 0
    return ids
  }

  it('troca só a imagem escolhida, preserva as outras e substitui o arquivo', async () => {
    const { flowId, imageId } = await generateTwo()
    const store = useFlowStore.getState()
    const [approved, bad] = imageNode(flowId, imageId).data.images

    const running = store.regenerateSlot(flowId, imageId, bad.id)
    expect(imageNode(flowId, imageId).data.images[0]).toEqual(approved)
    expect(testing.pending[0].request.n).toBe(1)
    testing.pending[0].resolve([img('corrigida')])
    await running

    const slots = imageNode(flowId, imageId).data.images
    expect(slots[0]).toEqual(approved)
    expect(slots[1]).toMatchObject({ id: bad.id, status: 'done' })
    expect(await labelOf(slots[1])).toBe('corrigida')
    expect(await repository.getAsset(bad.assetId!)).toBeUndefined() // arquivo antigo apagado
    expect(await repository.getAsset(approved.assetId!)).toBeDefined()
  })

  it('BUG corrigido: a proporção do slot acompanha a configuração atual', async () => {
    const { flowId, imageId } = await generateTwo('1024x1024')
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
    expect(await labelOf(slot)).toBe('vertical#crop')
  })

  it('se a regeração falhar, mantém a imagem anterior e o arquivo dela', async () => {
    const { flowId, imageId } = await generateTwo()
    const store = useFlowStore.getState()
    const [, bad] = imageNode(flowId, imageId).data.images

    const running = store.regenerateSlot(flowId, imageId, bad.id)
    testing.pending[0].reject(new Error('servidor fora do ar'))
    await running

    const node = imageNode(flowId, imageId)
    expect(node.data.images[1]).toEqual(bad)
    expect(node.data.notice).toMatch(/imagem anterior foi mantida.*servidor fora do ar/)
    expect(await repository.getAsset(bad.assetId!)).toBeDefined()
  })
})

describe('exclusão', () => {
  async function generated() {
    const ids = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(ids.flowId, ids.imageId, { model: 'gpt-image-1.5', size: '1024x1024', count: 2 })
    const running = store.generate(ids.flowId, ids.imageId)
    testing.pending[0].resolve([img('um'), img('dois')])
    await running
    return ids
  }

  it('remover uma imagem apaga o arquivo dela', async () => {
    const { flowId, imageId } = await generated()
    const [first, second] = imageNode(flowId, imageId).data.images
    useFlowStore.getState().deleteSlot(flowId, imageId, first.id)
    await vi.waitFor(async () => expect(await repository.getAsset(first.assetId!)).toBeUndefined())
    expect(await repository.getAsset(second.assetId!)).toBeDefined()
  })

  it('apagar o nó pela tecla Delete (React Flow) apaga os arquivos dele', async () => {
    const { flowId, imageId } = await generated()
    useFlowStore.getState().onNodesChange(flowId, [{ type: 'remove', id: imageId }])
    await vi.waitFor(async () => expect(await repository.listAssetsByProject(flowId)).toEqual([]))
  })

  it('apagar o fluxo apaga o projeto e todos os arquivos', async () => {
    const { flowId } = await generated()
    await flushDirtyFlows()
    useFlowStore.getState().deleteFlow(flowId)
    await vi.waitFor(async () => {
      expect((await repository.listProjects()).some((p) => p.id === flowId)).toBe(false)
      expect(await repository.listAssetsByProject(flowId)).toEqual([])
    })
  })

  it('apagar o fluxo durante a geração não o recria nem deixa arquivos', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    const running = store.generate(flowId, imageId)
    store.deleteFlow(flowId)
    testing.pending[0].resolve([img('tarde demais')])
    await running

    expect(useFlowStore.getState().flowsData[flowId]).toBeUndefined()
    await vi.waitFor(async () => expect(await repository.listAssetsByProject(flowId)).toEqual([]))
  })
})

describe('outros', () => {
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

  it('a estrutura salva no banco não contém bytes nem URLs das imagens', async () => {
    const { flowId, imageId } = setupFlow()
    const store = useFlowStore.getState()
    store.updateImageConfig(flowId, imageId, { model: 'gpt-image-1.5', size: '1024x1024', count: 1 })
    const running = store.generate(flowId, imageId)
    testing.pending[0].resolve([img('PESADO')])
    await running
    await flushDirtyFlows()

    const saved = (await repository.listProjects()).find((p) => p.id === flowId)!
    const savedImage = saved.nodes.find((n) => n.id === imageId)!
    expect(savedImage.data.images).toEqual([
      { id: imageNode(flowId, imageId).data.images[0].id, assetId: expect.any(String), aspect: 1 },
    ])
    expect(JSON.stringify(saved)).not.toMatch(/blob:|data:image|PESADO/)
  })
})
