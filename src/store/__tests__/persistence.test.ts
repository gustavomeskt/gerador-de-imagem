import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_MESSAGES } from '../../persistence/errors'
import { fileFrom, jpegBytes, labelFromBytes, pngBytes, svgImage as img } from '../../test/fixtures'
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

type DbModule = typeof import('../../persistence/db')
type StoreModule = typeof import('../useFlowStore')
type RepoModule = typeof import('../../persistence/repository')

let currentDb: DbModule | null = null

// Simula abrir o app do zero (como depois de atualizar a página): módulos
// novos, store novo, conexão nova com o MESMO banco.
async function openApp(beforeHydrate?: (repo: RepoModule['repository']) => void) {
  await currentDb?.closeDbForTests()
  vi.resetModules()
  currentDb = await import('../../persistence/db')
  const { repository } = await import('../../persistence/repository')
  beforeHydrate?.(repository)
  const store: StoreModule = await import('../useFlowStore')
  await store.useFlowStore.getState().hydrate()
  return { ...store, repository }
}

function buildFlow(app: StoreModule, prompt = 'cena da cozinha') {
  const state = app.useFlowStore.getState()
  const flowId = state.createFlow()
  state.renameFlow(flowId, 'Campanha Gelatina')
  state.addPromptNode(flowId, { x: 0, y: 0 })
  state.addImageNode(flowId, { x: 400, y: 0 })
  const [p, i] = app.useFlowStore.getState().flowsData[flowId].nodes
  state.updatePromptData(flowId, p.id, { prompt })
  state.updateImageConfig(flowId, i.id, { model: 'gpt-image-1.5', size: '1024x1024', count: 2 })
  state.onConnect(flowId, { source: p.id, sourceHandle: 'prompt-out', target: i.id, targetHandle: 'prompt-in' })
  return { flowId, imageId: i.id }
}

function images(app: StoreModule, flowId: string, imageId: string) {
  const node = app.useFlowStore.getState().flowsData[flowId]?.nodes.find((n) => n.id === imageId)
  return node?.type === 'image' ? node.data.images : []
}

async function labels(app: StoreModule & { repository: RepoModule['repository'] }, flowId: string, imageId: string) {
  return Promise.all(
    images(app, flowId, imageId).map(async (s) => {
      const asset = s.assetId ? await app.repository.getAsset(s.assetId) : undefined
      return asset ? labelFromBytes(asset.bytes) : undefined
    }),
  )
}

