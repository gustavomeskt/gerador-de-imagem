import { orderedPhotos, sheetOf, type Character, type CharacterPhoto } from '../generation/characters'
import { composePrompt } from '../generation/promptComposer'
import { allocateCharacterPhotos } from '../generation/referencePlan'
import { DEFAULT_MAX_REFERENCES } from '../generation/references'
import { defaultStyleGuide, type StyleGuide } from '../generation/styleGuide'
import type { Storyboard, StoryScene } from './types'
import { buildVisualMemory, visualConflicts } from './visualMemory'

// Prompt automático de cada cena do storyboard. Reaproveita o compositor da
// Etapa 4 (ficha permanente dos personagens + fotos + guia de estilo) e
// monta a "cena" só com o que o storyboard registrou a partir da copy, mais a
// memória visual das cenas anteriores (roupas, cenários, objetos).
//
// planScene devolve também QUAIS fotos vão (na ordem do texto) e o que impede
// a geração — é o mesmo plano usado na pré-visualização e no lote.

export interface ScenePromptResult {
  prompt: string
  cast: Array<{ key: string; name: string; libraryId: string; photosSent: number; photosTotal: number }>
  unregistered: string[] // personagens da cena ainda sem cadastro (sem foto)
  deleted: string[] // associados a um personagem que foi excluído da biblioteca
  warnings: string[]
  photoCount: number
  styleSource: 'project' | 'default'
}

export interface ScenePlanOptions {
  // imagens de cenas anteriores pedidas para continuidade (vão depois das
  // fotos dos personagens, se couberem no limite)
  continuity?: Array<{ label: string }>
  maxReferences?: number
}

export interface ScenePlan extends ScenePromptResult {
  photos: Array<{ key: string; characterId: string; name: string; photo: CharacterPhoto }>
  continuityUsed: number
  // o que impede gerar esta cena (precisa de revisão humana)
  blocking: string[]
  manualPrompt: boolean
}

function lines(scene: StoryScene, names: (keys: string[]) => string[], extraPeople: string[], memory: string[]): string {
  const speaker = scene.speakerKey ? names([scene.speakerKey])[0] : ''
  const everyone = names(scene.characterKeys)
  const out = [
    `Action: ${scene.action}`,
    everyone.length > 0 &&
      `People in this image: exactly ${everyone.length} main ${everyone.length === 1 ? 'person' : 'people'} (${everyone.join(', ')}), each one shown once. Do not add other recognizable people.`,
    scene.positions?.trim() && `Positions in the frame (left to right): ${scene.positions.trim()}`,
    scene.environment && `Setting: ${scene.environment}`,
    speaker && scene.dialogue && `${speaker} is speaking (show it through facial expression and gesture only — no speech balloons, no text).`,
    scene.emotions && `Facial expressions / emotions: ${scene.emotions}`,
    scene.wardrobe && `Clothing: ${scene.wardrobe}`,
    scene.objects.length > 0 && `Important objects: ${scene.objects.join(', ')}`,
    scene.timeShift && `Time: ${scene.timeShift}`,
    scene.continuity && `Continuity: ${scene.continuity}`,
    memory.length > 0 && `Continuity memory from earlier scenes (keep it unless this scene says otherwise): ${memory.join(' ')}`,
    (scene.framing || scene.camera) && `Framing: ${[scene.framing, scene.camera].filter(Boolean).join('; ')}`,
    scene.visualDescription && `Composition notes (visual details only, not new events): ${scene.visualDescription}`,
    extraPeople.length > 0 && `Also present (no reference photo available, keep them generic and secondary): ${extraPeople.join(', ')}`,
    `Original story excerpt, for fidelity only — do NOT write it in the image: "${scene.excerpt}"`,
  ]
  return out.filter(Boolean).join('\n')
}

