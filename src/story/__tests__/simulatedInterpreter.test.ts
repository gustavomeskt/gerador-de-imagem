import { describe, expect, it } from 'vitest'
import { buildFromRaw } from '../interpretation'
import { simulateInterpretation } from '../simulatedInterpreter'
import { normalizeForSearch } from '../text'
import type { RawInterpretation } from '../types'
import { longStory, STORY_FOUR } from './fixtures'

let n = 0
const makeId = (p: string) => `${p}-${++n}`

function build(copy: string, library: Array<{ id: string; name: string }> = []) {
  const raw = simulateInterpretation(copy, library.map((l) => l.name))
  return { raw, built: buildFromRaw(raw, copy, library, makeId) }
}

// nenhuma cena pode trazer objeto, ambiente ou fala que não esteja na copy
function expectNothingInvented(raw: RawInterpretation, copy: string) {
  const text = normalizeForSearch(copy)
  for (const s of raw.scenes) {
    expect(copy).toContain(s.quote)
    for (const o of s.objects) expect(text).toContain(normalizeForSearch(o))
    if (s.environment) expect(text).toContain(normalizeForSearch(s.environment))
    if (s.dialogue) expect(s.quote).toContain(s.dialogue)
    if (s.timeShift) expect(s.quote).toContain(s.timeShift)
    for (const e of s.emotions.split(', ').filter(Boolean)) expect(normalizeForSearch(s.quote)).toContain(normalizeForSearch(e))
  }
}

describe('interpretação simulada', () => {
  it('historinha com 4 personagens gera mais de 15 cenas, na ordem, com trechos literais', () => {
    const { raw, built } = build(STORY_FOUR)
    expect(built.scenes.length).toBeGreaterThanOrEqual(16)
    expect(raw.characters.map((c) => c.name)).toEqual(['Dona Maria', 'Seu João', 'Ana', 'Beto'])
    // ordem cronológica = ordem do texto
    const starts = built.scenes.map((s) => s.source.start)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    for (const s of built.scenes) expect(STORY_FOUR.slice(s.source.start, s.source.end)).toBe(s.excerpt)
    expect(built.warnings.filter((w) => w.startsWith('Trecho da copy sem cena'))).toEqual([])
    expectNothingInvented(raw, STORY_FOUR)
  })

  it('diálogo entre vários personagens: cada fala com o falante certo e a fala literal', () => {
    const { built } = build(STORY_FOUR)
    const name = (key: string | null) => built.characters.find((c) => c.key === key)?.name
    const dialogues = built.scenes.filter((s) => s.speakerKey)
    expect(dialogues.map((s) => name(s.speakerKey))).toEqual(['Seu João', 'Dona Maria', 'Ana', 'Beto', 'Beto'])
    const joao = dialogues[0]
    expect(joao.dialogue).toBe('Bom dia, Maria! O cheiro está ótimo.')
    // Maria é só citada na fala: não entra sozinha na cena, vira alerta
    expect(joao.characterKeys.map(name)).toEqual(['Seu João'])
    expect(joao.flags.join(' ')).toMatch(/Citado na fala: Dona Maria/)
  })

  it('mudanças de ambiente e passagem de tempo vêm do texto; destino não vira cenário', () => {
    const { built } = build(STORY_FOUR)
    const envs = built.scenes.map((s) => s.environment)
    expect(envs[0]).toBe('cozinha')
    // "atrasada para a escola" é destino — continua na cozinha
    const ana = built.scenes.find((s) => s.excerpt.startsWith('Ana desce'))!
    expect(ana.environment).toBe('cozinha')
    const quintal = built.scenes.find((s) => s.excerpt.startsWith('Mais tarde'))!
    expect(quintal.environment).toBe('quintal')
    expect(quintal.timeShift).toBe('Mais tarde')
    const noite = built.scenes.find((s) => s.excerpt.startsWith('À noite'))!
    expect(noite.timeShift).toBe('À noite')
    expect(noite.environment).toBe('sala')
    // sem ambiente no trecho → continuidade do anterior, registrada
    const semAmbiente = built.scenes.find((s) => s.excerpt.startsWith('Ela veste'))!
    expect(semAmbiente.continuity).toMatch(/Mesmo ambiente da cena 1 \(cozinha\)/)
  })

  it('continuidade de figurino e objetos', () => {
    const { built } = build(STORY_FOUR)
    const veste = built.scenes.find((s) => s.excerpt.startsWith('Ela veste'))!
    expect(veste.wardrobe).toBe('Dona Maria: avental azul')
    expect(veste.objects).toEqual(['xícara', 'mesa'])
    // cenas seguintes com Dona Maria mantêm o avental
    const abraco = built.scenes[built.scenes.length - 1]
    expect(abraco.wardrobe).toBe('Dona Maria: avental azul (desde a cena 2)')
    expect(abraco.continuity).toMatch(/Manter as roupas/)
    const celular = built.scenes.filter((s) => s.objects.includes('celular'))
    expect(celular.length).toBe(3)
  })

  it('uma passagem com "e depois" vira duas imagens do mesmo trecho', () => {
    const { built } = build(STORY_FOUR)
    const parts = built.scenes.filter((s) => s.excerpt.startsWith('Dona Maria aponta'))
    expect(parts).toHaveLength(2)
    expect(parts.map((p) => p.part)).toEqual([
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ])
    expect(parts[0].action).toBe('Dona Maria aponta para a cadeira')
    expect(parts[1].action).toBe('entrega um pão para Ana.')
    expect(parts[0].source).toEqual(parts[1].source)
  })

  it('pronomes e grupos não são adivinhados: viram alerta para revisão', () => {
    const { built } = build(STORY_FOUR)
    const veste = built.scenes.find((s) => s.excerpt.startsWith('Ela veste'))!
    expect(veste.flags.join(' ')).toMatch(/pronome/)
    const familia = built.scenes.find((s) => s.excerpt.startsWith('À noite'))!
    expect(familia.characterKeys).toEqual([])
    expect(familia.flags.join(' ')).toMatch(/Grupo citado \("a família"\)/)
  })

  it.each([30, 60])('historinha longa (%i momentos) sem limite artificial de cenas', (count) => {
    const copy = longStory(count)
    const { raw, built } = build(copy)
    expect(built.scenes).toHaveLength(count)
    expect(built.scenes.map((s) => s.excerpt)).toEqual(copy.split('\n'))
    expectNothingInvented(raw, copy)
  })

  it('usa os nomes da biblioteca e marca quem não está cadastrado', () => {
    const { built } = build(STORY_FOUR, [
      { id: 'lib-maria', name: 'Maria' },
      { id: 'lib-joao', name: 'João' },
    ])
    const status = Object.fromEntries(built.characters.map((c) => [c.name, [c.matchStatus, c.libraryId]]))
    expect(status).toEqual({
      'Dona Maria': ['auto', 'lib-maria'],
      'Seu João': ['auto', 'lib-joao'],
      Ana: ['unregistered', null],
      Beto: ['unregistered', null],
    })
  })
})
