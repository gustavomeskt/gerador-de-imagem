import { orderedPhotos, sheetOf, type Character } from '../generation/characters'
import { composePrompt } from '../generation/promptComposer'
import { allocateCharacterPhotos } from '../generation/referencePlan'
import { DEFAULT_MAX_REFERENCES } from '../generation/references'
import { defaultStyleGuide, type StyleGuide } from '../generation/styleGuide'
import type { Storyboard, StoryScene } from './types'

// Prompt automático de cada cena do storyboard. Reaproveita o compositor da
// Etapa 4 (ficha permanente dos personagens + fotos + guia de estilo) e
// monta a "cena" só com o que o storyboard registrou a partir da copy.

export interface ScenePromptResult {
  prompt: string
  cast: Array<{ key: string; name: string; libraryId: string; photosSent: number; photosTotal: number }>
  unregistered: string[] // personagens da cena ainda sem cadastro (sem foto)
  deleted: string[] // associados a um personagem que foi excluído da biblioteca
  warnings: string[]
  photoCount: number
  styleSource: 'project' | 'default'
}

function lines(scene: StoryScene, names: (keys: string[]) => string[], extraPeople: string[]): string {
  const speaker = scene.speakerKey ? names([scene.speakerKey])[0] : ''
  const out = [
    `Action: ${scene.action}`,
    scene.environment && `Setting: ${scene.environment}`,
    speaker && scene.dialogue && `${speaker} is speaking (show it through facial expression and gesture only — no speech balloons, no text).`,
    scene.emotions && `Facial expressions / emotions: ${scene.emotions}`,
    scene.wardrobe && `Clothing: ${scene.wardrobe}`,
    scene.objects.length > 0 && `Important objects: ${scene.objects.join(', ')}`,
    scene.timeShift && `Time: ${scene.timeShift}`,
    scene.continuity && `Continuity: ${scene.continuity}`,
    (scene.framing || scene.camera) && `Framing: ${[scene.framing, scene.camera].filter(Boolean).join('; ')}`,
    scene.visualDescription && `Composition notes (visual details only, not new events): ${scene.visualDescription}`,
    extraPeople.length > 0 && `Also present (no reference photo available, keep them generic and secondary): ${extraPeople.join(', ')}`,
    `Original story excerpt, for fidelity only — do NOT write it in the image: "${scene.excerpt}"`,
  ]
  return out.filter(Boolean).join('\n')
}

export function buildScenePrompt(scene: StoryScene, board: Storyboard, library: Character[], projectStyle?: StyleGuide): ScenePromptResult {
  const byKey = new Map(board.characters.map((c) => [c.key, c]))
  const names = (keys: string[]) => keys.map((k) => byKey.get(k)?.name ?? '?')
  const warnings: string[] = []
  const unregistered: string[] = []
  const deleted: string[] = []
  const cast: Character[] = []
  const castKeys: string[] = []

  for (const key of scene.characterKeys) {
    const sc = byKey.get(key)
    if (!sc) continue
    if (!sc.libraryId) {
      unregistered.push(sc.name)
      continue
    }
    const lib = library.find((l) => l.id === sc.libraryId)
    if (!lib) {
      deleted.push(sc.name)
      continue
    }
    cast.push(lib)
    castKeys.push(key)
  }
  if (unregistered.length) warnings.push(`Sem cadastro na biblioteca (vão sem foto): ${unregistered.join(', ')}.`)
  if (deleted.length) warnings.push(`Associados a personagem excluído da biblioteca: ${deleted.join(', ')}.`)

  const castPhotos = cast.map((c) => orderedPhotos(c).filter((p) => !p.missing))
  let allocation = allocateCharacterPhotos(castPhotos, 0, DEFAULT_MAX_REFERENCES)
  if (!allocation.ok) {
    warnings.push(`A cena tem ${cast.length} personagens com foto; o limite é ${DEFAULT_MAX_REFERENCES} fotos por geração.`)
    allocation = allocateCharacterPhotos(castPhotos.slice(0, DEFAULT_MAX_REFERENCES), 0, DEFAULT_MAX_REFERENCES)
  }
  const chosen = allocation.ok ? allocation.chosen : []

  // usa o guia do projeto se estiver ligado; senão, o guia padrão
  // (fotorrealista). Em qualquer caso o storyboard é vertical 9:16 e sem
  // texto na imagem — os textos são colocados depois, fora da geração.
  const styleSource = projectStyle?.enabled ? 'project' : 'default'
  const style = { ...(projectStyle?.enabled ? projectStyle : defaultStyleGuide()), aspect: '9:16' as const, noText: true }

  const prompt = composePrompt({
    scene: lines(scene, names, [...unregistered, ...deleted]),
    cast: cast.slice(0, chosen.length).map((c, i) => ({ sheet: sheetOf(c), imageCount: chosen[i].length })),
    style,
  })

  return {
    prompt: scene.promptOverride?.trim() || prompt,
    cast: cast.slice(0, chosen.length).map((c, i) => ({
      key: castKeys[i],
      name: c.name,
      libraryId: c.id,
      photosSent: chosen[i].length,
      photosTotal: castPhotos[i].length,
    })),
    unregistered,
    deleted,
    warnings,
    photoCount: chosen.reduce((sum, p) => sum + p.length, 0),
    styleSource,
  }
}
