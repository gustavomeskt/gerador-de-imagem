import type { GeneratedImage } from '../generation/types'
import { dataUrlToBytes } from '../lib/binary'

// Imagem SVG mínima com um rótulo no <title>, pra os testes conseguirem
// saber qual imagem foi parar onde depois de salvar e restaurar.
export function svgImage(label: string, width = 100, height = 100): GeneratedImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><title>${label}</title></svg>`
  return { src: `data:image/svg+xml;base64,${btoa(svg)}`, mimeType: 'image/svg+xml' }
}

export function labelFromBytes(bytes: ArrayBuffer | Uint8Array): string | undefined {
  const text = new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  return /<title>(.*?)<\/title>/.exec(text)?.[1]
}

export function labelFromDataUrl(src: string): string | undefined {
  return labelFromBytes(dataUrlToBytes(src).bytes)
}

// --- arquivos de imagem fictícios (só cabeçalho válido + bytes de conteúdo) ---
// Bastam pra validação por assinatura e leitura de dimensões; o "conteúdo"
// muda com o seed, então cada arquivo tem um hash diferente.

function withPayload(header: number[], seed: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(header.length + size)
  bytes.set(header)
  for (let i = 0; i < size; i++) bytes[header.length + i] = (seed * 31 + i * 7) % 256
  return bytes
}

export function pngBytes(width: number, height: number, seed = 1): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  const bytes = withPayload([...header, 0, 0, 0, 0, 0, 0, 0, 0], seed)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

export function jpegBytes(width: number, height: number, seed = 1): Uint8Array {
  const header = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]
  const bytes = withPayload([...header, 0, 0, 0, 0, 0x03], seed)
  const view = new DataView(bytes.buffer)
  view.setUint16(13, height)
  view.setUint16(15, width)
  return bytes
}

export function webpBytes(width: number, height: number, seed = 1): Uint8Array {
  // RIFF....WEBPVP8X + flags + largura-1 e altura-1 em 24 bits
  const header = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]
  const w = width - 1
  const h = height - 1
  return withPayload([...header, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], seed)
}

export function fileFrom(name: string, bytes: Uint8Array) {
  return { name, arrayBuffer: async () => bytes.slice().buffer }
}
