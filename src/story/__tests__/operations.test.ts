import { describe, expect, it } from 'vitest'
import { emptySheet, type Character } from '../../generation/characters'
import { defaultStyleGuide } from '../../generation/styleGuide'
import { buildFromRaw } from '../interpretation'
import {
  applyInterpretation,
  approveAll,
  emptyStoryboard,
  mergeWithNext,
  moveScene,
  resolveCharacter,
  restoreSnapshot,
  saveCopy,
  setSceneStatus,
  splitScene,
  updateScene,
} from '../operations'
import { buildScenePrompt } from '../scenePrompt'
import { simulateInterpretation, SIMULATED_MODEL } from '../simulatedInterpreter'
import { hashText } from '../text'
import type { Storyboard } from '../types'
import { STORY_FOUR } from './fixtures'

let n = 0
const makeId = (p: string) => `${p}-${++n}`
const META = { mode: 'simulated' as const, model: SIMULATED_MODEL }

function interpreted(copy = STORY_FOUR, library: Array<{ id: string; name: string }> = []): Storyboard {
  const board = saveCopy(emptyStoryboard('p1'), copy)
  const built = buildFromRaw(simulateInterpretation(copy, library.map((l) => l.name)), copy, library, makeId)
  return applyInterpretation(board, built, META).board
}

