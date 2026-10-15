import { CLOTHING, EMOTIONS, ENVIRONMENTS, HONORIFIC_PREFIX, NAME_STOPWORDS, OBJECTS, SPEECH_VERBS, TIME_SHIFTS } from './lexicon'
import { sentenceBoundaries, stripAccents } from './text'
import type { RawInterpretation, RawScene } from './types'

// Interpretador SIMULADO: regras locais e determinísticas, sem IA e sem
// custo. Serve para testar todo o fluxo do storyboard. Ele só usa o que está
// escrito na copy (palavras encontradas no trecho) — nunca inventa. Toda
// saída dele é marcada como simulada na interface.

export const SIMULATED_MODEL = 'interpretador-simulado-v1'

interface Unit {
  start: number
  end: number
  text: string
  kind: 'dialogue' | 'narration'
  speaker: string | null
  dialogue: string | null
}

const WORD = '[A-ZÀ-Ý][a-zà-ÿ]+'
const HONORIFIC_WORD = /^(Dona|Seu|Sr\.|Sra\.|Srta\.|Dr\.|Dra\.|Tia|Tio|Vó|Vô|Vovó|Vovô|Dom|Professora?)$/
const DIALOGUE_COLON = new RegExp(`^(${WORD}(?:\\s+${WORD}){0,2})\\s*:\\s*(.+)$`)
const DIALOGUE_DASH = /^\s*[—–-]\s*(.+)$|^\s*["“](.+)$/
const SPEAKER_AFTER = new RegExp(`(?:${SPEECH_VERBS})\\s+(?:a\\s+|o\\s+)?((?:Dona|Seu|Sr\\.|Sra\\.|Dr\\.|Dra\\.|Tia|Tio)?\\s*${WORD}(?:\\s+${WORD})?)`)

function wordRegex(word: string, flags = ''): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, `u${flags}`)
}

// "Seu João" e "Dona Maria" são nomes válidos de falante; "Mas eu" não.
function isSpeakerName(name: string): boolean {
  const words = name.split(/\s+/)
  if (words.length > 1 && HONORIFIC_WORD.test(words[0])) return !NAME_STOPWORDS.has(words[1])
  return !NAME_STOPWORDS.has(words[0])
}

// Mesmo texto, sem acentos e com o MESMO comprimento (posições batem com o
// original). Permite usar \b nas regras sem problema com letras acentuadas.
function fold(text: string): string {
  return text.replace(/[\u0080-\uffff]/g, (ch) => {
    const plain = stripAccents(ch)
    return plain.length === 1 ? plain : ch
  })
}

// Trecho literal do original que corresponde à regra (ou null).
function literal(re: RegExp, text: string): { index: number; text: string } | null {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(fold(text))
  return m ? { index: m.index, text: text.slice(m.index, m.index + m[0].length) } : null
}

// Ambiente onde a ação ACONTECE. "Vai para a escola" é destino, não lugar.
function detectEnvironment(text: string): string {
  for (const [re, label] of ENVIRONMENTS) {
    const hit = literal(re, text)
    if (!hit) continue
    const before = fold(text.slice(0, hit.index)).toLowerCase()
    if (/(?:\bpara|\bpra|\brumo a|\bate)\s+(?:[ao]s?\s+)?$/.test(before)) continue
    return label
  }
  return ''
}

// palavras que encerram a descrição de uma roupa ("avental azul e coloca…")
const WARDROBE_STOP = new Set(['e', 'que', 'para', 'pra', 'a', 'o', 'as', 'os', 'na', 'no', 'nas', 'nos', 'ao', 'mas', 'ou', 'se', 'enquanto', 'quando', 'porque'])
const GROUP_WORDS = /\b(a familia|os filhos|as filhas|os pais|todos|todas|as criancas|os amigos|as amigas|o casal|o grupo)\b/i

// Divide a copy em unidades: falas e frases de narração (posições exatas).
function segment(copy: string): Unit[] {
  const units: Unit[] = []
  const lineRe = /[^\n]+/g
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(copy))) {
    const raw = m[0]
    const lead = raw.length - raw.trimStart().length
    const line = raw.trim()
    const lineStart = m.index + lead
    if (!line || /^(cena\s*\d+|[-=*_]{3,})\W*$/i.test(line)) continue

    const colon = DIALOGUE_COLON.exec(line)
    if (colon && isSpeakerName(colon[1])) {
      units.push({ start: lineStart, end: lineStart + line.length, text: line, kind: 'dialogue', speaker: colon[1], dialogue: colon[2].trim() })
      continue
    }
    const dash = DIALOGUE_DASH.exec(line)
    if (dash) {
      const spoken = (dash[1] ?? dash[2] ?? '').trim()
      const who = SPEAKER_AFTER.exec(line)
      units.push({ start: lineStart, end: lineStart + line.length, text: line, kind: 'dialogue', speaker: who ? who[1].trim() : null, dialogue: spoken })
      continue
    }
    // narração: uma unidade por frase
    let cursor = 0
    for (const cut of [...sentenceBoundaries(line), line.length]) {
      const piece = line.slice(cursor, cut)
      const trimmed = piece.trim()
      if (trimmed) {
        const offset = lineStart + cursor + (piece.length - piece.trimStart().length)
        units.push({ start: offset, end: offset + trimmed.length, text: trimmed, kind: 'narration', speaker: null, dialogue: null })
      }
      cursor = cut
    }
  }
  return units
}

