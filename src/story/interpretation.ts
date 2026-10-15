import { matchCharacter, type LibraryEntry } from './characterMatching'
import { locateQuote, normalizeForSearch, normalizeName } from './text'
import type { RawInterpretation, RawScene, StoryCharacter, StoryScene } from './types'

// Validação da saída do interpretador (IA ou simulado). Nada entra no
// storyboard sem passar por aqui:
//   • cada cena precisa citar um trecho que EXISTE literalmente na copy;
//   • personagens, falante e objetos são conferidos contra a copy;
//   • o que não é sustentado pelo texto vira alerta para revisão humana (ou
//     "detalhe visual"), nunca um acontecimento novo.

export class InterpretationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterpretationError'
  }
}

export const MAX_SCENES = 500
const MAX_FIELD = 2000

function str(v: unknown, max = MAX_FIELD): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function strList(v: unknown, maxItems = 30, maxLen = 200): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : []
}

// Confere a forma do JSON (tipos e tamanhos). Lança se não for utilizável.
export function parseRawInterpretation(value: unknown): RawInterpretation {
  if (!value || typeof value !== 'object') throw new InterpretationError('A interpretação não veio no formato esperado (objeto JSON).')
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.scenes)) throw new InterpretationError('A interpretação não trouxe a lista de cenas.')
  if (v.scenes.length === 0) throw new InterpretationError('A interpretação não encontrou nenhuma cena.')
  if (v.scenes.length > MAX_SCENES) throw new InterpretationError(`Cenas demais na interpretação (máximo ${MAX_SCENES}).`)

  const characters = (Array.isArray(v.characters) ? v.characters : []).slice(0, 100).flatMap((c) => {
    const o = c as Record<string, unknown>
    const name = str(o?.name, 80)
    return name ? [{ name, mentions: strList(o?.mentions, 20, 80) }] : []
  })

  const scenes = v.scenes.map((s): RawScene => {
    const o = (s ?? {}) as Record<string, unknown>
    return {
      quote: typeof o.quote === 'string' ? o.quote.slice(0, 20000) : '',
      characters: strList(o.characters, 20, 80),
      speaker: str(o.speaker, 80) || null,
      dialogue: str(o.dialogue) || null,
      environment: str(o.environment, 200),
      action: str(o.action),
      emotions: str(o.emotions, 300),
      wardrobe: str(o.wardrobe, 500),
      objects: strList(o.objects, 30, 80),
      timeShift: str(o.timeShift, 200),
      continuity: str(o.continuity, 600),
      framing: str(o.framing, 200),
      camera: str(o.camera, 200),
      visualDescription: str(o.visualDescription),
      motion: str(o.motion, 600),
      ambiguities: strList(o.ambiguities, 10, 300),
    }
  })
  return { characters, scenes }
}

