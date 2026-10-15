import { ProviderError, type GeneratedImage, type ImageGenerationRequest, type ImageProvider } from './types'

// Provedor simulado: gera imagens de teste localmente (SVG com o prompt,
// modelo, tamanho e número da imagem desenhados), sem rede e sem custo.
// Serve pra desenvolver e testar todo o fluxo — geração, regeração, erros,
// recorte, download — sem gastar com a API.
//
// Pra testar o caminho de erro, inclua SIMULATE_ERROR_TOKEN no prompt.

export const SIMULATE_ERROR_TOKEN = '[simular-erro]'

export interface MockProviderOptions {
  // atraso artificial por chamada, pra simular a espera da API real
  latencyMs?: number
}

let sequence = 0

function hashString(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Quebra o prompt em linhas curtas pra caber na imagem.
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
    if (lines.length === maxLines) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 1)}…`
  }
  return lines
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) throw new ProviderError(`Tamanho inválido: ${size}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function renderMockSvg(params: {
  prompt: string
  model: string
  size: string
  quality?: string
  index: number
}): string {
  const { width, height } = parseSize(params.size)
  const hue = hashString(params.prompt) % 360
  const hue2 = (hue + 40 + params.index * 23) % 360
  const fontSize = Math.round(Math.min(width, height) / 22)
  const lineHeight = Math.round(fontSize * 1.35)
  const lines = wrapText(params.prompt, Math.floor(width / (fontSize * 0.55)), 8)
  const startY = Math.round(height / 2 - (lines.length * lineHeight) / 2)

  const text = lines
    .map((line, i) => `<tspan x="50%" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('')

  const footer = escapeXml(
    `${params.model} · ${params.size}${params.quality ? ` · ${params.quality}` : ''} · #${params.index}`,
  )

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="hsl(${hue},55%,32%)"/>`,
    `<stop offset="1" stop-color="hsl(${hue2},60%,18%)"/>`,
    '</linearGradient></defs>',
    `<rect width="${width}" height="${height}" fill="url(#g)"/>`,
    // moldura de "área segura" — ajuda a ver o que o recorte 9:16/16:9 corta
    `<rect x="${width * 0.05}" y="${height * 0.05}" width="${width * 0.9}" height="${height * 0.9}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="${Math.max(2, fontSize / 8)}" stroke-dasharray="${fontSize} ${fontSize / 2}"/>`,
    `<text x="50%" y="${Math.round(height * 0.12)}" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="700" fill="rgba(255,255,255,0.9)">IMAGEM SIMULADA</text>`,
    `<text text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" fill="#ffffff">${text}</text>`,
    `<text x="50%" y="${Math.round(height * 0.92)}" text-anchor="middle" font-family="monospace" font-size="${Math.round(fontSize * 0.7)}" fill="rgba(255,255,255,0.75)">${footer}</text>`,
    '</svg>',
  ].join('')
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export function createMockProvider(options: MockProviderOptions = {}): ImageProvider {
  const latencyMs = options.latencyMs ?? 0

  return {
    kind: 'mock',
    label: 'Simulado (grátis, sem API)',

    async generateImages(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
      await delay(latencyMs)

      if (request.prompt.includes(SIMULATE_ERROR_TOKEN)) {
        throw new ProviderError('Erro simulado pelo provedor de teste.')
      }

      // com referências, mostra na imagem quantas chegaram (e o começo do
      // hash de cada uma) — confirma que as fotos foram usadas no pedido
      const refs = request.references ?? []
      const prompt = refs.length
        ? `[${refs.length} referência(s): ${refs.map((r) => `${r.width}x${r.height} ${r.sha256.slice(0, 8)}`).join(' | ')}] ${request.prompt}`
        : request.prompt
      return Array.from({ length: request.n }, () => {
        sequence += 1
        const svg = renderMockSvg({ ...request, prompt, index: sequence })
        return { src: `data:image/svg+xml;base64,${toBase64Utf8(svg)}`, mimeType: 'image/svg+xml' }
      })
    },

    async enhancePrompt(prompt: string): Promise<string> {
      await delay(latencyMs)
      const trimmed = prompt.trim()
      if (!trimmed) throw new ProviderError('Prompt vazio.')
      return `${trimmed}\n\n[simulado] Prompt melhorado de teste: mesma cena, sem alterar o pedido original.`
    },
  }
}
