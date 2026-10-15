// Conversões entre data URL, bytes e base64, e leitura das dimensões de uma
// imagem direto dos bytes (sem precisar de canvas).

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('Imagem em formato inesperado (data URL inválida)')
  const mimeType = match[1] || 'application/octet-stream'
  const payload = match[4]
  const bytes = match[3] ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload))
  return { bytes, mimeType }
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`
}

// Copia pra um ArrayBuffer próprio (o Uint8Array pode ser uma "janela" de um
// buffer maior).
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export function extensionFor(mimeType: string | undefined): string {
  return MIME_EXTENSIONS[mimeType ?? ''] ?? 'png'
}

// Dimensões em pixels lidas do cabeçalho do arquivo (PNG, JPEG, SVG).
export function readImageSize(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // assinatura PNG + chunk IHDR
    if (view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
      return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    return undefined
  }

  if (mimeType === 'image/jpeg') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]
      const length = view.getUint16(offset + 2)
      // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      offset += 2 + length
    }
    return undefined
  }

  if (mimeType === 'image/svg+xml') {
    const head = new TextDecoder().decode(bytes.subarray(0, 2048))
    const svgTag = /<svg\b[^>]*>/i.exec(head)?.[0]
    const width = svgTag && /\bwidth="(\d+(?:\.\d+)?)"/.exec(svgTag)?.[1]
    const height = svgTag && /\bheight="(\d+(?:\.\d+)?)"/.exec(svgTag)?.[1]
    return width && height ? { width: Number(width), height: Number(height) } : undefined
  }

  return undefined
}
