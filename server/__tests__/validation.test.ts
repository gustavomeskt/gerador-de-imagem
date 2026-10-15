// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeOpenAI, FAKE_KEY, imagesResponse, startServer, VALID_JOB, type TestServer } from './helpers'

let t: TestServer
let openai: ReturnType<typeof fakeOpenAI>

beforeEach(async () => {
  openai = fakeOpenAI(() => imagesResponse(1))
  t = await startServer(
    { IMAGE_BACKEND_MODE: 'openai', OPENAI_API_KEY: FAKE_KEY, ALLOWED_MODELS: 'gpt-image-1,gpt-image-1-mini,dall-e-2' },
    { fetchImpl: openai.fetchImpl },
  )
})
afterEach(() => t.close())

async function expectInvalid(body: Record<string, unknown>, code = 'invalid_request', path = '/api/images/quote') {
  const res = await t.request('POST', path, { body, headers: { 'X-Cost-Quote': 'qualquer' } })
  expect(res.status, JSON.stringify(res.json)).toBe(400)
  expect(res.json.error.code).toBe(code)
  return res.json.error.message as string
}

describe('validação de parâmetros', () => {
  it('só aceita modelos da lista permitida', async () => {
    expect(await expectInvalid({ ...VALID_JOB, model: 'gpt-4o' })).toMatch(/Modelo não permitido/)
    // existe no catálogo, mas está fora de ALLOWED_MODELS
    expect(await expectInvalid({ ...VALID_JOB, model: 'dall-e-3', size: '1024x1024' })).toMatch(/Modelo não permitido/)
  })

  it('tamanho, qualidade e quantidade', async () => {
    await expectInvalid({ ...VALID_JOB, size: '4096x4096' })
    await expectInvalid({ ...VALID_JOB, quality: 'ultra' })
    await expectInvalid({ model: 'dall-e-2', prompt: 'x', size: '512x512', quality: 'hd', totalImages: 1 })
    await expectInvalid({ ...VALID_JOB, totalImages: 0 })
    await expectInvalid({ ...VALID_JOB, totalImages: 1.5 })
    await expectInvalid({ ...VALID_JOB, totalImages: 11 })
    await expectInvalid({ ...VALID_JOB, totalImages: '2' })
  })

  it('n por chamada respeita o limite do modelo', async () => {
    await expectInvalid({ model: 'gpt-image-1', prompt: 'x', size: '1024x1024', n: 11 }, 'invalid_request', '/api/images/generate')
  })

  it('prompt vazio, não-texto ou longo demais para o modelo', async () => {
    await expectInvalid({ ...VALID_JOB, prompt: '   ' })
    await expectInvalid({ ...VALID_JOB, prompt: 42 })
    expect(
      await expectInvalid({ model: 'dall-e-2', prompt: 'a'.repeat(1001), size: '512x512', totalImages: 1 }),
    ).toMatch(/1000 caracteres/)
  })

  it('recusa campos desconhecidos (nada arbitrário vai para a OpenAI)', async () => {
    expect(await expectInvalid({ ...VALID_JOB, response_format: 'url' })).toMatch(/Campo não permitido/)
    await expectInvalid({ ...VALID_JOB, user: 'x', model: 'gpt-image-1' })
  })

  it('campos das próximas etapas são recusados com mensagem clara', async () => {
    const message = await expectInvalid({ ...VALID_JOB, characters: [] }, 'not_supported_yet')
    expect(message).toMatch(/personagens.*ainda não é suportado/)
    await expectInvalid({ ...VALID_JOB, scenes: [] }, 'not_supported_yet')
  })

  it('corpo que não é objeto', async () => {
    const res = await t.request('POST', '/api/images/quote', { rawBody: '[1,2]' })
    expect(res.status).toBe(400)
  })

  it('nenhuma requisição inválida chega à OpenAI', async () => {
    await expectInvalid({ ...VALID_JOB, model: 'gpt-4o' })
    await expectInvalid({ model: 'gpt-image-1', prompt: '', size: '1024x1024', n: 1 }, 'invalid_request', '/api/images/generate')
    expect(openai.calls).toHaveLength(0)
  })
})
