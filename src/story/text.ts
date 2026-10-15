// Utilitários de texto para localizar trechos na copy sem alterá-la.

const HONORIFICS = new Set(['dona', 'seu', 'sr', 'sra', 'srta', 'dr', 'dra', 'tia', 'tio', 'vo', 'vó', 'vovo', 'vovó', 'dom', 'professor', 'professora', 'prof'])

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// "Dona Maria " → "maria"; "Sr. João" → "joao"
export function normalizeName(name: string): string {
  const tokens = stripAccents(name.toLowerCase())
    .replace(/[.,;:!?"“”'()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift()
  return tokens.join(' ')
}

export function normalizeForSearch(s: string): string {
  return stripAccents(s.toLowerCase())
}

// Versão do texto com espaços e aspas/travessões normalizados, mais um mapa
// de cada posição normalizada para a posição original.
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = ''
  const map: number[] = []
  let lastSpace = false
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]
    if (/\s/.test(ch)) {
      if (lastSpace) continue
      ch = ' '
      lastSpace = true
    } else {
      lastSpace = false
      if ('“”„«»'.includes(ch)) ch = '"'
      else if ('‘’'.includes(ch)) ch = "'"
      else if ('–—'.includes(ch)) ch = '-'
      else if (ch === '…') ch = '.'
    }
    norm += ch
    map.push(i)
  }
  return { norm, map }
}

// Acha um trecho citado na copy a partir de `from`. Primeiro busca exata;
// se não achar, tolera diferenças só de espaços, aspas e travessões. Nunca
// tolera palavras diferentes.
export function locateQuote(copy: string, quote: string, from = 0): { start: number; end: number } | null {
  const q = quote.trim()
  if (!q) return null
  const exact = copy.indexOf(q, from)
  if (exact >= 0) return { start: exact, end: exact + q.length }

  const c = normalizeWithMap(copy)
  const n = normalizeWithMap(q).norm.trim()
  if (!n) return null
  const fromNorm = c.map.findIndex((orig) => orig >= from)
  const idx = c.norm.indexOf(n, fromNorm < 0 ? c.norm.length : fromNorm)
  if (idx < 0) return null
  const start = c.map[idx]
  const end = c.map[idx + n.length - 1] + 1
  return { start, end }
}

// Divide a copy em blocos (por parágrafos) de até maxChars, sem cortar
// parágrafos — usado para interpretar historinhas longas em partes.
export function splitIntoChunks(copy: string, maxChars: number): Array<{ start: number; text: string }> {
  const chunks: Array<{ start: number; text: string }> = []
  const paragraphs = [...copy.matchAll(/[^\n]+(\n+|$)/g)]
  let current = ''
  let currentStart = 0
  for (const m of paragraphs) {
    const p = m[0]
    if (current && current.length + p.length > maxChars) {
      chunks.push({ start: currentStart, text: current })
      current = ''
    }
    if (!current) currentStart = m.index ?? 0
    current += p
  }
  if (current.trim()) chunks.push({ start: currentStart, text: current })
  return chunks
}

// Limites de frases dentro de um trecho (posições relativas ao trecho).
export function sentenceBoundaries(text: string): number[] {
  const cuts: number[] = []
  const re = /[.!?…]+["”']?\s+(?=[A-ZÀ-Ý"“—-])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) cuts.push(m.index + m[0].length)
  return cuts
}

export function hashText(text: string): string {
  // FNV-1a 32 bits: só pra detectar mudança de texto (não é segurança)
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
