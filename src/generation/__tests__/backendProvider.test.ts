import { describe, expect, it, vi } from 'vitest'
import { BACKEND_UNAVAILABLE_MESSAGE, createBackendProvider } from '../backendProvider'
import { ProviderError, type ImageGenerationRequest } from '../types'

const request: ImageGenerationRequest = {
  model: 'gpt-image-1.5',
  prompt: 'cena',
  size: '1024x1536',
  quality: 'high',
  n: 2,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('provedor via backend', () => {
  it('chama /api/images/generate sem nenhuma credencial e converte para data URL', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { images: [{ b64: 'AAA' }, { b64: 'BBB', mimeType: 'image/webp' }] }),
    )
    const provider = createBackendProvider({ fetchImpl })

    const images = await provider.generateImages(request)

    expect(images).toEqual([
      { src: 'data:image/png;base64,AAA', mimeType: 'image/png' },
      { src: 'data:image/webp;base64,BBB', mimeType: 'image/webp' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/images/generate')
    expect(JSON.parse(init?.body as string)).toEqual(request)
    const headers = new Headers(init?.headers)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('repassa a mensagem de erro do backend', async () => {
    const provider = createBackendProvider({
      fetchImpl: async () => jsonResponse(400, { error: { message: 'Prompt recusado' } }),
    })
    await expect(provider.generateImages(request)).rejects.toThrow('Prompt recusado')
  })

  it('avisa quando o backend não está rodando', async () => {
    const offline = createBackendProvider({
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(offline.generateImages(request)).rejects.toThrow(BACKEND_UNAVAILABLE_MESSAGE)

    const proxyWithoutServer = createBackendProvider({ fetchImpl: async () => new Response('', { status: 502 }) })
    await expect(proxyWithoutServer.enhancePrompt('x')).rejects.toThrow(BACKEND_UNAVAILABLE_MESSAGE)
  })

  it('rejeita respostas malformadas', async () => {
    const provider = createBackendProvider({ fetchImpl: async () => jsonResponse(200, { nada: true }) })
    await expect(provider.generateImages(request)).rejects.toBeInstanceOf(ProviderError)
    await expect(provider.enhancePrompt('x')).rejects.toBeInstanceOf(ProviderError)
  })

  it('melhora prompt via /api/prompts/enhance', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { prompt: '  detalhado  ' }))
    const provider = createBackendProvider({ fetchImpl })
    await expect(provider.enhancePrompt('curto')).resolves.toBe('detalhado')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/prompts/enhance')
  })
})

describe('orçamento e confirmação', () => {
  const quote = {
    quoteId: 'q-1',
    kind: 'images',
    expiresAt: '2026-10-15T00:10:00.000Z',
    mode: 'openai',
    paid: true,
    estimatedUsd: 0.5,
    images: 2,
    breakdown: ['2 × US$ 0.25'],
    notes: [],
  }

  it('pede orçamento do trabalho inteiro em /api/images/quote', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, quote))
    const provider = createBackendProvider({ fetchImpl })
    const job = { model: 'gpt-image-1.5' as const, prompt: 'cena', size: '1024x1536', quality: 'high', totalImages: 2 }
    await expect(provider.quoteImages!(job)).resolves.toEqual(quote)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/images/quote')
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual(job)
  })

  it('envia o orçamento confirmado no cabeçalho X-Cost-Quote (e nunca uma chave)', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { images: [{ b64: 'AAA' }] }))
    const provider = createBackendProvider({ fetchImpl })
    await provider.generateImages(request, { quoteId: 'q-1' })
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers)
    expect(headers.get('X-Cost-Quote')).toBe('q-1')
    expect(headers.has('Authorization')).toBe(false)
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual(request) // corpo = contrato original
  })

  it('orçamento malformado é recusado', async () => {
    const provider = createBackendProvider({ fetchImpl: async () => jsonResponse(200, { quoteId: 1 }) })
    await expect(provider.quoteEnhance!('x')).rejects.toBeInstanceOf(ProviderError)
  })

  it('mostra a mensagem do servidor quando falta confirmação ou estoura limite', async () => {
    const provider = createBackendProvider({
      fetchImpl: async () => jsonResponse(429, { error: { message: 'Limite diário de imagens atingido', code: 'daily_image_limit' } }),
    })
    await expect(provider.generateImages(request)).rejects.toThrow('Limite diário de imagens atingido')
  })

  it('consulta o status do servidor', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { mode: 'simulated', keyConfigured: false }))
    const provider = createBackendProvider({ fetchImpl })
    await expect(provider.fetchStatus()).resolves.toMatchObject({ mode: 'simulated' })
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET')
  })
})
