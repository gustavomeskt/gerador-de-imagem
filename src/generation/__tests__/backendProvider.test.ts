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
