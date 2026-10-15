import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySheet } from '../../generation/characters'
import type { CostQuote } from '../../generation/types'
import { createBackendInterpreter, type StoryInterpreter } from '../../story/interpreters'
import { simulateInterpretation } from '../../story/simulatedInterpreter'
import { hashText } from '../../story/text'
import { STORY_FOUR } from '../../story/__tests__/fixtures'
import { pngBytes } from '../../test/fixtures'

type DbModule = typeof import('../../persistence/db')
let currentDb: DbModule | null = null

// Simula abrir o app do zero (como depois de atualizar a página)
async function openApp() {
  await currentDb?.closeDbForTests()
  vi.resetModules()
  currentDb = await import('../../persistence/db')
  const { repository } = await import('../../persistence/repository')
  const flows = await import('../useFlowStore')
  const chars = await import('../useCharacterStore')
  const story = await import('../useStoryStore')
  await flows.useFlowStore.getState().hydrate()
  await chars.useCharacterStore.getState().hydrate()
  await story.useStoryStore.getState().hydrate()
  return {
    repository,
    F: flows.useFlowStore,
    C: chars.useCharacterStore,
    S: story.useStoryStore,
    flush: async () => {
      await flows.flushDirtyFlows()
      await story.flushStorySaves()
    },
    setInterpreter: story.setStoryInterpreterForTests,
  }
}

function quote(): CostQuote {
  return {
    quoteId: 'q-story-1',
    kind: 'story',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mode: 'openai',
    paid: true,
    estimatedUsd: 0.05,
    images: 0,
    breakdown: ['1 chamada'],
    notes: [],
  }
}

beforeEach(async () => {
  localStorage.clear()
  await currentDb?.resetDbForTests()
})
afterEach(() => vi.restoreAllMocks())