beforeEach(async () => {
  testing.pending.length = 0
  localStorage.clear()
  await currentDb?.resetDbForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('restauração após atualizar ou fechar o app', () => {
  it('na primeira abertura, sem dados, cria o "Fluxo 1"', async () => {
    const app = await openApp()
    expect(app.useFlowStore.getState().flows.map((f) => f.name)).toEqual(['Fluxo 1'])
    expect(app.useFlowStore.getState().persistence).toBe('indexeddb')
    // e ele já fica salvo
    expect((await app.repository.listProjects()).map((p) => p.name)).toEqual(['Fluxo 1'])
  })

  it('projetos e imagens geradas continuam lá depois de recarregar', async () => {
    const app = await openApp()
    const { flowId, imageId } = buildFlow(app)
    const running = app.useFlowStore.getState().generate(flowId, imageId)
    testing.pending[0].resolve([img('cena-1'), img('cena-2')])
    await running
    await app.flushDirtyFlows()

    const reopened = await openApp()
    const state = reopened.useFlowStore.getState()
    expect(state.flows.find((f) => f.id === flowId)?.name).toBe('Campanha Gelatina')
    const slots = images(reopened, flowId, imageId)
    expect(slots.map((s) => s.status)).toEqual(['done', 'done'])
    expect(slots.every((s) => typeof s.src === 'string' && s.src.length > 0)).toBe(true)
    expect(await labels(reopened, flowId, imageId)).toEqual(['cena-1', 'cena-2'])

    // prompt e conexão também voltam
    const prompt = state.flowsData[flowId].nodes.find((n) => n.type === 'prompt')
    expect(prompt?.data.prompt).toBe('cena da cozinha')
    expect(state.flowsData[flowId].edges).toHaveLength(1)
  })

  it('imagem salva antes da estrutura (app fechado no meio) é recuperada', async () => {
    const app = await openApp()
    const { flowId, imageId } = buildFlow(app)
    await app.flushDirtyFlows()

    // a partir daqui a estrutura não consegue ser salva, só as imagens
    vi.spyOn(app.repository, 'saveProjects').mockRejectedValue(new Error('aba fechada'))
    const running = app.useFlowStore.getState().generate(flowId, imageId)
    testing.pending[0].resolve([img('salva-a-tempo-1'), img('salva-a-tempo-2')])
    await running
    vi.restoreAllMocks()

    const reopened = await openApp()
    expect(await labels(reopened, flowId, imageId)).toEqual(['salva-a-tempo-1', 'salva-a-tempo-2'])
  })

  it('fluxos da versão antiga (localStorage) aparecem e o localStorage não é apagado', async () => {
    const legacy = {
      'flow-1700000000000-1': {
        id: 'flow-1700000000000-1',
        name: 'Fluxo antigo',
        updatedAt: 1700000000000,
        nodes: [{ id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: 'gato' } }],
        edges: [],
      },
    }
    localStorage.setItem('ifs.flows', JSON.stringify(legacy))

    const app = await openApp()
    expect(app.useFlowStore.getState().flows.map((f) => f.name)).toEqual(['Fluxo antigo'])
    expect(JSON.parse(localStorage.getItem('ifs.flows')!)).toEqual(legacy)

    const reopened = await openApp()
    expect(reopened.useFlowStore.getState().flows.map((f) => f.name)).toEqual(['Fluxo antigo'])
  })

  it('arquivos de um fluxo que já não existe são limpos ao abrir', async () => {
    const app = await openApp()
    await app.repository.putAsset({
      id: 'perdido',
      projectId: 'fluxo-inexistente',
      kind: 'generated',
      mimeType: 'image/png',
      bytes: new ArrayBuffer(4),
      byteLength: 4,
      createdAt: 1,
    })
    const reopened = await openApp()
    expect(await reopened.repository.getAsset('perdido')).toBeUndefined()
  })
})

describe('referências após atualizar ou reabrir', () => {
  it('nó de referência volta com nome, tipo, fotos e os mesmos bytes', async () => {
    const app = await openApp()
    const flowId = app.useFlowStore.getState().createFlow()
    app.useFlowStore.getState().addReferenceNode(flowId, { x: 0, y: 0 })
    const refId = app.useFlowStore.getState().flowsData[flowId].nodes[0].id
    app.useFlowStore.getState().updateReferenceData(flowId, refId, { label: 'Maria', role: 'character', preserveClothing: true })
    const photos = [pngBytes(800, 1200, 1), jpegBytes(600, 900, 2)]
    await app.useFlowStore.getState().addReferenceImages(flowId, refId, [fileFrom('a.png', photos[0]), fileFrom('b.jpg', photos[1])])
    await app.flushDirtyFlows()

    const reopened = await openApp()
    const node = reopened.useFlowStore.getState().flowsData[flowId].nodes.find((n) => n.id === refId)
    expect(node?.type).toBe('reference')
    if (node?.type !== 'reference') return
    expect(node.data).toMatchObject({ label: 'Maria', role: 'character', preserveClothing: true })
    expect(node.data.images.map((i) => [i.name, i.width, i.height, !!i.src, i.missing ?? false])).toEqual([
      ['a.png', 800, 1200, true, false],
      ['b.jpg', 600, 900, true, false],
    ])
    for (const [i, img] of node.data.images.entries()) {
      const asset = await reopened.repository.getAsset(img.assetId!)
      expect(new Uint8Array(asset!.bytes)).toEqual(photos[i])
    }
  })

  it('foto salva antes da estrutura volta ao nó; arquivo sumido aparece como ausente', async () => {
    const app = await openApp()
    const flowId = app.useFlowStore.getState().createFlow()
    app.useFlowStore.getState().addReferenceNode(flowId, { x: 0, y: 0 })
    const refId = app.useFlowStore.getState().flowsData[flowId].nodes[0].id
    await app.useFlowStore.getState().addReferenceImages(flowId, refId, [fileFrom('salva.png', pngBytes(10, 10, 3))])
    await app.flushDirtyFlows()

    // a estrutura para de salvar; a segunda foto só chega ao banco de arquivos
    vi.spyOn(app.repository, 'saveProjects').mockRejectedValue(new Error('aba fechada'))
    await app.useFlowStore.getState().addReferenceImages(flowId, refId, [fileFrom('tardia.png', pngBytes(10, 10, 4))])
    const lostAsset = app.useFlowStore.getState().flowsData[flowId].nodes[0]
    vi.restoreAllMocks()
    // e a primeira foto some do armazenamento
    const first = lostAsset.type === 'reference' ? lostAsset.data.images[0].assetId! : ''
    await app.repository.deleteAssets([first])

    const reopened = await openApp()
    const node = reopened.useFlowStore.getState().flowsData[flowId].nodes[0]
    if (node.type !== 'reference') throw new Error('esperava nó de referência')
    expect(node.data.images.map((i) => [i.name, i.missing ?? false])).toEqual([
      ['salva.png', true],
      ['tardia.png', false],
    ])
  })
})

describe('erros de armazenamento', () => {
  it('sem espaço ao salvar: imagem fica na tela marcada como não salva e aparece o aviso', async () => {
    const app = await openApp()
    const { flowId, imageId } = buildFlow(app)
    vi.spyOn(app.repository, 'putAsset').mockRejectedValue(new DOMException('cheio', 'QuotaExceededError'))

    const running = app.useFlowStore.getState().generate(flowId, imageId)
    testing.pending[0].resolve([img('a'), img('b')])
    await running

    const slots = images(app, flowId, imageId)
    expect(slots.map((s) => [s.status, s.unsaved, s.assetId])).toEqual([
      ['done', true, undefined],
      ['done', true, undefined],
    ])
    expect(app.useFlowStore.getState().storageIssue).toEqual({ kind: 'quota', message: STORAGE_MESSAGES.quota })
  })

  it('sem espaço ao regerar: a imagem antiga continua guardada', async () => {
    const app = await openApp()
    const { flowId, imageId } = buildFlow(app)
    const first = app.useFlowStore.getState().generate(flowId, imageId)
    testing.pending[0].resolve([img('aprovada'), img('ruim')])
    await first
    const [, bad] = images(app, flowId, imageId)

    vi.spyOn(app.repository, 'putAsset').mockRejectedValue(new DOMException('cheio', 'QuotaExceededError'))
    const regen = app.useFlowStore.getState().regenerateSlot(flowId, imageId, bad.id)
    testing.pending[1].resolve([img('nova')])
    await regen
    vi.restoreAllMocks()

    expect(images(app, flowId, imageId)[1]).toMatchObject({ status: 'done', unsaved: true })
    expect(await app.repository.getAsset(bad.assetId!)).toBeDefined()

    // ao reabrir, a não salva some, mas a antiga volta (nada se perde do que foi salvo)
    await app.flushDirtyFlows()
    const reopened = await openApp()
    expect((await labels(reopened, flowId, imageId)).sort()).toEqual(['aprovada', 'ruim'])
  })

  it('falha ao salvar a estrutura mostra aviso e tenta de novo depois', async () => {
    const app = await openApp()
    const { flowId } = buildFlow(app)
    const spy = vi.spyOn(app.repository, 'saveProjects').mockRejectedValueOnce(new Error('disco'))
    await app.flushDirtyFlows()
    expect(app.useFlowStore.getState().storageIssue?.kind).toBe('write')

    app.useFlowStore.getState().dismissStorageIssue()
    await app.flushDirtyFlows() // tentativa seguinte funciona
    expect(spy).toHaveBeenCalledTimes(2)
    expect((await app.repository.listProjects()).some((p) => p.id === flowId)).toBe(true)
  })

  it('banco indisponível: o app abre sem salvar, avisa, e ainda gera e exporta', async () => {
    localStorage.setItem(
      'ifs.flows',
      JSON.stringify({ 'flow-1-1': { id: 'flow-1-1', name: 'Do localStorage', updatedAt: 1, nodes: [], edges: [] } }),
    )
    const app = await openApp((repo) => {
      vi.spyOn(repo, 'open').mockRejectedValue(new Error('IndexedDB bloqueado'))
    })
    const state = app.useFlowStore.getState()
    expect(state.persistence).toBe('memory')
    expect(state.storageIssue).toEqual({ kind: 'unavailable', message: STORAGE_MESSAGES.unavailable })
    expect(state.flows.map((f) => f.name)).toEqual(['Do localStorage'])

    const { flowId, imageId } = buildFlow(app)
    const running = app.useFlowStore.getState().generate(flowId, imageId)
    testing.pending[0].resolve([img('so-na-memoria'), img('outra')])
    await running
    expect(images(app, flowId, imageId).map((s) => s.status)).toEqual(['done', 'done'])

    const { buildProjectZip } = await import('../../export/projectZip')
    const s = app.useFlowStore.getState()
    const result = await buildProjectZip({
      meta: s.flows.find((f) => f.id === flowId)!,
      slice: s.flowsData[flowId],
      loadAsset: async () => undefined,
    })
    const zip = await JSZip.loadAsync(result.data)
    const first = await zip.file(result.manifest.images[0].file)!.async('uint8array')
    expect(labelFromBytes(first)).toBe('so-na-memoria')
  })
})
