import { describe, expect, it } from 'vitest'
import { emptySheet, normalizeSheet, orderedPhotos, type CharacterSheet } from '../characters'
import { composePrompt } from '../promptComposer'
import { aspectMatches, defaultStyleGuide, legacyStyleGuide, normalizeStyleGuide, sizeForAspect } from '../styleGuide'

const maria: CharacterSheet = {
  ...emptySheet(),
  name: 'Dona Maria',
  apparentAge: 'cerca de 60 anos',
  physicalDescription: 'baixa, corpo cheio, pele morena clara',
  faceFeatures: 'rosto redondo, olhos castanhos, covinha no queixo',
  hair: 'grisalho, curto, ondulado',
  distinctiveMarks: 'óculos de armação vermelha',
  defaultOutfit: 'blusa florida azul e avental branco',
  preservationNotes: 'sempre com os óculos vermelhos',
}
const joao: CharacterSheet = { ...emptySheet(), name: 'Seu João', apparentAge: '65 anos', hair: 'careca' }

describe('composePrompt — fichas permanentes', () => {
  it('cada campo da ficha entra no texto, junto da regra de identidade', () => {
    const prompt = composePrompt({ scene: 'Dona Maria abre a geladeira', cast: [{ sheet: maria, imageCount: 2 }] })
    expect(prompt).toContain('Images 1-2: "Dona Maria" — the same real person in every photo')
    expect(prompt).toContain('same face and facial features, same apparent age')
    expect(prompt).toContain('apparent age: cerca de 60 anos')
    expect(prompt).toContain('face: rosto redondo, olhos castanhos, covinha no queixo')
    expect(prompt).toContain('hair: grisalho, curto, ondulado')
    expect(prompt).toContain('distinctive features: óculos de armação vermelha')
    expect(prompt).toContain('default outfit: blusa florida azul e avental branco (keep it unless the scene requires a change)')
    expect(prompt).toContain('must never change: sempre com os óculos vermelhos')
    expect(prompt).toContain('Pose, facial expression and framing may change to fit the scene; identity may not.')
    expect(prompt.endsWith('Scene: Dona Maria abre a geladeira')).toBe(true)
  })

  it('ajuste da cena entra separado e não substitui a ficha', () => {
    const prompt = composePrompt({
      scene: 'cena',
      cast: [{ sheet: maria, imageCount: 1, sceneNote: 'nesta cena está de pijama, rindo' }],
    })
    expect(prompt).toContain('In this scene only: nesta cena está de pijama, rindo')
    expect(prompt).toContain('default outfit: blusa florida azul') // ficha continua lá
  })

  it('várias pessoas: numeração contínua e regra de separação', () => {
    const prompt = composePrompt({
      scene: 'os dois conversam na sala',
      cast: [
        { sheet: maria, imageCount: 2 },
        { sheet: joao, imageCount: 1 },
      ],
      references: [{ label: 'Pote', role: 'object', preserveClothing: false, imageCount: 1 }],
    })
    expect(prompt).toContain('Images 1-2: "Dona Maria"')
    expect(prompt).toContain('Image 3: "Seu João"')
    expect(prompt).toContain('Image 4: "Pote" — object')
    expect(prompt).toContain('never mix or swap features between different people')
    expect(prompt).toContain('Show each person once, as a distinct individual')
  })

  it('campos vazios da ficha não geram linhas soltas', () => {
    const prompt = composePrompt({ scene: 'x', cast: [{ sheet: joao, imageCount: 1 }] })
    expect(prompt).toContain('apparent age: 65 anos; hair: careca.')
    expect(prompt).not.toContain('default outfit')
    expect(prompt).not.toContain('Show each person once')
  })
})

describe('composePrompt — guia de estilo', () => {
  it('padrão: fotorrealista, 9:16, sem textos, sem inventar acontecimentos', () => {
    const prompt = composePrompt({ scene: 'uma cozinha', style: defaultStyleGuide() })
    expect(prompt).toContain('Project style guide:')
    expect(prompt).toContain('Photorealistic, natural photograph')
    expect(prompt).toContain('vertical 9:16 frame')
    expect(prompt).toContain('Do not add any text, captions, logos or watermarks')
    expect(prompt).toContain('Depict only what the scene describes; do not invent events, people or objects')
    expect(prompt.endsWith('Scene: uma cozinha')).toBe(true)
  })

  it('campos do guia (iluminação, ambientes, continuidade) entram no texto', () => {
    const style = { ...defaultStyleGuide(), environment: 'cozinha clara com azulejo branco', continuity: 'pote sempre verde', lighting: 'luz de janela' }
    const prompt = composePrompt({ scene: 'x', style })
    expect(prompt).toContain('Lighting: luz de janela')
    expect(prompt).toContain('Recurring environment details: cozinha clara com azulejo branco')
    expect(prompt).toContain('Continuity: pote sempre verde')
  })

  it('guia desligado e sem fotos: a cena vai exatamente como foi escrita', () => {
    expect(composePrompt({ scene: 'cena simples', style: legacyStyleGuide() })).toBe('cena simples')
    expect(composePrompt({ scene: 'cena simples' })).toBe('cena simples')
  })

  it('a cena nunca é alterada, só emoldurada', () => {
    const scene = 'Maria pega o pote. Ela sorri.'
    const prompt = composePrompt({ scene, cast: [{ sheet: maria, imageCount: 1 }], style: defaultStyleGuide() })
    expect(prompt.split('Scene: ')[1]).toBe(scene)
  })
})

describe('guia de estilo e ficha — utilitários', () => {
  it('proporção preferida escolhe o tamanho do modelo', () => {
    expect(sizeForAspect('gpt-image-1.5', '9:16')).toBe('1024x1536')
    expect(sizeForAspect('gpt-image-1.5', '16:9')).toBe('1536x1024')
    expect(sizeForAspect('dall-e-3', '9:16')).toBe('1024x1792')
    expect(sizeForAspect('dall-e-2', '9:16')).toBe('256x256') // só tem quadrado
    expect(aspectMatches('9:16', 9 / 16)).toBe(true)
  })

  it('projetos antigos ganham o guia padrão desligado; valores inválidos são corrigidos', () => {
    expect(normalizeStyleGuide(undefined).enabled).toBe(false)
    const fixed = normalizeStyleGuide({ enabled: true, aspect: '4:3', lighting: 42 }, defaultStyleGuide())
    expect(fixed).toMatchObject({ enabled: true, aspect: '9:16', lighting: defaultStyleGuide().lighting })
  })

  it('ficha: nome obrigatório, textos limpos e limitados', () => {
    expect(normalizeSheet({ name: '  ' })).toMatchObject({ ok: false })
    expect(normalizeSheet({ name: 'Ana', hair: 5 })).toMatchObject({ ok: false })
    expect(normalizeSheet({ name: 'Ana', hair: 'x'.repeat(2001) })).toMatchObject({ ok: false })
    expect(normalizeSheet({ name: '  Ana  ', hair: ' preto ' })).toEqual({ ok: true, sheet: { ...emptySheet(), name: 'Ana', hair: 'preto' } })
  })

  it('a foto principal vem primeiro', () => {
    const photos = ['a', 'b', 'c'].map((id) => ({ id, name: id, mimeType: 'image/png' as const, byteLength: 1, width: 1, height: 1, sha256: id }))
    expect(orderedPhotos({ photos, primaryPhotoId: 'c' }).map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })
})
