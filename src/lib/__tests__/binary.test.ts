import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToDataUrl,
  dataUrlToBytes,
  extensionFor,
  readImageSize,
  sha256Hex,
} from '../binary'

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('conversões binárias', () => {
  it('ida e volta base64 sem perder bytes', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('lê data URLs base64 e percent-encoded', () => {
    const png = bytesToDataUrl(new Uint8Array([1, 2, 3]), 'image/png')
    expect(dataUrlToBytes(png)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })

    const svg = dataUrlToBytes('data:image/svg+xml;charset=utf-8,%3Csvg%3Eol%C3%A1%3C%2Fsvg%3E')
    expect(svg.mimeType).toBe('image/svg+xml')
    expect(new TextDecoder().decode(svg.bytes)).toBe('<svg>olá</svg>')
  })

  it('rejeita data URL inválida', () => {
    expect(() => dataUrlToBytes('https://exemplo.com/a.png')).toThrow()
  })

  it('calcula SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('escolhe a extensão pelo tipo', () => {
    expect(extensionFor('image/svg+xml')).toBe('svg')
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor(undefined)).toBe('png')
  })
})

describe('readImageSize', () => {
  it('PNG', () => {
    expect(readImageSize(pngHeader(864, 1536), 'image/png')).toEqual({ width: 864, height: 1536 })
    expect(readImageSize(new Uint8Array(30), 'image/png')).toBeUndefined()
  })

  it('SVG', () => {
    const svg = new TextEncoder().encode('<svg xmlns="x" width="1024" height="1536" viewBox="0 0 1 1"></svg>')
    expect(readImageSize(svg, 'image/svg+xml')).toEqual({ width: 1024, height: 1536 })
  })

  it('JPEG (marcador SOF0)', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 curto
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x00, 0x03, 0x60, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    expect(readImageSize(jpeg, 'image/jpeg')).toEqual({ width: 864, height: 1536 })
  })
})