// Personagens: falantes, nomes com tratamento ("Dona Maria") e nomes
// próprios que aparecem mais de uma vez no meio das frases.
function detectCharacters(copy: string, units: Unit[], libraryNames: string[]): Array<{ name: string; mentions: string[] }> {
  const names = new Map<string, Set<string>>() // nome canônico → menções
  const add = (canonical: string, mention = canonical) => {
    const key = canonical.trim()
    if (!key || NAME_STOPWORDS.has(key)) return
    if (!names.has(key)) names.set(key, new Set([key]))
    names.get(key)!.add(mention.trim())
  }

  for (const m of copy.matchAll(HONORIFIC_PREFIX)) add(`${m[1]} ${m[2]}`)
  for (const u of units) if (u.speaker) add(u.speaker)
  for (const lib of libraryNames) if (wordRegex(lib).test(copy)) add(lib)

  // nomes próprios repetidos no meio das frases
  const counts = new Map<string, number>()
  for (const m of copy.matchAll(/(?<=[a-zà-ÿ,;]\s)([A-ZÀ-Ý][a-zà-ÿ]{2,})(?![\p{L}])/gu)) {
    if (!NAME_STOPWORDS.has(m[1])) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  for (const [word, count] of counts) if (count >= 2) add(word)

  // junta "Maria" em "Dona Maria" quando só um nome canônico contém a palavra
  const canonicals = [...names.keys()]
  for (const short of canonicals) {
    if (short.includes(' ')) continue
    const owners = canonicals.filter((c) => c !== short && c.split(/\s+/).includes(short))
    if (owners.length === 1) {
      for (const mention of names.get(short)!) names.get(owners[0])!.add(mention)
      names.delete(short)
    }
  }
  // menção curta (sem tratamento) também conta: "Maria" para "Dona Maria"
  for (const [canonical, mentions] of names) {
    const parts = canonical.split(/\s+/)
    if (parts.length > 1 && /^(Dona|Seu|Sr\.|Sra\.|Srta\.|Dr\.|Dra\.|Tia|Tio|Vó|Vô|Vovó|Vovô|Dom|Professora?)$/.test(parts[0])) {
      const bare = parts.slice(1).join(' ')
      const shared = [...names.keys()].some((other) => other !== canonical && other.split(/\s+/).includes(bare))
      if (!shared && wordRegex(bare).test(copy)) mentions.add(bare)
    }
  }
  return [...names].map(([name, mentions]) => ({ name, mentions: [...mentions].sort((a, b) => b.length - a.length) }))
}

export function simulateInterpretation(copy: string, libraryNames: string[] = []): RawInterpretation {
  const units = segment(copy)
  const characters = detectCharacters(copy, units, libraryNames)
  const scenes: RawScene[] = []

  let lastEnv = ''
  let lastEnvScene = 0
  let lastChars: string[] = []
  const wardrobe = new Map<string, { text: string; scene: number }>()

  for (const u of units) {
    const sceneNo = scenes.length + 1
    const ambiguities: string[] = []

    // personagens presentes: mencionados no trecho (+ quem fala)
    // numa fala, quem é só CITADO na fala não está necessariamente na cena
    const scope = u.kind === 'dialogue' && u.speaker ? u.text.slice(0, u.text.length - (u.dialogue ?? '').length) : u.text
    let present = characters.filter((c) => c.mentions.some((m) => wordRegex(m).test(scope))).map((c) => c.name)
    if (u.kind === 'dialogue' && u.dialogue) {
      const cited = characters.filter((c) => !present.includes(c.name) && c.mentions.some((m) => wordRegex(m).test(u.dialogue!)))
      if (cited.length) ambiguities.push(`Citado na fala: ${cited.map((c) => c.name).join(', ')} — confirme se aparece na imagem.`)
    }
    if (u.speaker) {
      const speaker = characters.find((c) => c.name === u.speaker || c.mentions.includes(u.speaker!))?.name ?? u.speaker
      if (!present.includes(speaker)) present.unshift(speaker)
    }
    if (present.length === 0 && /\b(ela|ele|elas|eles)\b/i.test(u.text) && lastChars.length) {
      present = [...lastChars]
      ambiguities.push('Personagem inferido pelo pronome (ela/ele) — confirme quem aparece.')
    }
    const group = literal(GROUP_WORDS, u.text)
    if (group) ambiguities.push(`Grupo citado ("${group.text}") — confirme quais personagens aparecem.`)
    else if (present.length === 0 && u.kind === 'narration') ambiguities.push('Nenhum personagem identificado no trecho — confirme quem aparece.')
    if (u.kind === 'dialogue' && !u.speaker) ambiguities.push('Fala sem indicação de quem fala — confirme o personagem.')
    const speakerName = u.speaker ? (characters.find((c) => c.name === u.speaker || c.mentions.includes(u.speaker!))?.name ?? u.speaker) : null

    // ambiente (com continuidade)
    const env = detectEnvironment(u.text)
    const continuity: string[] = []
    const timeShift = TIME_SHIFTS.map((re) => literal(re, u.text)?.text).find(Boolean) ?? ''
    let environment = ''
    if (env) {
      environment = env
      if (env !== lastEnv) {
        lastEnv = env
        lastEnvScene = sceneNo
      }
    } else if (lastEnv) {
      environment = lastEnv
      continuity.push(`Mesmo ambiente da cena ${lastEnvScene} (${lastEnv}).`)
    } else if (scenes.length === 0) {
      ambiguities.push('Ambiente não informado na copy — defina na revisão (sem inventar acontecimentos).')
    }
    if (timeShift) continuity.push(`Passagem de tempo: "${timeShift}".`)

    // roupas (mudança no trecho, ou continuidade da última roupa citada)
    const clothing = literal(CLOTHING, u.text)
    if (clothing && present[0]) {
      const words = clothing.text.split(/\s+/)
      const kept = [words[0]]
      for (const w of words.slice(1)) {
        if (WARDROBE_STOP.has(fold(w).toLowerCase().replace(/[.,;:!?]$/, ''))) break
        kept.push(w)
        if (/[.,;:!?]$/.test(w)) break
      }
      wardrobe.set(present[0], { text: kept.join(' ').replace(/[.,;:!?]$/, ''), scene: sceneNo })
    }
    const wardrobeText = present
      .filter((p) => wardrobe.has(p))
      .map((p) => {
        const w = wardrobe.get(p)!
        return w.scene === sceneNo ? `${p}: ${w.text}` : `${p}: ${w.text} (desde a cena ${w.scene})`
      })
      .join('; ')
    if (wardrobeText && !clothing) continuity.push('Manter as roupas já mostradas.')

    const lower = stripAccents(u.text.toLowerCase())
    const objects = OBJECTS.filter((o) => wordRegex(stripAccents(o.toLowerCase())).test(lower))
    // emoções: a palavra como está na copy ("preocupado"), não um rótulo
    const emotions = [...new Set(EMOTIONS.map(([re]) => literal(re, u.text)?.text.toLowerCase()).filter(Boolean))].join(', ')

    // enquadramento e câmera por regra
    let framing = 'Plano médio'
    let camera = 'Altura dos olhos, frontal'
    if (u.kind === 'dialogue') {
      framing = 'Plano médio fechado (medium close-up) em quem fala'
      camera = 'Altura dos olhos, levemente de lado'
    } else if (scenes.length === 0 || timeShift || (env && sceneNo === lastEnvScene)) {
      framing = 'Plano aberto de ambientação'
      camera = 'Frontal, um pouco acima dos olhos'
    } else if (present.length === 0 && objects.length) {
      framing = 'Plano detalhe do objeto'
      camera = 'Próxima, de cima para baixo'
    } else if (emotions) {
      framing = 'Close no rosto'
      camera = 'Altura dos olhos'
    }

    const action = u.kind === 'dialogue' ? `${speakerName ?? 'Personagem não identificado'} fala: "${u.dialogue}"` : u.text
    const who = present.length ? present.join(' e ') : 'Cena sem personagem identificado'
    const visualDescription = `${who}${environment ? ` — ${environment}` : ''}${objects.length ? `; em destaque: ${objects.join(', ')}` : ''}.`
    const motion =
      u.kind === 'dialogue'
        ? `${speakerName ?? 'O personagem'} fala com movimento natural de lábios e gestos; câmera quase parada.`
        : 'Animar apenas a ação descrita no trecho, com movimento de câmera suave; não acrescentar acontecimentos.'

    if (u.text.length > 260) ambiguities.push('Trecho longo: talvez precise de mais de uma imagem.')

    const base: RawScene = {
      quote: u.text,
      characters: present,
      speaker: speakerName,
      dialogue: u.dialogue,
      environment,
      action,
      emotions,
      wardrobe: wardrobeText,
      objects,
      timeShift,
      continuity: continuity.join(' '),
      framing,
      camera,
      visualDescription,
      motion,
      ambiguities,
    }

    // "X e depois Y" na narração: duas imagens para o mesmo trecho
    const split = u.kind === 'narration' ? /,?\s+(?:e\s+)?(?:depois|então|em seguida)\s+/i.exec(u.text) : null
    if (split && split.index > 10 && split.index < u.text.length - 10) {
      const first = u.text.slice(0, split.index).trim()
      const second = u.text.slice(split.index + split[0].length).trim()
      scenes.push({ ...base, action: first, motion: `Animar apenas: ${first}.` })
      scenes.push({ ...base, action: second, motion: `Animar apenas: ${second}.`, framing: 'Plano médio', continuity: [base.continuity, 'Continuação imediata da imagem anterior (mesmo trecho da copy).'].filter(Boolean).join(' ') })
    } else {
      scenes.push(base)
    }
    if (present.length) lastChars = present
  }

  return { characters, scenes }
}
