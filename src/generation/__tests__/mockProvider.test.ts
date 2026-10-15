import { describe, expect, it } from 'vitest'
import { createMockProvider, parseSize, renderMockSvg, SIMULATE_ERROR_TOKEN } from '../mockProvider'
import { ProviderError } from '../types'

function decodeSvg(src: string): string {
  const b64 = src.replace('data:image/svg+xml;base64,', '')
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

describe('provedor simulado', () => {
  const provider = createMockProvider()

  it('gera a quantidade pedida de imagens SVG no tamanho da API', async () => {
    const images = await provider.generateImages({
      model: 'gpt-image-1.5',
      prompt: 'Uma mulher tomando café na cozinha',
      size: '1024x1536',
      quality: 'high',
      n: 3,
    })

    expect(images).toHaveLength(3)
    for (const img of images) {
      expect(img.mimeType).toBe('image/svg+xml')
      expect(img.src.startsWith('data:image/svg+xml;base64,')).toBe(true)
      const svg = decodeSvg(img.src)
      expect(svg).toContain('width="1024" height="1536"')
      expect(svg).toContain('IMAGEM SIMULADA')
      expect(svg).toContain('gpt-image-1.5 · 1024x1536 · high')
    }
    // cada imagem é diferente (número sequencial), como numa regeração real
    expect(new Set(images.map((i) => i.src)).size).toBe(3)
  })

  it('escapa o prompt para não quebrar o SVG e preserva acentos', async () => {
    const [img] = await provider.generateImages({
      model: 'dall-e-3',
      prompt: 'João & Maria <script>alert(1)</script> "aspas"',
      size: '1024x1024',
      n: 1,
    })
    const svg = decodeSvg(img.src)
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('João &amp; Maria &lt;script&gt;')
  })

  it('simula erro quando o prompt pede', async () => {
    await expect(
      provider.generateImages({ model: 'dall-e-2', prompt: `teste ${SIMULATE_ERROR_TOKEN}`, size: '256x256', n: 1 }),
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('melhora o prompt sem perder o texto original', async () => {
    const enhanced = await provider.enhancePrompt('  cachorro na praia  ')
    expect(enhanced.startsWith('cachorro na praia')).toBe(true)
    await expect(provider.enhancePrompt('   ')).rejects.toBeInstanceOf(ProviderError)
  })

  it('não faz nenhuma chamada de rede', async () => {
    const originalFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (() => {
      called = true
      throw new Error('rede proibida')
    }) as typeof fetch
    try {
      await provider.generateImages({ model: 'gpt-image-1', prompt: 'x', size: '1024x1024', n: 1 })
      await provider.enhancePrompt('x')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(called).toBe(false)
  })
})

describe('utilitários do simulado', () => {
  it('lê tamanhos no formato LxA', () => {
    expect(parseSize('1536x1024')).toEqual({ width: 1536, height: 1024 })
    expect(() => parseSize('grande')).toThrow(ProviderError)
  })

  it('renderiza prompts longos sem estourar o número de linhas', () => {
    const svg = renderMockSvg({ prompt: 'palavra '.repeat(400), model: 'm', size: '512x512', index: 1 })
    expect((svg.match(/<tspan/g) ?? []).length).toBeLessThanOrEqual(8)
  })
})
