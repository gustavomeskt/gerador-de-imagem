// Medidas feitas nos PIXELS de uma imagem (no navegador, com canvas):
// brilho médio, se é praticamente uniforme (falha de geração) e uma
// assinatura visual (dHash 9×8 → 64 bits) para achar imagens quase iguais ou
// muito diferentes. São indicadores técnicos — não dizem se o rosto é da
// pessoa certa.

export interface PixelStats {
  width: number
  height: number
  meanLuma: number
  stdLuma: number
  hash: string // 16 dígitos hexadecimais
}

export function analyzeImage(src: string): Promise<PixelStats> {
  return new Promise((resolve0, reject0) => {
    let resolve = resolve0
    let reject = reject0
    if (typeof document === 'undefined' || typeof Image === 'undefined' || /jsdom/i.test(navigator.userAgent)) {
      reject(new Error('análise de imagem indisponível neste ambiente'))
      return
    }
    // imagem que nunca carrega (nem dá erro) não pode travar a fila
    const timer = setTimeout(() => reject(new Error('tempo esgotado ao carregar a imagem')), 8000)
    const done = <T,>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(timer)
      fn(v)
    }
    resolve = done(resolve)
    reject = done(reject)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 9
        canvas.height = 8
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('canvas indisponível')
        ctx.drawImage(img, 0, 0, 9, 8)
        const data = ctx.getImageData(0, 0, 9, 8).data
        resolve(statsFromRgba(data, 9, 8, img.naturalWidth, img.naturalHeight))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('falha na análise'))
      }
    }
    img.onerror = () => reject(new Error('não foi possível carregar a imagem para análise'))
    img.src = src
  })
}

// Cálculo puro a partir de pixels RGBA reduzidos a 9×8 (testável).
export function statsFromRgba(data: ArrayLike<number>, w: number, h: number, width: number, height: number): PixelStats {
  const luma: number[] = []
  for (let i = 0; i < w * h; i++) luma.push(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2])
  const mean = luma.reduce((a, b) => a + b, 0) / luma.length
  const std = Math.sqrt(luma.reduce((a, b) => a + (b - mean) ** 2, 0) / luma.length)
  let bits = ''
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) bits += luma[y * w + x] > luma[y * w + x + 1] ? '1' : '0'
  let hash = ''
  for (let i = 0; i < bits.length; i += 4) hash += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return { width, height, meanLuma: Math.round(mean), stdLuma: Math.round(std * 10) / 10, hash }
}

export function hashDistance(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

export const DUPLICATE_DISTANCE = 4 // de 64: praticamente a mesma imagem
export const VERY_DIFFERENT_DISTANCE = 40 // de 64: composição muito diferente