function character(id: string, name: string, photos = 2, extra: Partial<Character> = {}): Character {
  return {
    ...emptySheet(),
    name,
    apparentAge: '60 anos',
    hair: 'cabelo grisalho curto',
    id,
    photos: Array.from({ length: photos }, (_, i) => ({
      id: `${id}-f${i}`,
      assetId: `${id}-a${i}`,
      name: `${name}-${i}.png`,
      mimeType: 'image/png' as const,
      byteLength: 10,
      width: 400,
      height: 600,
      sha256: `${id}${i}`.padEnd(64, '0'),
    })),
    primaryPhotoId: `${id}-f0`,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

describe('operações do storyboard', () => {
  it('a copy original nunca é alterada por nenhuma operação', () => {
    const hash = hashText(STORY_FOUR)
    let b = interpreted()
    const id = b.scenes[3].id
    b = updateScene(b, id, { action: 'outra ação' })
    b = splitScene(b, b.scenes[0].id, makeId)
    b = mergeWithNext(b, b.scenes[5].id)
    b = moveScene(b, b.scenes[2].id, 7)
    b = approveAll(b)
    expect(hashText(b.copy)).toBe(hash)
    expect(b.copy).toBe(STORY_FOUR)
    for (const s of b.scenes) expect(b.copy.slice(s.source.start, s.source.end)).toBe(s.excerpt)
  })

  it('editar uma cena a deixa "revisada"; aprovar é individual; editar uma aprovada exige nova aprovação', () => {
    let b = interpreted()
    const [a, second] = b.scenes
    b = updateScene(b, a.id, { action: 'Dona Maria prepara o café, sorrindo' })
    expect(b.scenes[0].status).toBe('reviewed')
    expect(b.scenes[1].status).toBe('pending')
    b = setSceneStatus(b, a.id, 'approved')
    expect(b.scenes[0].status).toBe('approved')
    expect(b.scenes[1].status).toBe(second.status)
    b = updateScene(b, a.id, { framing: 'Close' })
    expect(b.scenes[0].status).toBe('reviewed')
    expect(b.history.map((h) => h.action)).toEqual(
      expect.arrayContaining(['Cena 1 editada.', 'Cena 1 aprovada.']),
    )
  })

  it('aprovar o storyboard completo registra a data; qualquer mudança depois desfaz a aprovação geral', () => {
    let b = approveAll(interpreted(), 1000)
    expect(b.approvedAt).toBe(1000)
    expect(b.scenes.every((s) => s.status === 'approved')).toBe(true)
    b = moveScene(b, b.scenes[0].id, 1)
    expect(b.approvedAt).toBeNull()
  })

  it('dividir: no limite de frase quando há mais de uma; senão, duas imagens do mesmo trecho', () => {
    const copy = 'Dona Maria entra na cozinha. Ela abre a geladeira e pega o bolo.\nSeu João sorri.'
    let b = interpreted(copy)
    // junta as duas frases e divide de novo
    b = mergeWithNext(b, b.scenes[0].id)
    expect(b.scenes[0].excerpt).toBe('Dona Maria entra na cozinha. Ela abre a geladeira e pega o bolo.')
    b = splitScene(b, b.scenes[0].id, makeId)
    expect(b.scenes.slice(0, 2).map((s) => s.excerpt)).toEqual(['Dona Maria entra na cozinha.', 'Ela abre a geladeira e pega o bolo.'])
    const last = b.scenes[b.scenes.length - 1]
    b = splitScene(b, last.id, makeId)
    const two = b.scenes.slice(-2)
    expect(two.map((s) => s.excerpt)).toEqual(['Seu João sorri.', 'Seu João sorri.'])
    expect(two.map((s) => s.part)).toEqual([
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ])
  })

  it('reinterpretar mantém as cenas aprovadas e guarda a versão anterior', () => {
    let b = interpreted()
    const approved = b.scenes[2]
    b = updateScene(b, approved.id, { action: 'Ajuste aprovado pela pessoa' })
    b = setSceneStatus(b, approved.id, 'approved')
    b = updateScene(b, b.scenes[4].id, { emotions: 'revisada mas não aprovada' })

    const built = buildFromRaw(simulateInterpretation(STORY_FOUR), STORY_FOUR, [], makeId)
    const { board, summary } = applyInterpretation(b, built, META)
    const kept = board.scenes.find((s) => s.id === approved.id)!
    expect(kept.action).toBe('Ajuste aprovado pela pessoa')
    expect(kept.status).toBe('approved')
    // nenhuma cena nova cobre o mesmo trecho da aprovada
    expect(board.scenes.filter((s) => s.source.start === approved.source.start)).toHaveLength(1)
    expect(summary).toMatchObject({ keptApproved: 1, replacedReviewed: 1 })
    expect(board.snapshots.at(-1)!.reason).toBe('antes de reinterpretar')

    // a revisão substituída pode ser recuperada
    const restored = restoreSnapshot(board, board.snapshots.length - 1)
    expect(restored.scenes.find((s) => s.emotions === 'revisada mas não aprovada')).toBeTruthy()
  })

  it('reinterpretar preserva a associação confirmada com a biblioteca', () => {
    let b = interpreted(STORY_FOUR, [])
    const ana = b.characters.find((c) => c.name === 'Ana')!
    b = resolveCharacter(b, ana.key, 'lib-ana')
    const built = buildFromRaw(simulateInterpretation(STORY_FOUR), STORY_FOUR, [], makeId)
    const next = applyInterpretation(b, built, META).board
    const after = next.characters.find((c) => c.name === 'Ana')!
    expect(after).toMatchObject({ key: ana.key, libraryId: 'lib-ana', matchStatus: 'confirmed' })
    expect(next.scenes.some((s) => s.characterKeys.includes(ana.key))).toBe(true)
  })

  it('salvar uma copy editada reencontra as cenas; as que sumiram ficam sinalizadas (nada é apagado)', () => {
    const b = interpreted()
    const edited = STORY_FOUR.replace('Seu João sorri e mostra o celular novo que comprou.', 'Seu João mostra o tablet.')
    const next = saveCopy(b, edited)
    expect(next.copy).toBe(edited)
    expect(next.scenes).toHaveLength(b.scenes.length)
    const lost = next.scenes.filter((s) => s.flags.some((f) => /não existe mais na copy/.test(f)))
    expect(lost).toHaveLength(1)
    for (const s of next.scenes.filter((x) => !lost.includes(x))) expect(edited.slice(s.source.start, s.source.end)).toBe(s.excerpt)
    expect(next.snapshots).toHaveLength(1)
  })
})

describe('prompt automático da cena', () => {
  const maria = character('lib-maria', 'Maria', 3)
  const joao = character('lib-joao', 'João', 2, { apparentAge: '65 anos' })

  it('usa ficha + fotos dos personagens, ação da cena, 9:16 e nada de texto na imagem', () => {
    const b = interpreted(STORY_FOUR, [maria, joao])
    const scene = b.scenes.find((s) => s.excerpt === 'Dona Maria abraça Seu João no sofá.')!
    const r = buildScenePrompt(scene, b, [maria, joao])
    expect(r.cast.map((c) => [c.name, c.photosSent])).toEqual([
      ['Maria', 3],
      ['João', 2],
    ])
    expect(r.photoCount).toBe(5)
    expect(r.prompt).toMatch(/Reference images are attached/)
    expect(r.prompt).toContain('60 anos')
    expect(r.prompt).toContain('65 anos')
    expect(r.prompt).toContain('Action: Dona Maria abraça Seu João no sofá.')
    expect(r.prompt).toMatch(/vertical 9:16/)
    expect(r.prompt).toMatch(/do NOT write it in the image/)
    expect(r.prompt).toMatch(/Do not add any text, captions, logos or watermarks/)
    expect(r.styleSource).toBe('default')
  })

  it('guia do projeto em outra proporção: o storyboard continua 9:16 e sem texto', () => {
    const b = interpreted(STORY_FOUR, [maria])
    const style = { ...defaultStyleGuide(), aspect: '16:9' as const, noText: false, visualStyle: 'Estilo do projeto X' }
    const r = buildScenePrompt(b.scenes[0], b, [maria], style)
    expect(r.styleSource).toBe('project')
    expect(r.prompt).toContain('Estilo do projeto X')
    expect(r.prompt).toMatch(/vertical 9:16/)
    expect(r.prompt).toMatch(/Do not add any text, captions, logos or watermarks/)
  })

  it('personagem sem cadastro vai sem foto, com aviso; prompt editado manualmente prevalece', () => {
    const b = interpreted(STORY_FOUR, [maria])
    const scene = b.scenes.find((s) => s.excerpt.startsWith('Mais tarde'))!
    const r = buildScenePrompt(scene, b, [maria])
    expect(r.unregistered).toEqual(['Ana', 'Beto'])
    expect(r.warnings.join(' ')).toMatch(/Sem cadastro na biblioteca/)
    expect(r.prompt).toMatch(/no reference photo available/)
    const edited = updateScene(b, scene.id, { promptOverride: 'Prompt manual.' })
    expect(buildScenePrompt(edited.scenes.find((s) => s.id === scene.id)!, edited, [maria]).prompt).toBe('Prompt manual.')
  })
})