export function planScene(
  scene: StoryScene,
  board: Storyboard,
  library: Character[],
  projectStyle?: StyleGuide,
  options: ScenePlanOptions = {},
): ScenePlan {
  const limit = options.maxReferences ?? DEFAULT_MAX_REFERENCES
  const byKey = new Map(board.characters.map((c) => [c.key, c]))
  const names = (keys: string[]) => keys.map((k) => byKey.get(k)?.name ?? '?')
  const warnings: string[] = []
  const blocking: string[] = []
  const unregistered: string[] = []
  const deleted: string[] = []
  const cast: Character[] = []
  const castKeys: string[] = []

  for (const key of scene.characterKeys) {
    const sc = byKey.get(key)
    if (!sc) continue
    if (sc.matchStatus === 'ambiguous' && !sc.libraryId) {
      blocking.push(`${sc.name}: associação com a biblioteca ambígua — confirme na aba Personagens.`)
    }
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
  // duas pessoas da cena ligadas à MESMA ficha: os rostos se misturariam
  const libIds = scene.characterKeys.map((k) => byKey.get(k)?.libraryId).filter((id): id is string => !!id)
  const dup = libIds.find((id, i) => libIds.indexOf(id) !== i)
  if (dup) {
    const who = scene.characterKeys.filter((k) => byKey.get(k)?.libraryId === dup).map((k) => byKey.get(k)!.name)
    blocking.push(`${who.join(' e ')} estão associados à mesma ficha da biblioteca — corrija na aba Personagens para não misturar rostos.`)
  }
  warnings.push(...(visualConflicts(board).get(scene.id) ?? []))
  if (deleted.length) {
    warnings.push(`Associados a personagem excluído da biblioteca: ${deleted.join(', ')}.`)
    blocking.push(`Personagem excluído da biblioteca: ${deleted.join(', ')} — associe outro ou retire da cena.`)
  }

  const castPhotos = cast.map((c) => orderedPhotos(c).filter((p) => !p.missing))
  const seen = new Map<string, string>()
  cast.forEach((c, i) => {
    for (const p of castPhotos[i]) {
      const other = seen.get(p.sha256)
      if (other && other !== c.name) warnings.push(`${other} e ${c.name} usam a mesma foto — as identidades podem se misturar.`)
      seen.set(p.sha256, c.name)
    }
  })
  cast.forEach((c, i) => {
    if (castPhotos[i].length === 0) blocking.push(`As fotos de ${c.name} não foram encontradas no armazenamento — edite o personagem.`)
  })

  // prioridade: foto principal de cada personagem > imagem de continuidade >
  // fotos extras. Nada essencial é descartado em silêncio.
  const wanted = options.continuity?.length ?? 0
  let continuityUsed = wanted
  let allocation = allocateCharacterPhotos(castPhotos, wanted, limit)
  if (!allocation.ok && wanted > 0) {
    continuityUsed = 0
    allocation = allocateCharacterPhotos(castPhotos, 0, limit)
    if (allocation.ok) warnings.push('Sem espaço para a imagem da cena anterior (continuidade): só as fotos dos personagens vão.')
  }
  let chosen: CharacterPhoto[][]
  if (allocation.ok) chosen = allocation.chosen
  else {
    const needed = castPhotos.filter((p) => p.length > 0).length
    warnings.push(`A cena tem ${needed} personagens com foto; o limite é ${limit} fotos por geração.`)
    blocking.push(`${needed} personagens com foto nesta cena, acima do limite de ${limit} fotos por geração — divida a cena ou retire alguém.`)
    // pré-visualização mostra os primeiros; a cena não entra no lote
    chosen = castPhotos.slice(0, limit).map((p) => p.slice(0, 1))
  }

  // storyboard: guia do projeto (se ligado) ou o padrão fotorrealista; em
  // qualquer caso vertical 9:16 e sem texto na imagem
  const styleSource = projectStyle?.enabled ? 'project' : 'default'
  const style = { ...(projectStyle?.enabled ? projectStyle : defaultStyleGuide()), aspect: '9:16' as const, noText: true }

  const continuity = (options.continuity ?? []).slice(0, continuityUsed)
  const composed = composePrompt({
    scene: lines(scene, names, [...unregistered, ...deleted], buildVisualMemory(board).get(scene.id) ?? []),
    cast: cast.slice(0, chosen.length).map((c, i) => ({ sheet: sheetOf(c), imageCount: chosen[i].length })),
    continuity: continuity.map((c) => ({ label: c.label, imageCount: 1 })),
    style,
  })
  const manualPrompt = !!scene.promptOverride?.trim()
  if (manualPrompt && (chosen.length || continuity.length)) {
    warnings.push('Prompt editado manualmente: confira se ele explica as fotos anexadas (personagens e continuidade).')
  }

  const photos = cast.slice(0, chosen.length).flatMap((c, i) =>
    chosen[i].map((photo) => ({ key: castKeys[i], characterId: c.id, name: c.name, photo })),
  )
  return {
    prompt: manualPrompt ? scene.promptOverride!.trim() : composed,
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
    photoCount: photos.length + continuity.length,
    styleSource,
    photos,
    continuityUsed: continuity.length,
    blocking,
    manualPrompt,
  }
}

export function buildScenePrompt(scene: StoryScene, board: Storyboard, library: Character[], projectStyle?: StyleGuide): ScenePromptResult {
  return planScene(scene, board, library, projectStyle)
}