describe('storyboard: persistência e segurança das alterações', () => {
  it('copy, cenas, personagens, aprovações, prompts e histórico voltam depois de reabrir', async () => {
    let app = await openApp()
    const maria = await app.C.getState().saveCharacter({
      sheet: { ...emptySheet(), name: 'Maria', apparentAge: '62 anos' },
      photos: [{ kind: 'new', name: 'maria.png', bytes: pngBytes(400, 600, 7) }],
      primaryIndex: 0,
    })
    if (!maria.ok) throw new Error(maria.error)
    const flowId = app.F.getState().createFlow()
    const S = () => app.S.getState()

    S().saveCopy(flowId, STORY_FOUR)
    const result = await S().interpret(flowId)
    expect(result).toMatchObject({ ok: true, mode: 'simulated' })
    const board = S().boards[flowId]
    expect(board.scenes.length).toBeGreaterThanOrEqual(16)

    const ana = board.characters.find((c) => c.name === 'Ana')!
    S().addLibraryCharacter(flowId, maria.id) // já associada pelo nome: não duplica
    S().updateScene(flowId, board.scenes[0].id, { action: 'Dona Maria prepara o café com calma' })
    S().setSceneStatus(flowId, board.scenes[0].id, 'approved')
    S().resolveCharacter(flowId, ana.key, null)
    const before = S().boards[flowId]
    // prompt calculado e salvo junto: ficha da Maria (biblioteca) incluída
    expect(before.scenes[0].prompt).toContain('62 anos')
    expect(before.scenes[0].prompt).toContain('Dona Maria prepara o café com calma')
    await app.flush()

    app = await openApp()
    const after = app.S.getState().boards[flowId]
    expect(after).toEqual(before)
    expect(after.copy).toBe(STORY_FOUR)
    expect(hashText(after.copy)).toBe(hashText(STORY_FOUR))
    expect(after.scenes[0]).toMatchObject({ status: 'approved', action: 'Dona Maria prepara o café com calma' })
    expect(after.characters.find((c) => c.name === 'Dona Maria')).toMatchObject({ libraryId: maria.id, matchStatus: 'auto' })
    expect(after.history.length).toBeGreaterThan(3)
  })

  it('falha na interpretação não apaga nem altera o storyboard aprovado', async () => {
    const app = await openApp()
    const flowId = app.F.getState().createFlow()
    const S = () => app.S.getState()
    S().saveCopy(flowId, STORY_FOUR)
    await S().interpret(flowId)
    S().approveAll(flowId)
    await app.flush()
    const approved = S().boards[flowId]

    // 1) erro de rede/servidor
    app.setInterpreter({ label: 'falha', interpret: async () => Promise.reject(new Error('Servidor fora do ar.')) })
    const r1 = await S().interpret(flowId)
    expect(r1).toEqual({ ok: false, error: 'Servidor fora do ar. O storyboard anterior foi mantido.' })
    expect(S().boards[flowId]).toBe(approved)

    // 2) resposta que inventa trechos (nada bate com a copy)
    app.setInterpreter({
      label: 'inventa',
      interpret: async () => ({
        raw: { characters: [], scenes: [{ ...simulateInterpretation('Texto inventado.').scenes[0] }] },
        mode: 'openai',
        model: 'teste',
        warnings: [],
      }),
    })
    const r2 = await S().interpret(flowId)
    expect(r2.ok).toBe(false)
    expect(!r2.ok && r2.error).toMatch(/recusada na validação: Nenhuma cena válida/)
    expect(S().boards[flowId]).toBe(approved)

    // 3) a pessoa mudou a copy enquanto esperava
    app.setInterpreter({
      label: 'lento',
      interpret: async (copy) => {
        S().saveCopy(flowId, `${STORY_FOUR}\nNova linha.`)
        return { raw: simulateInterpretation(copy), mode: 'simulated', model: 'x', warnings: [] }
      },
    })
    const r3 = await S().interpret(flowId)
    expect(!r3.ok && r3.error).toMatch(/A copy mudou durante a interpretação/)
    expect(S().boards[flowId].scenes).toEqual(approved.scenes)

    // e depois de reabrir, o aprovado continua lá
    await app.flush()
    const reopened = await openApp()
    expect(reopened.S.getState().boards[flowId].scenes.every((s) => s.status === 'approved')).toBe(true)
  })

  it('interpretação paga: pede orçamento e só chama depois da confirmação explícita', async () => {
    const app = await openApp()
    const flowId = app.F.getState().createFlow()
    const S = () => app.S.getState()
    S().saveCopy(flowId, STORY_FOUR)
    const calls: Array<{ quoteId?: string }> = []
    const paid: StoryInterpreter = {
      label: 'pago',
      quote: async () => quote(),
      interpret: async (copy, _names, opts) => {
        calls.push({ quoteId: opts?.quoteId })
        return { raw: simulateInterpretation(copy), mode: 'openai', model: 'gpt-5-mini', warnings: [] }
      },
    }
    app.setInterpreter(paid)

    // cancelou → nenhuma chamada, nada muda
    const pending = S().interpret(flowId)
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    expect(app.F.getState().costConfirmation!.title).toBe('Interpretar historinha')
    app.F.getState().resolveCostConfirmation(false)
    expect(await pending).toMatchObject({ ok: false, cancelled: true })
    expect(calls).toEqual([])
    expect(S().boards[flowId].scenes).toEqual([])

    // confirmou → uma chamada com o orçamento confirmado
    const second = S().interpret(flowId)
    await vi.waitFor(() => expect(app.F.getState().costConfirmation).not.toBeNull())
    app.F.getState().resolveCostConfirmation(true)
    expect(await second).toMatchObject({ ok: true, mode: 'openai' })
    expect(calls).toEqual([{ quoteId: 'q-story-1' }])
    expect(S().boards[flowId].interpretation).toMatchObject({ mode: 'openai', model: 'gpt-5-mini' })
  })

  it('erro ao gravar não descarta o storyboard da tela e mostra aviso', async () => {
    const app = await openApp()
    const flowId = app.F.getState().createFlow()
    vi.spyOn(app.repository, 'saveStoryboard').mockRejectedValue(new DOMException('cheio', 'QuotaExceededError'))
    app.S.getState().saveCopy(flowId, STORY_FOUR)
    await app.flush()
    expect(app.S.getState().boards[flowId].copy).toBe(STORY_FOUR)
    expect(app.S.getState().issue).toMatch(/Não foi possível salvar o storyboard/)
  })

  it('apagar o projeto apaga o storyboard dele do banco', async () => {
    const app = await openApp()
    const keep = app.F.getState().createFlow()
    const gone = app.F.getState().createFlow()
    app.S.getState().saveCopy(keep, 'Dona Maria sorri.')
    app.S.getState().saveCopy(gone, 'Seu João acena.')
    await app.flush()
    app.F.getState().deleteFlow(gone)
    await app.flush()
    await vi.waitFor(async () => expect((await app.repository.listStoryboards()).map((r) => r.id)).toEqual([keep]))
  })
})

describe('interpretador pelo backend (contrato HTTP)', () => {
  it('pede orçamento e envia a interpretação com o cabeçalho X-Cost-Quote; nunca envia chave', async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      const body = url.endsWith('/quote')
        ? quote()
        : { interpretation: simulateInterpretation(STORY_FOUR), mode: 'simulated', model: 'interpretador-simulado-v1', warnings: ['aviso'] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const interpreter = createBackendInterpreter({ fetchImpl })
    const q = await interpreter.quote!(STORY_FOUR, ['Maria'])
    const out = await interpreter.interpret(STORY_FOUR, ['Maria'], { quoteId: q.quoteId })
    expect(requests.map((r) => r.url)).toEqual(['/api/story/quote', '/api/story/interpret'])
    expect(requests[0].body).toEqual({ copy: STORY_FOUR, libraryNames: ['Maria'] })
    expect(requests[1].headers['X-Cost-Quote']).toBe('q-story-1')
    expect(JSON.stringify(requests)).not.toMatch(/sk-|authorization/i)
    expect(out).toMatchObject({ mode: 'simulated', warnings: ['aviso'] })
  })

  it('erro do servidor vira mensagem clara', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'upstream_invalid', message: 'Interpretação inválida na parte 1 de 2.' } }), {
        status: 502,
      })) as unknown as typeof fetch
    await expect(createBackendInterpreter({ fetchImpl }).interpret('x', [])).rejects.toThrow('Interpretação inválida na parte 1 de 2.')
  })
})
