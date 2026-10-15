import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchRun } from '../../batch/types'
import { emptySheet } from '../../generation/characters'
import { ProviderError, type BatchImageJob, type CostQuote, type ImageGenerationRequest, type ImageProvider } from '../../generation/types'
import { bytesToDataUrl, sha256Hex } from '../../lib/binary'
import { longStory, STORY_FOUR } from '../../story/__tests__/fixtures'
import { pngBytes } from '../../test/fixtures'

type DbModule = typeof import('../../persistence/db')
let currentDb: DbModule | null = null

// Simula abrir o app do zero (como depois de atualizar a página): módulos,
// filas e autorizações de custo recomeçam vazios; o banco continua.
async function openApp() {
  await currentDb?.closeDbForTests()
  vi.resetModules()
  currentDb = await import('../../persistence/db')
  const { repository } = await import('../../persistence/repository')
  const flows = await import('../useFlowStore')
  const chars = await import('../useCharacterStore')
  const story = await import('../useStoryStore')
  const batch = await import('../batchController')
  await flows.useFlowStore.getState().hydrate()
  await chars.useCharacterStore.getState().hydrate()
  await story.useStoryStore.getState().hydrate()
  return { repository, F: flows.useFlowStore, C: chars.useCharacterStore, S: story.useStoryStore, B: batch, flush: story.flushStorySaves }
}
type App = Awaited<ReturnType<typeof openApp>>

// --- provedor falso que registra cada pedido ---
interface Call {
  request: ImageGenerationRequest
  quoteId?: string
  release: (fail?: unknown) => void
}
let seq = 0
function fakeProvider(opts: { kind?: 'mock' | 'backend'; hold?: boolean; fail?: (req: ImageGenerationRequest, n: number) => unknown; paid?: boolean } = {}) {
  const calls: Call[] = []
  const quotes: BatchImageJob[] = []
  let active = 0
  let maxActive = 0
  const provider: ImageProvider = {
    kind: opts.kind ?? 'mock',
    label: 'falso',
    async generateImages(request, options) {
      active += 1
      maxActive = Math.max(maxActive, active)
      const n = calls.length + 1
      try {
        await new Promise<void>((resolve, reject) => {
          const call: Call = { request, quoteId: options?.quoteId, release: (e) => (e ? reject(e) : resolve()) }
          calls.push(call)
          const failure = opts.fail?.(request, n)
          if (failure) reject(failure)
          else if (!opts.hold) resolve()
        })
      } finally {
        active -= 1
      }
      seq += 1
      return [{ src: bytesToDataUrl(pngBytes(1024, 1536, seq % 251), 'image/png'), mimeType: 'image/png' }]
    },
    async enhancePrompt(p) {
      return p
    },
  }
  if (opts.kind === 'backend') {
    provider.quoteBatch = async (job) => {
      quotes.push(job)
      const q: CostQuote = {
        quoteId: `q-${quotes.length}`,
        kind: 'batch',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        mode: opts.paid === false ? 'simulated' : 'openai',
        paid: opts.paid !== false,
        estimatedUsd: job.items.length * 0.06,
        images: job.items.length,
        breakdown: [`${job.items.length} imagem(ns)`],
        notes: [],
      }
      return q
    }
  }
  return { provider, calls, quotes, maxActive: () => maxActive }
}

const CAST = [
  { name: 'Dona Maria', seed: 10, extra: { apparentAge: '62 anos', defaultOutfit: 'avental azul' } },
  { name: 'Seu João', seed: 20, extra: { apparentAge: '66 anos' } },
  { name: 'Ana', seed: 30, extra: { apparentAge: '16 anos' } },
  { name: 'Beto', seed: 40, extra: { apparentAge: '12 anos' } },
]

async function setup(app: App, copy = STORY_FOUR) {
  const shaOf: Record<string, string> = {}
  for (const c of CAST) {
    const photo = pngBytes(400, 600, c.seed)
    shaOf[c.name] = await sha256Hex(photo)
    const r = await app.C.getState().saveCharacter({
      sheet: { ...emptySheet(), name: c.name, ...c.extra },
      photos: [{ kind: 'new', name: `${c.name}.png`, bytes: photo }],
      primaryIndex: 0,
    })
    if (!r.ok) throw new Error(r.error)
  }
  const flowId = app.F.getState().createFlow()
  app.S.getState().saveCopy(flowId, copy)
  const result = await app.S.getState().interpret(flowId)
  if (!result.ok) throw new Error(result.error)
  app.S.getState().approveAll(flowId)
  return { flowId, shaOf }
}

