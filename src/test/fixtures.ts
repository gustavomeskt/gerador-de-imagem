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
