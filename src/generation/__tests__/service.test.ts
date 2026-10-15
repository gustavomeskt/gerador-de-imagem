import { describe, expect, it, vi } from 'vitest'
import { resolveAspect, runGeneration } from '../service'
import type { GeneratedImage, ImageGenerationRequest, ImageProvider } from '../types'

function fakeProvider(impl: (req: ImageGenerationRequest) => Promise<GeneratedImage[]>): ImageProvider & {
  generateImages: ReturnType<typeof vi.fn>
} {
  return {
    kind: 'mock',
    label: 'fake',
    generateImages: vi.fn(impl),
    enhancePrompt: async (p) => p,
  }
}

const img = (src: string): GeneratedImage => ({ src, mimeType: 'image/svg+xml' })
const identityCrop = vi.fn(async (src: string) => `${src}#cropped`)

describe('runGeneration', () => {
  it('divide em chamadas pelo limite do modelo (dall-e-3 = 1 por vez)', async () => {
    const provider = fakeProvider(async (req) => Array.from({ length: req.n }, (_, i) => img(`img-${i}`)))
    const results = await runGeneration({
      provider,
      config: { model: 'dall-e-3', size: '1024x1024', quality: 'hd' },
      prompt: 'p',
      count: 3,
      crop: identityCrop,
    })

    expect(provider.generateImages).toHaveBeenCalledTimes(3)
    expect(provider.generateImages).toHaveBeenCalledWith(
      { model: 'dall-e-3', prompt: 'p', size: '1024x1024', quality: 'hd', n: 1 },
      undefined,
    )
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('repassa o orçamento confirmado (quoteId) em todas as chamadas', async () => {
    const provider = fakeProvider(async (req) => Array.from({ length: req.n }, () => img('x')))
    await runGeneration({
      provider,
      config: { model: 'dall-e-3', size: '1024x1024' },
      prompt: 'p',
      count: 2,
      crop: identityCrop,
      quoteId: 'q-123',
    })
    expect(provider.generateImages).toHaveBeenCalledTimes(2)
    for (const call of provider.generateImages.mock.calls) expect(call[1]).toEqual({ quoteId: 'q-123' })
  })

  it('uma chamada que falha não derruba as outras', async () => {
    let call = 0
    const provider = fakeProvider(async () => {
      call += 1
      if (call === 2) throw new Error('limite de requisições')
      return [img(`ok-${call}`)]
    })
    const results = await runGeneration({
      provider,
      config: { model: 'dall-e-3', size: '1024x1024' },
      prompt: 'p',
      count: 3,
      crop: identityCrop,
    })

    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    expect(results[1]).toEqual({ ok: false, error: 'limite de requisições' })
  })

  it('marca como "Sem resposta" quando a API devolve menos imagens', async () => {
    const provider = fakeProvider(async () => [img('a')])
    const results = await runGeneration({
      provider,
      config: { model: 'gpt-image-1', size: '1024x1024' },
      prompt: 'p',
      count: 3,
      crop: identityCrop,
    })
    expect(results).toEqual([
      { ok: true, image: img('a') },
      { ok: false, error: 'Sem resposta' },
      { ok: false, error: 'Sem resposta' },
    ])
  })

  it('recorta só os tamanhos que não são nativos', async () => {
    const provider = fakeProvider(async (req) => Array.from({ length: req.n }, () => img('raw')))
    identityCrop.mockClear()

    const square = await runGeneration({
      provider,
      config: { model: 'gpt-image-1.5', size: '1024x1024' },
      prompt: 'p',
      count: 1,
      crop: identityCrop,
    })
    expect(identityCrop).not.toHaveBeenCalled()
    expect(square[0]).toEqual({ ok: true, image: img('raw') })

    const vertical = await runGeneration({
      provider,
      config: { model: 'gpt-image-1.5', size: '1024x1536' },
      prompt: 'p',
      count: 2,
      crop: identityCrop,
    })
    expect(identityCrop).toHaveBeenCalledWith('raw', 9 / 16)
    expect(vertical[0]).toEqual({ ok: true, image: { src: 'raw#cropped', mimeType: 'image/png' } })
  })

  it('erro no recorte vira erro daquela imagem', async () => {
    const provider = fakeProvider(async () => [img('raw')])
    const results = await runGeneration({
      provider,
      config: { model: 'gpt-image-1.5', size: '1536x1024' },
      prompt: 'p',
      count: 1,
      crop: async () => {
        throw new Error('canvas indisponível')
      },
    })
    expect(results).toEqual([{ ok: false, error: 'canvas indisponível' }])
  })
})

describe('resolveAspect', () => {
  it('usa a proporção final do tamanho escolhido', () => {
    expect(resolveAspect({ model: 'gpt-image-1.5', size: '1024x1536' })).toBeCloseTo(9 / 16)
    expect(resolveAspect({ model: 'dall-e-2', size: '512x512' })).toBe(1)
    expect(resolveAspect({ model: 'dall-e-2', size: 'inexistente' })).toBe(1)
  })
})