function mentionedIn(text: string, mentions: string[]): boolean {
  const t = normalizeForSearch(text)
  return mentions.some((m) => {
    const n = normalizeForSearch(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return n.length > 1 && new RegExp(`(?<![\\p{L}])${n}(?![\\p{L}])`, 'u').test(t)
  })
}

export interface BuiltInterpretation {
  characters: StoryCharacter[]
  scenes: StoryScene[]
  warnings: string[]
}

export function buildFromRaw(
  raw: RawInterpretation,
  copy: string,
  library: LibraryEntry[],
  makeId: (prefix: string) => string,
  now = Date.now(),
): BuiltInterpretation {
  const warnings: string[] = []
  const characters: StoryCharacter[] = []
  const byName = new Map<string, StoryCharacter>()

  const addCharacter = (name: string, mentions: string[]): StoryCharacter => {
    const key = normalizeName(name)
    const existing = byName.get(key)
    if (existing) {
      for (const m of mentions) if (!existing.mentions.includes(m)) existing.mentions.push(m)
      return existing
    }
    const match = matchCharacter(name, library)
    const c: StoryCharacter = { key: makeId('sc'), name, mentions: [...new Set([name, ...mentions])], ...match }
    characters.push(c)
    byName.set(key, c)
    for (const m of c.mentions) if (!byName.has(normalizeName(m))) byName.set(normalizeName(m), c)
    return c
  }

  for (const c of raw.characters) {
    if (!mentionedIn(copy, [c.name, ...c.mentions])) {
      warnings.push(`Personagem "${c.name}" não aparece na copy — ignorado.`)
      continue
    }
    addCharacter(c.name, c.mentions.filter((m) => mentionedIn(copy, [m])))
  }

  const scenes: StoryScene[] = []
  const copyNorm = normalizeForSearch(copy)
  let cursor = 0
  let prev: { quote: string; start: number; end: number } | null = null
  let lastEnvironment = ''

  for (const [i, s] of raw.scenes.entries()) {
    const flags = [...s.ambiguities]
    let span: { start: number; end: number } | null = null
    if (prev && s.quote.trim() === prev.quote.trim()) span = { start: prev.start, end: prev.end }
    else span = locateQuote(copy, s.quote, cursor)
    if (!span) {
      span = locateQuote(copy, s.quote, 0)
      if (span) flags.push('Trecho fora da ordem cronológica da copy — confira a posição desta cena.')
    }
    if (!span || !s.quote.trim()) {
      warnings.push(`Cena ${i + 1} descartada: o trecho citado não existe na copy ("${s.quote.slice(0, 60)}…").`)
      continue
    }
    cursor = Math.max(cursor, span.start)
    prev = { quote: s.quote, ...span }
    const excerpt = copy.slice(span.start, span.end)

    // personagens
    const keys: string[] = []
    for (const name of s.characters) {
      let c = byName.get(normalizeName(name))
      if (!c) {
        if (mentionedIn(excerpt, [name])) c = addCharacter(name, [])
        else {
          flags.push(`"${name}" não está na lista de personagens nem no trecho — não foi incluído.`)
          continue
        }
      }
      if (!keys.includes(c.key)) keys.push(c.key)
      if (!mentionedIn(excerpt, c.mentions) && s.speaker !== name) {
        flags.push(`${c.name} não é citado neste trecho (inferido pelo contexto) — confirme.`)
      }
    }

    let speakerKey: string | null = null
    if (s.speaker) {
      const c = byName.get(normalizeName(s.speaker))
      if (c && keys.includes(c.key)) speakerKey = c.key
      else if (c) {
        keys.unshift(c.key)
        speakerKey = c.key
      } else flags.push(`Quem fala ("${s.speaker}") não foi identificado — confirme.`)
    }

    let dialogue = s.dialogue ?? ''
    if (dialogue && !normalizeForSearch(excerpt).includes(normalizeForSearch(dialogue).slice(0, 40))) {
      flags.push('A fala indicada não está no trecho da copy — removida.')
      dialogue = ''
    }

    // objetos: só os citados na copy; o resto é detalhe visual, não acontecimento
    const objects: string[] = []
    const visualExtras: string[] = []
    for (const o of s.objects) {
      if (copyNorm.includes(normalizeForSearch(o))) objects.push(o)
      else {
        visualExtras.push(o)
        flags.push(`"${o}" não aparece na copy: tratado só como detalhe visual de composição, não como acontecimento.`)
      }
    }

    let environment = s.environment
    if (environment && environment !== lastEnvironment && !copyNorm.includes(normalizeForSearch(environment))) {
      flags.push(`Ambiente "${environment}" não aparece na copy — confirme.`)
    }
    if (environment) lastEnvironment = environment
    else environment = ''

    scenes.push({
      id: makeId('cena'),
      source: span,
      excerpt,
      characterKeys: keys,
      speakerKey,
      dialogue,
      environment,
      action: s.action || excerpt,
      emotions: s.emotions,
      wardrobe: s.wardrobe,
      objects,
      timeShift: s.timeShift,
      continuity: s.continuity,
      framing: s.framing,
      camera: s.camera,
      visualDescription: [s.visualDescription, visualExtras.length ? `(detalhes visuais de composição: ${visualExtras.join(', ')})` : '']
        .filter(Boolean)
        .join(' '),
      motion: s.motion,
      flags: [...new Set(flags)],
      status: 'pending',
      prompt: '',
      origin: 'interpreted',
      updatedAt: now,
    })
  }

  if (scenes.length === 0) throw new InterpretationError('Nenhuma cena válida: os trechos citados não foram encontrados na copy.')

  // trechos da copy que ficaram sem nenhuma cena
  for (const gap of uncoveredPassages(copy, scenes)) warnings.push(`Trecho da copy sem cena: "${gap.slice(0, 80)}${gap.length > 80 ? '…' : ''}"`)

  return { characters, scenes: withParts(scenes), warnings }
}

// Cenas consecutivas com o mesmo trecho = uma passagem dividida em várias imagens.
export function withParts(scenes: StoryScene[]): StoryScene[] {
  const out = scenes.map((s) => ({ ...s, part: undefined as StoryScene['part'] }))
  let i = 0
  while (i < out.length) {
    let j = i + 1
    while (j < out.length && out[j].source.start === out[i].source.start && out[j].source.end === out[i].source.end) j++
    if (j - i > 1) for (let k = i; k < j; k++) out[k].part = { index: k - i + 1, total: j - i }
    i = j
  }
  return out
}

export function uncoveredPassages(copy: string, scenes: Array<{ source: { start: number; end: number } }>): string[] {
  const covered = new Uint8Array(copy.length)
  for (const s of scenes) covered.fill(1, s.source.start, s.source.end)
  const gaps: string[] = []
  let start = -1
  for (let i = 0; i <= copy.length; i++) {
    if (i < copy.length && !covered[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      const text = copy.slice(start, i).trim()
      if (text.replace(/[\s\-—–.,;:!?"“”]/g, '').length > 12 && !/^(cena\s*\d+)\W*$/i.test(text)) gaps.push(text)
      start = -1
    }
  }
  return gaps
}
