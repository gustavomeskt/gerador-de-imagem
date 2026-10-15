// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { STORY_JSON_SCHEMA, STORY_MODEL_DEFAULT } from '../../src/story/llmRequest'
import { simulateInterpretation } from '../../src/story/simulatedInterpreter'
import { fakeOpenAI, FAKE_KEY, jsonResponse, startServer, type FakeCall, type TestServer } from './helpers'

const COPY = 'Dona Maria entra na farmácia.\nDona Maria: Bom dia!\nO farmacêutico sorri.'

let t: TestServer | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

// resposta no formato do chat completions com saída estruturada
function chatResponse(content: unknown, finish = 'stop') {
  return jsonResponse(200, {
    choices: [{ finish_reason: finish, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  })
}

// "modelo" falso: interpreta a parte recebida com as regras locais
function modelEcho(call: FakeCall) {
  const messages = call.body.messages as Array<{ role: string; content: string }>
  const chunk = messages[1].content.split('COPY (não altere):\n\n')[1]
  return chatResponse(simulateInterpretation(chunk))
}

async function openaiServer(handler: (call: FakeCall) => Response, env: Record<string, string> = {}, logs: string[] = []) {
  const openai = fakeOpenAI(handler)
  t = await startServer(
    { IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, ...env },
    { fetchImpl: openai.fetchImpl, log: (line) => logs.push(line) },
  )
  return { t, openai }
}

async function quoteAndInterpret(server: TestServer, body: unknown = { copy: COPY, libraryNames: ['Maria'] }) {
  const quote = await server.request('POST', '/api/story/quote', { body })
  const res = await server.request('POST', '/api/story/interpret', { body, headers: { 'X-Cost-Quote': quote.json?.quoteId ?? '' } })
  return { quote, res }
}

describe('interpretação de historinha no backend', () => {
  it('modo simulado (padrão): sem IA, sem custo e identificado como simulado', async () => {
    t = await startServer()
    const { quote, res } = await quoteAndInterpret(t)
    expect(quote.json).toMatchObject({ kind: 'story', mode: 'simulated', paid: false, story: { model: 'interpretador-simulado-v1', chunks: 1 } })
    expect(res.status).toBe(200)
    expect(res.json.mode).toBe('simulated')
    expect(res.json.model).toBe('interpretador-simulado-v1')
    expect(res.json.warnings[0]).toMatch(/modo simulado: interpretação por regras, sem IA/)
    expect(res.json.interpretation.scenes).toHaveLength(3)
  })

  it('sem orçamento confirmado não chama o modelo (428); orçamento não serve para outra copy', async () => {
    const { t, openai } = await openaiServer(modelEcho)
    const none = await t.request('POST', '/api/story/interpret', { body: { copy: COPY, libraryNames: [] } })
    expect(none.status).toBe(428)
    const quote = await t.request('POST', '/api/story/quote', { body: { copy: COPY, libraryNames: [] } })
    expect(quote.json).toMatchObject({ kind: 'story', paid: true, mode: 'openai', story: { model: STORY_MODEL_DEFAULT } })
    expect(quote.json.estimatedUsd).toBeGreaterThan(0)
    const other = await t.request('POST', '/api/story/interpret', {
      body: { copy: `${COPY} Mais uma frase.`, libraryNames: [] },
      headers: { 'X-Cost-Quote': quote.json.quoteId },
    })
    expect(other.status).toBe(409)
    expect(other.json.error.code).toBe('quote_mismatch')
    expect(openai.calls).toHaveLength(0)
  })

  it('chama o modelo com saída estruturada (json_schema estrito) e as regras de fidelidade', async () => {
    const { t, openai } = await openaiServer(modelEcho)
    const { res } = await quoteAndInterpret(t)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ mode: 'openai', model: STORY_MODEL_DEFAULT, warnings: [] })
    expect(openai.calls).toHaveLength(1)
    const call = openai.calls[0]
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(call.body.model).toBe(STORY_MODEL_DEFAULT)
    expect(call.body.response_format).toEqual({ type: 'json_schema', json_schema: STORY_JSON_SCHEMA })
    const [system, user] = call.body.messages as Array<{ content: string }>
    expect(system.content).toMatch(/Nunca invente acontecimentos/)
    expect(user.content).toContain(COPY)
    expect(user.content).toMatch(/não associe por semelhança\): Maria/)
  })

  it('copy grande é dividida em partes (uma chamada por parte) e o resultado é juntado em ordem', async () => {
    const { t, openai } = await openaiServer(modelEcho, { STORY_CHUNK_CHARS: '600', MAX_COST_PER_JOB_USD: '50' })
    const big = { copy: Array.from({ length: 40 }, (_, i) => `Dona Maria faz a tarefa número ${i + 1} na cozinha.`).join('\n\n'), libraryNames: [] }
    const { quote, res } = await quoteAndInterpret(t, big)
    expect(quote.json.story.chunks).toBe(4)
    expect(res.status).toBe(200)
    expect(openai.calls).toHaveLength(4)
    expect((openai.calls[1].body.messages as Array<{ content: string }>)[1].content).toMatch(/parte 2 de 4/)
    const quotes = res.json.interpretation.scenes.map((s: { quote: string }) => s.quote)
    expect(quotes).toHaveLength(40)
    expect(quotes[0]).toBe('Dona Maria faz a tarefa número 1 na cozinha.')
    expect(quotes[39]).toBe('Dona Maria faz a tarefa número 40 na cozinha.')
    expect(res.json.interpretation.characters).toEqual([{ name: 'Dona Maria', mentions: ['Dona Maria', 'Maria'] }])
  })

  it('cenas com trecho inventado são descartadas com aviso; saída inválida vira erro 502 sem custo extra', async () => {
    const invented = {
      characters: [{ name: 'Dona Maria', mentions: [] }],
      scenes: [
        { ...simulateInterpretation(COPY).scenes[0] },
        { ...simulateInterpretation(COPY).scenes[0], quote: 'Dona Maria compra um remédio caro.' },
      ],
    }
    const { t } = await openaiServer(() => chatResponse(invented))
    const { res } = await quoteAndInterpret(t)
    expect(res.status).toBe(200)
    expect(res.json.interpretation.scenes).toHaveLength(1)
    expect(res.json.warnings[0]).toMatch(/1 cena\(s\) descartada\(s\) porque o trecho citado não existe na copy/)

    await t.close()
    const bad = await openaiServer(() => chatResponse('isto não é json'))
    const r2 = (await quoteAndInterpret(bad.t)).res
    expect(r2.status).toBe(502)
    expect(r2.json.error.code).toBe('upstream_invalid')

    await bad.t.close()
    const nothing = await openaiServer(() => chatResponse({ characters: [], scenes: [{ ...invented.scenes[1] }] }))
    const r3 = (await quoteAndInterpret(nothing.t)).res
    expect(r3.status).toBe(502)
    expect(r3.json.error.message).toMatch(/nenhuma cena com trecho literal/)

    await nothing.t.close()
    const cut = await openaiServer(() => chatResponse('{"characters":[', 'length'))
    const r4 = (await quoteAndInterpret(cut.t)).res
    expect(r4.status).toBe(502)
    expect(r4.json.error.code).toBe('upstream_truncated')
  })

  it('valida o pedido: campos desconhecidos, copy vazia ou grande demais', async () => {
    t = await startServer({ MAX_STORY_CHARS: '200' })
    const cases: Array<[unknown, RegExp]> = [
      [{ copy: '   ' }, /não pode ficar vazia/],
      [{ copy: 'x'.repeat(201) }, /limite de 200 caracteres/],
      [{ copy: 'ok', url: 'http://exemplo.com/copy.txt' }, /Campo não permitido: "url"/],
      [{ copy: 'ok', libraryNames: [42] }, /libraryNames/],
      [{ copy: 123 }, /precisa ser um texto/],
    ]
    for (const [body, message] of cases) {
      const res = await t.request('POST', '/api/story/quote', { body })
      expect(res.status).toBe(400)
      expect(res.json.error.message).toMatch(message)
    }
  })

  it('custo acima do limite por pedido é recusado no orçamento', async () => {
    const { t, openai } = await openaiServer(modelEcho, { MAX_COST_PER_JOB_USD: '0.001' })
    const quote = await t.request('POST', '/api/story/quote', { body: { copy: COPY } })
    expect(quote.status).toBe(422)
    expect(quote.json.error.code).toBe('job_too_expensive')
    expect(openai.calls).toHaveLength(0)
  })

  it('a copy e a chave nunca vão para o log', async () => {
    const logs: string[] = []
    const { t } = await openaiServer(modelEcho, {}, logs)
    await quoteAndInterpret(t)
    expect(logs.length).toBeGreaterThan(0)
    const all = logs.join('\n')
    expect(all).not.toContain('farmácia')
    expect(all).not.toContain('Maria')
    expect(all).not.toContain(FAKE_KEY)
  })
})
