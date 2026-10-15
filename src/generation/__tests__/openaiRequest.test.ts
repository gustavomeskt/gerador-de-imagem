import { describe, expect, it } from 'vitest'
import { buildEnhancerBody, buildOpenAIImageBody, PROMPT_ENHANCER_MODEL } from '../openaiRequest'

describe('montagem do pedido para a OpenAI (uso do backend)', () => {
  it('gpt-image envia qualidade e não pede response_format', () => {
    expect(
      buildOpenAIImageBody({ model: 'gpt-image-1.5', prompt: 'p', size: '1024x1536', quality: 'high', n: 2 }),
    ).toEqual({ model: 'gpt-image-1.5', prompt: 'p', size: '1024x1536', n: 2, quality: 'high' })
  })

  it('dall-e-3 pede base64 e envia qualidade', () => {
    expect(buildOpenAIImageBody({ model: 'dall-e-3', prompt: 'p', size: '1024x1024', quality: 'hd', n: 1 })).toEqual({
      model: 'dall-e-3',
      prompt: 'p',
      size: '1024x1024',
      n: 1,
      response_format: 'b64_json',
      quality: 'hd',
    })
  })

  it('dall-e-2 ignora qualidade', () => {
    const body = buildOpenAIImageBody({ model: 'dall-e-2', prompt: 'p', size: '512x512', quality: 'hd', n: 4 })
    expect(body.quality).toBeUndefined()
    expect(body.response_format).toBe('b64_json')
  })

  it('o melhorador usa o modelo de texto com o prompt do usuário', () => {
    const body = buildEnhancerBody('gato') as { model: string; messages: Array<{ role: string; content: string }> }
    expect(body.model).toBe(PROMPT_ENHANCER_MODEL)
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'gato' })
  })
})