const run = (app: App, flowId: string): BatchRun => app.S.getState().boards[flowId].batch!
const board = (app: App, flowId: string) => app.S.getState().boards[flowId]
const settings = (over: object = {}) => ({
  model: 'gpt-image-1.5' as const,
  size: '1024x1536',
  quality: 'low',
  inputFidelity: 'high' as const,
  continuity: 'off' as const,
  concurrency: 2,
  ...over,
})
async function waitFinished(app: App, flowId: string) {
  await vi.waitFor(() => expect(run(app, flowId).state).toBe('finished'), { timeout: 10_000 })
}
const sceneText = (req: ImageGenerationRequest) => /Original story excerpt[^"]*"([^"]*)"/.exec(req.prompt)?.[1]

beforeEach(async () => {
  localStorage.clear()
  await currentDb?.resetDbForTests()
})
afterEach(() => vi.restoreAllMocks())

describe('geração em lote a partir do storyboard', () => {
  it.each([
    ['15+', STORY_FOUR],
    ['30', longStory(30)],
    ['60', longStory(60)],
  ])('%s cenas: uma imagem por cena, cada uma com o próprio prompt e salva na cena certa', async (_label, copy) => {
    const app = await openApp()
    const fake = fakeProvider()
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app, copy)
    const scenes = board(app, flowId).scenes
    expect(scenes.length).toBeGreaterThanOrEqual(15)

    const res = await app.B.startBatch(flowId, settings({ concurrency: 3 }), 'all')
    expect(res).toMatchObject({ ok: true, images: scenes.length, simulated: true })
    await waitFinished(app, flowId)

    expect(fake.calls).toHaveLength(scenes.length)
    // prompts individuais: nenhum repetido, cada um com o trecho da própria cena
    expect(new Set(fake.calls.map((c) => c.request.prompt)).size).toBe(scenes.length)
    const after = board(app, flowId)
    for (const scene of after.scenes) {
      expect(scene.images).toHaveLength(1)
      const v = scene.images![0]
      expect(scene.officialImageId).toBe(v.id)
      expect(v.prompt).toContain(`"${scene.excerpt}"`)
      expect(v).toMatchObject({ simulated: true, width: 1024, height: 1536, format: { target: '9:16', cropped: false } })
      const asset = await app.repository.getAsset(v.assetId!)
      expect(asset).toMatchObject({ kind: 'scene', projectId: flowId, sha256: v.sha256 })
      expect(asset!.sceneImage!.taskId).toBe(v.taskId)
      expect(await sha256Hex(new Uint8Array(asset!.bytes))).toBe(v.sha256)
    }
    expect(fake.maxActive()).toBeLessThanOrEqual(3)
    expect(after.copy).toBe(copy) // a copy continua intacta
  })

  it('quatro personagens: cada cena leva as fotos das pessoas certas, com fichas e continuidade', async () => {
    const app = await openApp()
    const fake = fakeProvider()
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId, shaOf } = await setup(app)
    await app.B.startBatch(flowId, settings(), 'all')
    await waitFinished(app, flowId)

    const byExcerpt = new Map(fake.calls.map((c) => [sceneText(c.request), c.request]))
    const shas = (excerpt: string) => (byExcerpt.get(excerpt)!.references ?? []).map((r) => r.sha256)
    expect(shas('Dona Maria abraça Seu João no sofá.')).toEqual([shaOf['Dona Maria'], shaOf['Seu João']])
    expect(shas('Mais tarde, no quintal, Ana e Beto brincam com o cachorro.')).toEqual([shaOf.Ana, shaOf.Beto])
    expect(shas('Beto: Pai, a internet caiu de novo!')).toEqual([shaOf.Beto])

    const hug = byExcerpt.get('Dona Maria abraça Seu João no sofá.')!.prompt
    expect(hug).toMatch(/Image 1: "Dona Maria"[\s\S]*62 anos/)
    expect(hug).toMatch(/Image 2: "Seu João"[\s\S]*66 anos/)
    expect(hug).toMatch(/never mix or swap features between different people/)
    // continuidade de figurino e cenário nas instruções
    expect(hug).toMatch(/Dona Maria wears the same outfit as in scene 2 \(avental azul\)/)
    expect(hug).toMatch(/Setting "sala" already appeared in scene \d+: keep the same layout/)
    expect(hug).toMatch(/vertical 9:16/)
    expect(hug).toMatch(/Do not add any text/)
  })

  it('continuidade encadeada: a cena espera a anterior e usa a imagem dela como referência extra', async () => {
    const app = await openApp()
    const fake = fakeProvider({ hold: true })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app, 'Dona Maria entra na cozinha.\nDona Maria abre a geladeira na cozinha.\nSeu João lê no quarto.')
    const res = await app.B.startBatch(flowId, settings({ continuity: 'chain', concurrency: 3 }), 'all')
    expect(res.ok).toBe(true)
    const tasks = run(app, flowId).tasks
    expect(tasks[1].dependsOn).toEqual([tasks[0].id])
    expect(tasks[2].dependsOn).toEqual([])

    // cenas 1 e 3 começam juntas; a 2 espera a 1
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    expect(fake.calls.map((c) => sceneText(c.request))).toEqual(['Dona Maria entra na cozinha.', 'Seu João lê no quarto.'])
    fake.calls[0].release()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(3))
    const second = fake.calls[2].request
    const firstVersion = board(app, flowId).scenes[0].images![0]
    expect(second.references!.map((r) => r.sha256)).toHaveLength(2)
    expect(second.references![1].sha256).toBe(firstVersion.sha256)
    expect(second.deferredReferences).toBe(1)
    expect(second.prompt).toMatch(/Image 2: Cena 1 \(cozinha\) — an earlier scene of this same story, for CONTINUITY ONLY/)
    fake.calls[1].release()
    fake.calls[2].release()
    await waitFinished(app, flowId)
    expect(board(app, flowId).scenes[1].images![0].references.at(-1)).toMatchObject({ kind: 'continuity', sceneId: board(app, flowId).scenes[0].id })
  })

  it('falha temporária é repetida sozinha; falha definitiva fica marcada e só ela é gerada de novo', async () => {
    const app = await openApp()
    let failedOnce = false
    const fake = fakeProvider({
      fail: (req) => {
        const text = sceneText(req)
        if (text === 'Beto: Pai, a internet caiu de novo!' && !failedOnce) {
          failedOnce = true
          return new ProviderError('Limite de requisições.', { status: 429, code: 'rate_limited', retryAfterMs: 5 })
        }
        if (text === 'Ana: Mãe, cadê minha mochila?') return new ProviderError('Pedido recusado pela OpenAI.', { status: 422, code: 'upstream_rejected' })
        return undefined
      },
    })
    app.B.setBatchHooksForTests({ provider: fake.provider, queue: { baseDelayMs: 5 } })
    const { flowId } = await setup(app)
    await app.B.startBatch(flowId, settings(), 'all')
    await waitFinished(app, flowId)

    const r = run(app, flowId)
    const scenes = board(app, flowId).scenes
    const taskOf = (excerpt: string) => r.tasks.find((t) => t.sceneId === scenes.find((s) => s.excerpt === excerpt)!.id)!
    expect(taskOf('Beto: Pai, a internet caiu de novo!')).toMatchObject({ status: 'done', attempts: 2 })
    expect(taskOf('Ana: Mãe, cadê minha mochila?')).toMatchObject({ status: 'failed', errorKind: 'permanent', attempts: 1 })
    expect(r.tasks.filter((t) => t.status === 'done')).toHaveLength(scenes.length - 1)

    const callsBefore = fake.calls.length
    const retry = await app.B.retryFailed(flowId)
    expect(retry).toMatchObject({ ok: true, images: 1 })
    await waitFinished(app, flowId)
    // só a cena com falha foi pedida de novo (e falhou de novo, pelo mesmo motivo)
    expect(fake.calls.slice(callsBefore).map((c) => sceneText(c.request))).toEqual(['Ana: Mãe, cadê minha mochila?'])
  })

  it('pausar e retomar: nada novo começa pausado; retomar continua sem repetir as concluídas', async () => {
    const app = await openApp()
    const fake = fakeProvider({ hold: true })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    await app.B.startBatch(flowId, settings({ concurrency: 2 }), 'all')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    app.B.pauseBatch(flowId)
    expect(run(app, flowId).state).toBe('paused')
    fake.calls[0].release()
    fake.calls[1].release()
    await vi.waitFor(() => expect(run(app, flowId).tasks.filter((t) => t.status === 'done')).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.calls).toHaveLength(2)

    const resumed = await app.B.resumeBatch(flowId)
    expect(resumed.ok).toBe(true)
    await vi.waitFor(() => expect(fake.calls).toHaveLength(4))
    for (const c of fake.calls.slice(2)) c.release()
    // solta o resto conforme chega
    const total = board(app, flowId).scenes.length
    await vi.waitFor(
      () => {
        for (const c of fake.calls) c.release()
        expect(run(app, flowId).state).toBe('finished')
      },
      { timeout: 10_000 },
    )
    expect(fake.calls).toHaveLength(total)
    expect(new Set(fake.calls.map((c) => c.request.prompt)).size).toBe(total)
  })

  it('cancelar pendentes: as que já estavam gerando terminam; as outras não são chamadas', async () => {
    const app = await openApp()
    const fake = fakeProvider({ hold: true })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    await app.B.startBatch(flowId, settings({ concurrency: 2 }), 'all')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    app.B.cancelPending(flowId)
    fake.calls[0].release()
    fake.calls[1].release()
    await waitFinished(app, flowId)
    const r = run(app, flowId)
    expect(r.tasks.filter((t) => t.status === 'done')).toHaveLength(2)
    expect(r.tasks.filter((t) => t.status === 'cancelled')).toHaveLength(r.tasks.length - 2)
    expect(fake.calls).toHaveLength(2)
  })

  it('fechar no meio e reabrir: concluídas ficam, nada recomeça sozinho, pendentes retomam sem repetir', async () => {
    let app = await openApp()
    const fake = fakeProvider({ hold: true })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    const total = board(app, flowId).scenes.length
    await app.B.startBatch(flowId, settings({ concurrency: 2 }), 'all')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    fake.calls[0].release()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(3))
    await app.flush()
    const doneScene = run(app, flowId).tasks.find((t) => t.status === 'done')!.sceneId
    const doneVersion = board(app, flowId).scenes.find((s) => s.id === doneScene)!.images![0]

    // "fecha" o app com 2 imagens ainda gerando
    app = await openApp()
    const fake2 = fakeProvider()
    app.B.setBatchHooksForTests({ provider: fake2.provider })
    const r = run(app, flowId)
    expect(r.state).toBe('paused')
    expect(r.pausedReason).toMatch(/Nada foi retomado automaticamente/)
    expect(r.tasks.filter((t) => t.status === 'done')).toHaveLength(1)
    expect(r.tasks.filter((t) => t.status === 'failed' && t.errorKind === 'interrupted')).toHaveLength(2)
    expect(r.tasks.filter((t) => t.status === 'pending')).toHaveLength(total - 3)
    // a imagem concluída voltou (bytes no banco)
    const restored = board(app, flowId).scenes.find((s) => s.id === doneScene)!
    expect(restored.images![0]).toEqual(doneVersion)
    expect(await app.repository.getAsset(doneVersion.assetId!)).toBeTruthy()
    await new Promise((res) => setTimeout(res, 30))
    expect(fake2.calls).toHaveLength(0) // nada começou sozinho

    await app.B.resumeBatch(flowId)
    await waitFinished(app, flowId)
    expect(fake2.calls).toHaveLength(total - 3)
    await app.B.retryFailed(flowId)
    await waitFinished(app, flowId)
    expect(fake2.calls).toHaveLength(total - 1)
    // nenhuma cena gerada duas vezes, a concluída antes de fechar não foi repetida
    expect(fake2.calls.map((c) => sceneText(c.request))).not.toContain(restored.excerpt)
    expect(board(app, flowId).scenes.every((s) => s.images?.length === 1)).toBe(true)
  })

  it('imagem salva mas storyboard não atualizado (fechou no instante errado): é recuperada ao reabrir', async () => {
    let app = await openApp()
    const fake = fakeProvider({ hold: true })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app, 'Dona Maria entra na cozinha.\nSeu João lê no quarto.')
    await app.B.startBatch(flowId, settings({ concurrency: 1 }), 'all')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await app.flush()
    const task = run(app, flowId).tasks[0]
    // grava o arquivo como o executor faria, mas "fecha" antes de atualizar o storyboard
    const bytes = pngBytes(1024, 1536, 200)
    await app.repository.putAsset({
      id: task.pendingAssetId!,
      projectId: flowId,
      kind: 'scene',
      mimeType: 'image/png',
      bytes: bytes.buffer as ArrayBuffer,
      byteLength: bytes.byteLength,
      createdAt: Date.now(),
      sceneImage: {
        id: 'versao-recuperada', taskId: task.id, runId: run(app, flowId).id, assetId: task.pendingAssetId, mimeType: 'image/png',
        width: 1024, height: 1536, byteLength: bytes.byteLength, sha256: await sha256Hex(bytes), createdAt: Date.now(),
        model: 'gpt-image-1.5', size: '1024x1536', quality: 'low', provider: 'mock', simulated: true, prompt: task.prompt,
        references: [], characters: [], sceneFingerprint: task.sceneFingerprint,
        format: { nativeWidth: 1024, nativeHeight: 1536, target: '9:16', cropped: false, note: '' },
      },
    })
    app = await openApp()
    const r = run(app, flowId)
    expect(r.tasks[0]).toMatchObject({ status: 'done', versionId: 'versao-recuperada' })
    expect(board(app, flowId).scenes[0].officialImageId).toBe('versao-recuperada')
    expect(board(app, flowId).history.at(-1)!.action).toMatch(/1 imagem\(ns\) recuperada/)
  })

  it('regenerar uma cena: guarda a versão anterior, não troca a aprovada sem decisão, não mexe nas outras', async () => {
    const app = await openApp()
    const fake = fakeProvider()
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    await app.B.startBatch(flowId, settings(), 'all')
    await waitFinished(app, flowId)
    const [s1, s2] = board(app, flowId).scenes
    app.B.approveSceneImage(flowId, s1.id)
    const others = board(app, flowId).scenes.slice(1).map((s) => s.images)

    const res = await app.B.regenerateScene(flowId, s1.id)
    expect(res).toMatchObject({ ok: true, images: 1 })
    await waitFinished(app, flowId)
    let scene = board(app, flowId).scenes[0]
    expect(scene.images).toHaveLength(2)
    expect(scene.officialImageId).toBe(s1.officialImageId) // a aprovada continua oficial
    expect(scene.imageApprovedAt).toBeTruthy()
    expect(board(app, flowId).scenes.slice(1).map((s) => s.images)).toEqual(others)
    // mesma cena, mesmas referências, mesmo prompt
    expect(fake.calls.at(-1)!.request.prompt).toBe(scene.images![0].prompt)

    // a pessoa escolhe a nova como oficial: precisa aprovar de novo
    app.B.setOfficialImage(flowId, s1.id, scene.images![1].id)
    scene = board(app, flowId).scenes[0]
    expect(scene).toMatchObject({ officialImageId: scene.images![1].id, imageApprovedAt: null })

    // cena sem aprovação: a nova versão vira a oficial, a anterior fica guardada
    await app.B.regenerateScene(flowId, s2.id)
    await waitFinished(app, flowId)
    const second = board(app, flowId).scenes[1]
    expect(second.images).toHaveLength(2)
    expect(second.officialImageId).toBe(second.images![1].id)

    // "gerar todas" de novo não troca nenhuma imagem aprovada
    app.B.approveSceneImage(flowId, s1.id)
    await app.B.startBatch(flowId, settings(), 'all')
    await waitFinished(app, flowId)
    expect(board(app, flowId).scenes[0].officialImageId).toBe(scene.images![1].id)
    // "apenas pendentes": nenhuma cena sem imagem → nada a gerar
    expect(await app.B.startBatch(flowId, settings(), 'pending')).toMatchObject({ ok: false })
  })

  it('cena não aprovada, personagem ambíguo ou foto ausente: fica fora do lote e o motivo aparece', async () => {
    const app = await openApp()
    const fake = fakeProvider()
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    const scenes = board(app, flowId).scenes
    app.S.getState().updateScene(flowId, scenes[0].id, { action: 'editada depois da aprovação' })
    const plan = app.B.previewBatch(flowId, settings(), 'all')
    expect(plan.scenes[0]).toMatchObject({ included: false, reason: 'cena ainda não aprovada no storyboard' })
    expect(plan.summary).toMatchObject({ images: scenes.length - 1, notApproved: 1, storyboardApproved: false })

    // personagem da cena desassociado e marcado como ambíguo → bloqueia
    const ana = board(app, flowId).characters.find((c) => c.name === 'Ana')!
    app.S.getState().mutate(flowId, (b) => ({
      ...b,
      characters: b.characters.map((c) => (c.key === ana.key ? { ...c, libraryId: null, matchStatus: 'ambiguous' as const, candidates: [] } : c)),
    }))
    const plan2 = app.B.previewBatch(flowId, settings(), 'all')
    const anaScene = plan2.scenes.find((r) => board(app, flowId).scenes[r.number - 1].characterKeys.includes(ana.key))!
    expect(anaScene.included).toBe(false)
    expect(anaScene.blocking.join(' ')).toMatch(/Ana: associação com a biblioteca ambígua/)
    expect(plan2.summary.ambiguous).toEqual(['Ana'])

    // modelo sem fotos de referência: o lote inteiro é recusado
    const plan3 = app.B.previewBatch(flowId, settings({ model: 'dall-e-3', size: '1024x1792', quality: 'standard' }), 'all')
    expect(plan3.errors[0]).toMatch(/não aceita fotos de referência/)
    expect(plan3.tasks).toEqual([])
  })

  it('provedor pago: orçamento do lote e confirmação ANTES de qualquer chamada; cancelar não chama nada', async () => {
    const app = await openApp()
    const fake = fakeProvider({ kind: 'backend' })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId, shaOf } = await setup(app)
    const n = board(app, flowId).scenes.length

    const pending = app.B.startBatch(flowId, settings({ continuity: 'chain' }), 'all')
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    const dialog = app.F.getState().costConfirmation!
    expect(dialog.title).toBe(`Gerar ${n} imagem(ns) do storyboard`)
    expect(dialog.quote).toMatchObject({ kind: 'batch', images: n, paid: true })
    // o orçamento leva o prompt e as fotos (hash) de cada cena
    const job = fake.quotes[0]
    expect(job.items).toHaveLength(n)
    expect(job.items.some((i) => i.references?.some((r) => r.sha256 === shaOf.Ana))).toBe(true)
    expect(job.items.filter((i) => i.deferredReferences === 1).length).toBeGreaterThan(0)
    app.F.getState().resolveCostConfirmation(false)
    expect(await pending).toMatchObject({ ok: false, cancelled: true })
    expect(fake.calls).toHaveLength(0)
    expect(board(app, flowId).batch).toBeUndefined()

    const second = app.B.startBatch(flowId, settings(), 'all')
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    app.F.getState().resolveCostConfirmation(true)
    expect(await second).toMatchObject({ ok: true, simulated: false })
    await waitFinished(app, flowId)
    expect(fake.calls).toHaveLength(n)
    expect(new Set(fake.calls.map((c) => c.quoteId))).toEqual(new Set(['q-2']))
    expect(run(app, flowId)).toMatchObject({ simulated: false, estimatedUsd: n * 0.06 })
  })

  it('provedor pago, app reaberto: retomar exige NOVO orçamento e confirmação; sem isso, nenhuma chamada', async () => {
    let app = await openApp()
    const fake = fakeProvider({ kind: 'backend', hold: true })
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    const n = board(app, flowId).scenes.length
    const started = app.B.startBatch(flowId, settings({ concurrency: 1 }), 'all')
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    app.F.getState().resolveCostConfirmation(true)
    await started
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    fake.calls[0].release()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    await app.flush()

    app = await openApp()
    const fake2 = fakeProvider({ kind: 'backend' })
    app.B.setBatchHooksForTests({ provider: fake2.provider })
    const r = run(app, flowId)
    const interrupted = r.tasks.find((t) => t.errorKind === 'interrupted')!
    expect(interrupted.error).toMatch(/pode ter sido processada e cobrada/)

    const resume = app.B.resumeBatch(flowId)
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    expect(fake2.quotes[0].items).toHaveLength(n - 2) // só as pendentes
    app.F.getState().resolveCostConfirmation(false)
    expect(await resume).toMatchObject({ ok: false, cancelled: true })
    await new Promise((res) => setTimeout(res, 30))
    expect(fake2.calls).toHaveLength(0)

    const resume2 = app.B.resumeBatch(flowId)
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    app.F.getState().resolveCostConfirmation(true)
    await resume2
    await waitFinished(app, flowId)
    expect(fake2.calls).toHaveLength(n - 2)
    // a interrompida não foi repetida automaticamente (risco de cobrança dupla)
    expect(run(app, flowId).tasks.find((t) => t.id === interrupted.id)!.status).toBe('failed')
  })

  it('exportação ZIP: imagens oficiais em ordem (cena_001…), prompts, copy, roteiro e manifesto íntegros', async () => {
    const app = await openApp()
    const fake = fakeProvider()
    app.B.setBatchHooksForTests({ provider: fake.provider })
    const { flowId } = await setup(app)
    await app.B.startBatch(flowId, settings(), 'all')
    await waitFinished(app, flowId)
    const b = board(app, flowId)
    app.B.approveSceneImage(flowId, b.scenes[0].id)
    // cena 2 ganha uma segunda versão, mas a oficial continua a primeira
    app.B.approveSceneImage(flowId, b.scenes[1].id)
    await app.B.regenerateScene(flowId, b.scenes[1].id)
    await waitFinished(app, flowId)

    const JSZip = (await import('jszip')).default
    const { buildProjectZip } = await import('../../export/projectZip')
    const state = app.F.getState()
    const final = board(app, flowId)
    const { data, manifest } = await buildProjectZip({
      meta: state.flows.find((f) => f.id === flowId)!,
      slice: state.flowsData[flowId],
      loadAsset: (id) => app.repository.getAsset(id),
      characters: app.C.getState().characters,
      storyboard: final,
    })
    const zip = await JSZip.loadAsync(data)
    const sb = manifest.storyboard!
    expect(sb.sceneCount).toBe(final.scenes.length)
    expect(sb.imagesExported).toBe(final.scenes.length)
    expect(sb.simulatedImages).toBe(final.scenes.length)
    expect(sb.scenes.map((s) => s.image!.file)).toEqual(final.scenes.map((_, i) => `storyboard/cenas/cena_${String(i + 1).padStart(3, '0')}.png`))
    for (const [i, scene] of final.scenes.entries()) {
      const entry = sb.scenes[i]
      const official = scene.images!.find((v) => v.id === scene.officialImageId)!
      expect(entry).toMatchObject({ number: i + 1, sceneId: scene.id, excerpt: scene.excerpt, motion: scene.motion })
      expect(entry.image!.versionId).toBe(official.id)
      const bytes = await zip.file(entry.image!.file)!.async('uint8array')
      expect(await sha256Hex(bytes)).toBe(entry.image!.sha256)
      expect(entry.image!.sha256).toBe(official.sha256)
      expect(await zip.file(entry.image!.promptFile)!.async('string')).toBe(official.prompt)
    }
    expect(sb.scenes[1]).toMatchObject({ versionsAvailable: 2, image: { approved: true } })
    expect(sb.scenes[0].image!.references[0]).toMatchObject({ kind: 'character', label: 'Dona Maria' })
    expect(await zip.file('storyboard/copy_original.txt')!.async('string')).toBe(final.copy)
    expect(sb.copySha256).toBe(await sha256Hex(new TextEncoder().encode(STORY_FOUR)))
    const guide = await zip.file('storyboard/roteiro_google_flow.md')!.async('string')
    expect(guide).toMatch(/ainda NÃO anima as imagens/)
    expect(guide).toMatch(/## Cena 001 — Dona Maria acorda cedo/)
    expect(guide).toMatch(/Movimento \(Google Flow\):/)
    expect(guide).toMatch(/IMAGEM SIMULADA/)
    const json = JSON.parse(await zip.file('storyboard/storyboard.json')!.async('string'))
    expect(json.scenes).toHaveLength(final.scenes.length)
    expect(json.snapshots).toBeUndefined()
    expect(await zip.file('storyboard/LEIA-ME.txt')!.async('string')).toMatch(/SIMULADAS/)
    // personagens e fotos de referência incluídos, com as cenas em que aparecem
    const maria = manifest.characters.find((c) => c.name === 'Dona Maria')!
    expect(maria.usedInScenes.length).toBeGreaterThan(3)
    expect(maria.files).toHaveLength(1)
    expect(zip.file(maria.files[0].file)).toBeTruthy()
  })
})
