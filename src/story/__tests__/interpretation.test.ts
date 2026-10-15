import { describe, expect, it } from 'vitest'
import { matchCharacter } from '../characterMatching'
import { buildFromRaw, InterpretationError, parseRawInterpretation } from '../interpretation'
import { locateQuote, splitIntoChunks } from '../text'
import type { RawScene } from '../types'
import { STORY_FOUR } from './fixtures'

let n = 0
const makeId = (p: string) => `${p}-${++n}`

function scene(quote: string, extra: Partial<RawScene> = {}): RawScene {
  return {
    quote,
    characters: [],
    speaker: null,
    dialogue: null,
    environment: '',
    action: '',
    emotions: '',
    wardrobe: '',
    objects: [],
    timeShift: '',
    continuity: '',
    framing: '',
    camera: '',
    visualDescription: '',
    motion: '',
    ambiguities: [],
    ...extra,
  }
}

const COPY = 'Dona Maria entra na farmácia.\nDona Maria: Bom dia!\nO farmacêutico sorri.'

describe('validação da saída do modelo (resposta simulada de um LLM)', () => {
  it('recusa formatos inválidos', () => {
    expect(() => parseRawInterpretation(null)).toThrow(InterpretationError)
    expect(() => parseRawInterpretation({ characters: [] })).toThrow(/lista de cenas/)
    expect(() => parseRawInterpretation({ characters: [], scenes: [] })).toThrow(/nenhuma cena/)
    expect(() => parseRawInterpretation({ scenes: Array.from({ length: 501 }, () => ({ quote: 'x' })) })).toThrow(/Cenas demais/)
  })

  it('descarta cena cujo trecho não existe na copy (acontecimento inventado)', () => {
    const raw = parseRawInterpretation({
      characters: [{ name: 'Dona Maria', mentions: ['Dona Maria'] }],
      scenes: [
        scene('Dona Maria entra na farmácia.', { characters: ['Dona Maria'] }),
        scene('Dona Maria compra um remédio e vai embora feliz.', { characters: ['Dona Maria'] }),
        scene('O farmacêutico sorri.'),
      ],
    })
    const built = buildFromRaw(raw, COPY, [], makeId)
    expect(built.scenes.map((s) => s.excerpt)).toEqual(['Dona Maria entra na farmácia.', 'O farmacêutico sorri.'])
    expect(built.warnings.join(' ')).toMatch(/Cena 2 descartada: o trecho citado não existe na copy/)
    expect(built.warnings.join(' ')).toMatch(/Trecho da copy sem cena: "Dona Maria: Bom dia!"/)
  })

  it('se nenhuma cena cita a copy, a interpretação inteira é recusada', () => {
    const raw = parseRawInterpretation({ characters: [], scenes: [scene('Texto que não está na copy.')] })
    expect(() => buildFromRaw(raw, COPY, [], makeId)).toThrow(/Nenhuma cena válida/)
  })

  it('objeto ou ambiente fora da copy vira só detalhe visual, com alerta', () => {
    const raw = parseRawInterpretation({
      characters: [],
      scenes: [scene('O farmacêutico sorri.', { objects: ['balcão de vidro'], environment: 'hospital' })],
    })
    const s = buildFromRaw(raw, COPY, [], makeId).scenes[0]
    expect(s.objects).toEqual([])
    expect(s.visualDescription).toMatch(/detalhes visuais de composição: balcão de vidro/)
    expect(s.flags.join(' ')).toMatch(/"balcão de vidro" não aparece na copy/)
    expect(s.flags.join(' ')).toMatch(/Ambiente "hospital" não aparece na copy/)
  })

  it('fala que não está no trecho é removida; falante desconhecido é sinalizado', () => {
    const raw = parseRawInterpretation({
      characters: [{ name: 'Dona Maria', mentions: [] }],
      scenes: [
        scene('Dona Maria: Bom dia!', { characters: ['Dona Maria'], speaker: 'Dona Maria', dialogue: 'Boa tarde, querido!' }),
        scene('O farmacêutico sorri.', { speaker: 'Zé' }),
      ],
    })
    const [a, b] = buildFromRaw(raw, COPY, [], makeId).scenes
    expect(a.dialogue).toBe('')
    expect(a.flags.join(' ')).toMatch(/fala indicada não está no trecho/)
    expect(b.flags.join(' ')).toMatch(/Quem fala \("Zé"\) não foi identificado/)
  })

  it('personagem que não aparece na copy é ignorado; nome desconhecido não entra na cena', () => {
    const raw = parseRawInterpretation({
      characters: [
        { name: 'Dona Maria', mentions: ['Maria'] },
        { name: 'Carlos', mentions: [] },
      ],
      scenes: [scene('O farmacêutico sorri.', { characters: ['Carlos'] })],
    })
    const built = buildFromRaw(raw, COPY, [], makeId)
    expect(built.characters.map((c) => c.name)).toEqual(['Dona Maria'])
    expect(built.warnings.join(' ')).toMatch(/"Carlos" não aparece na copy/)
    expect(built.scenes[0].characterKeys).toEqual([])
    expect(built.scenes[0].flags.join(' ')).toMatch(/"Carlos" não está na lista/)
  })

  it('cena fora de ordem é sinalizada; mesmo trecho repetido = imagens da mesma passagem', () => {
    const raw = parseRawInterpretation({
      characters: [],
      scenes: [scene('O farmacêutico sorri.'), scene('O farmacêutico sorri.'), scene('Dona Maria entra na farmácia.')],
    })
    const built = buildFromRaw(raw, COPY, [], makeId)
    expect(built.scenes[0].part).toEqual({ index: 1, total: 2 })
    expect(built.scenes[1].part).toEqual({ index: 2, total: 2 })
    expect(built.scenes[2].flags.join(' ')).toMatch(/fora da ordem cronológica/)
  })

  it('aceita trecho com aspas/espaços diferentes e aponta para o texto ORIGINAL', () => {
    const copy = 'Ela disse: “Vamos  embora” — e saiu.'
    const span = locateQuote(copy, 'Ela disse: "Vamos embora" - e saiu.')!
    expect(copy.slice(span.start, span.end)).toBe(copy)
  })

  it('divide copys grandes por parágrafo sem perder nem alterar texto', () => {
    const copy = Array.from({ length: 40 }, (_, i) => `Parágrafo ${i + 1}: Dona Maria faz a tarefa ${i + 1}.`).join('\n\n')
    const chunks = splitIntoChunks(copy, 300)
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(copy.slice(c.start, c.start + c.text.length)).toBe(c.text)
    expect(chunks.map((c) => c.text).join('')).toBe(copy)
  })
})

