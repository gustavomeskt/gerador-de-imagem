import { describe, expect, it } from 'vitest'
import { readImageSize, sniffImageType, bytesToBase64 } from '../../lib/binary'
import { jpegBytes, pngBytes, webpBytes } from '../../test/fixtures'
import { buildOpenAIEditForm } from '../openaiRequest'
import {
  buildReferencePrompt,
  checkReferenceFile,
  DEFAULT_MAX_REFERENCE_BYTES,
  effectiveFidelity,
  REFERENCE_SUPPORT,
  supportsReferences,
} from '../references'

describe('validação de arquivos de referência (pelos bytes)', () => {
  it('aceita PNG, JPG e WebP e lê as dimensões', () => {
    expect(checkReferenceFile(pngBytes(800, 1200))).toEqual({ ok: true, mimeType: 'image/png', width: 800, height: 1200 })
    expect(checkReferenceFile(jpegBytes(864, 1536))).toEqual({ ok: true, mimeType: 'image/jpeg', width: 864, height: 1536 })
    expect(checkReferenceFile(webpBytes(1024, 768))).toEqual({ ok: true, mimeType: 'image/webp', width: 1024, height: 768 })
  })

  it('recusa formatos não suportados, arquivo vazio e arquivo grande demais', () => {
    const gif = new TextEncoder().encode('GIF89a......')
    expect(checkReferenceFile(gif)).toMatchObject({ ok: false, error: expect.stringMatching(/formato não suportado/) })
    expect(checkReferenceFile(new TextEncoder().encode('<svg></svg>'))).toMatchObject({ ok: false })
    expect(checkReferenceFile(new Uint8Array(0))).toMatchObject({ ok: false, error: 'arquivo vazio' })
    const big = new Uint8Array(DEFAULT_MAX_REFERENCE_BYTES + 1)
    big.set(pngBytes(10, 10))
    expect(checkReferenceFile(big)).toMatchObject({ ok: false, error: expect.stringMatching(/maior que 8 MB/) })
  })

  it('PNG com cabeçalho quebrado é recusado (não dá pra ler dimensões)', () => {
    const broken = pngBytes(10, 10)
    broken[12] = 0 // estraga o "IHDR"
    expect(checkReferenceFile(broken)).toMatchObject({ ok: false })
  })

  it('reconhece WebP VP8 (com perda) e VP8L (sem perda)', () => {
    const vp8 = new Uint8Array(40)
    vp8.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])
    vp8.set([0x9d, 0x01, 0x2a], 23)
    new DataView(vp8.buffer).setUint16(26, 640, true)
    new DataView(vp8.buffer).setUint16(28, 480, true)
    expect(sniffImageType(vp8)).toBe('image/webp')
    expect(readImageSize(vp8, 'image/webp')).toEqual({ width: 640, height: 480 })

    const vp8l = new Uint8Array(40)
    vp8l.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c])
    vp8l[20] = 0x2f
    new DataView(vp8l.buffer).setUint32(21, (300 - 1) | ((200 - 1) << 14), true)
    expect(readImageSize(vp8l, 'image/webp')).toEqual({ width: 300, height: 200 })
  })
})

describe('modelos e fidelidade', () => {
  it('só GPT Image aceita referências (até 16 pela API)', () => {
    expect(supportsReferences('gpt-image-1.5')).toBe(true)
    expect(supportsReferences('gpt-image-1-mini')).toBe(true)
    expect(supportsReferences('dall-e-3')).toBe(false)
    expect(supportsReferences('dall-e-2')).toBe(false)
    expect(REFERENCE_SUPPORT['gpt-image-1']?.maxImages).toBe(16)
  })

  it('input_fidelity só é enviado quando o modelo permite escolher', () => {
    expect(effectiveFidelity('gpt-image-1.5', undefined)).toBe('high')
    expect(effectiveFidelity('gpt-image-1', 'low')).toBe('low')
    expect(effectiveFidelity('gpt-image-1-mini', 'high')).toBeUndefined() // mini só tem "low" (padrão)
    expect(effectiveFidelity('dall-e-3', 'high')).toBeUndefined()
  })
})

describe('texto que associa cada imagem ao seu papel', () => {
  it('numera as imagens na ordem e mantém a cena intacta', () => {
    const prompt = buildReferencePrompt('Maria sorri na cozinha segurando o pote', [
      { label: 'Maria', role: 'character', preserveClothing: true, imageCount: 2 },
      { label: 'Pote de gelatina', role: 'object', preserveClothing: false, imageCount: 1 },
    ])
    expect(prompt).toContain('Images 1-2: "Maria" — the same real person')
    expect(prompt).toContain('same apparent age')
    expect(prompt).toContain('Keep the same clothing')
    expect(prompt).toContain('Image 3: "Pote de gelatina" — object')
    expect(prompt).toContain('Do not add any text, captions, logos or watermarks')
    expect(prompt.endsWith('Scene: Maria sorri na cozinha segurando o pote')).toBe(true)
  })

  it('com duas pessoas, pede para não misturar identidades; roupa livre quando não marcada', () => {
    const prompt = buildReferencePrompt('cena', [
      { label: 'Maria', role: 'character', preserveClothing: false, imageCount: 1 },
      { label: 'João', role: 'character', preserveClothing: false, imageCount: 1 },
    ])
    expect(prompt).toContain('never mix or swap features')
    expect(prompt).toContain('Clothing may follow the scene description')
  })

  it('sem referências, o prompt fica igual', () => {
    expect(buildReferencePrompt('cena simples', [])).toBe('cena simples')
  })
})

describe('formulário multipart do endpoint de edição', () => {
  it('envia cada foto como arquivo em image[], na ordem, com os bytes intactos', async () => {
    const a = pngBytes(100, 100, 1)
    const b = jpegBytes(200, 300, 2)
    const ref = (bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg') => ({
      sha256: 'x'.repeat(64),
      mimeType,
      byteLength: bytes.byteLength,
      width: 1,
      height: 1,
      b64: bytesToBase64(bytes),
    })
    const form = buildOpenAIEditForm({
      model: 'gpt-image-1.5',
      prompt: 'cena',
      size: '1024x1536',
      quality: 'high',
      n: 2,
      references: [ref(a, 'image/png'), ref(b, 'image/jpeg')],
      inputFidelity: 'high',
    })
    expect(form.get('model')).toBe('gpt-image-1.5')
    expect(form.get('n')).toBe('2')
    expect(form.get('size')).toBe('1024x1536')
    expect(form.get('quality')).toBe('high')
    expect(form.get('input_fidelity')).toBe('high')
    const files = form.getAll('image[]') as File[]
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['referencia-1.png', 'image/png'],
      ['referencia-2.jpg', 'image/jpeg'],
    ])
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(a)
    expect(new Uint8Array(await files[1].arrayBuffer())).toEqual(b)
  })

  it('sem fidelidade definida, não envia input_fidelity; sem referências, recusa', () => {
    const bytes = pngBytes(10, 10)
    const form = buildOpenAIEditForm({
      model: 'gpt-image-1-mini',
      prompt: 'x',
      size: '1024x1024',
      n: 1,
      references: [{ sha256: 'x'.repeat(64), mimeType: 'image/png', byteLength: bytes.byteLength, width: 10, height: 10, b64: bytesToBase64(bytes) }],
    })
    expect(form.has('input_fidelity')).toBe(false)
    expect(() => buildOpenAIEditForm({ model: 'gpt-image-1', prompt: 'x', size: '1024x1024', n: 1 })).toThrow()
  })
})