describe('associação com a biblioteca', () => {
  const library = [
    { id: 'm1', name: 'Maria' },
    { id: 'j1', name: 'João Pedro' },
    { id: 'a1', name: 'Ana' },
    { id: 'a2', name: 'Ána' }, // duplicado (mesmo nome sem acento)
  ]

  it('mesmo nome (sem acento/tratamento) → associação automática', () => {
    expect(matchCharacter('Dona Maria', library)).toEqual({ libraryId: 'm1', matchStatus: 'auto', candidates: [] })
    expect(matchCharacter('maria', library).matchStatus).toBe('auto')
  })

  it('nomes parecidos nunca são associados', () => {
    expect(matchCharacter('Mariana', library)).toEqual({ libraryId: null, matchStatus: 'unregistered', candidates: [] })
    expect(matchCharacter('Mario', library).matchStatus).toBe('unregistered')
    expect(matchCharacter('Beto', library).matchStatus).toBe('unregistered')
  })

  it('só o primeiro nome, ou nome repetido na biblioteca → ambíguo, pede confirmação', () => {
    expect(matchCharacter('Seu João', library)).toEqual({ libraryId: null, matchStatus: 'ambiguous', candidates: ['j1'] })
    expect(matchCharacter('Ana', library)).toEqual({ libraryId: null, matchStatus: 'ambiguous', candidates: ['a1', 'a2'] })
  })

  it('na interpretação, cada personagem recebe id estável e o status certo', () => {
    const raw = parseRawInterpretation({
      characters: [
        { name: 'Dona Maria', mentions: ['Maria'] },
        { name: 'Seu João', mentions: ['João'] },
        { name: 'Beto', mentions: [] },
      ],
      scenes: [scene(STORY_FOUR.split('\n')[0], { characters: ['Dona Maria'] })],
    })
    const built = buildFromRaw(raw, STORY_FOUR, library, makeId)
    expect(built.characters.map((c) => [c.name, c.matchStatus, c.libraryId])).toEqual([
      ['Dona Maria', 'auto', 'm1'],
      ['Seu João', 'ambiguous', null],
      ['Beto', 'unregistered', null],
    ])
    expect(new Set(built.characters.map((c) => c.key)).size).toBe(3)
  })
})
