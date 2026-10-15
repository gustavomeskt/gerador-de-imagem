import { matchCharacter, type LibraryEntry } from './characterMatching'
import { withParts, type BuiltInterpretation } from './interpretation'
import { locateQuote, normalizeName, sentenceBoundaries } from './text'
import type { SceneStatus, Storyboard, StoryCharacter, StoryScene } from './types'

// Operações sobre o storyboard. Todas são funções puras que devolvem um
// storyboard novo — e NENHUMA altera a copy original.

const MAX_HISTORY = 300
const MAX_SNAPSHOTS = 10

export function emptyStoryboard(projectId: string, now = Date.now()): Storyboard {
  return {
    projectId,
    copy: '',
    copySavedAt: null,
    characters: [],
    scenes: [],
    interpretation: null,
    approvedAt: null,
    history: [],
    snapshots: [],
    createdAt: now,
    updatedAt: now,
  }
}

function log(board: Storyboard, action: string, now: number): Storyboard {
  return { ...board, history: [...board.history, { at: now, action }].slice(-MAX_HISTORY), updatedAt: now }
}

function snapshot(board: Storyboard, reason: string, now: number): Storyboard {
  if (board.scenes.length === 0) return board
  const snap = { at: now, reason, copy: board.copy, characters: board.characters, scenes: board.scenes }
  return { ...board, snapshots: [...board.snapshots, snap].slice(-MAX_SNAPSHOTS) }
}

// Salva a copy. Se já havia cenas, cada uma é reencontrada no texto novo pelo
// seu trecho literal; as que não forem achadas ficam sinalizadas (nada some).
export function saveCopy(board: Storyboard, copy: string, now = Date.now()): Storyboard {
  if (copy === board.copy) return board
  let next: Storyboard = snapshot(board, 'antes de alterar a copy', now)
  let cursor = 0
  let lost = 0
  const scenes = next.scenes.map((s) => {
    const span = locateQuote(copy, s.excerpt, cursor) ?? locateQuote(copy, s.excerpt, 0)
    if (span && copy.slice(span.start, span.end) === s.excerpt) {
      cursor = span.start
      return { ...s, source: span }
    }
    lost += 1
    const flag = 'O trecho original desta cena não existe mais na copy — revise ou remova a cena.'
    return { ...s, flags: s.flags.includes(flag) ? s.flags : [...s.flags, flag], status: 'pending' as SceneStatus }
  })
  next = { ...next, copy, copySavedAt: now, scenes, approvedAt: lost ? null : next.approvedAt }
  return log(next, lost ? `Copy alterada — ${lost} cena(s) perderam o trecho original e foram sinalizadas.` : 'Copy salva.', now)
}

export interface ApplySummary {
  keptApproved: number
  added: number
  replaced: number
  replacedReviewed: number
}

// Aplica uma interpretação nova. Cenas APROVADAS são mantidas como estão (e
// as cenas novas que cobrem o mesmo trecho são descartadas); as demais são
// substituídas. Antes, o storyboard inteiro vira uma versão restaurável.
export function applyInterpretation(
  board: Storyboard,
  built: BuiltInterpretation,
  meta: { mode: 'simulated' | 'openai'; model: string },
  now = Date.now(),
): { board: Storyboard; summary: ApplySummary } {
  let next = snapshot(board, 'antes de reinterpretar', now)

  // personagens: mantém chave e associação já confirmadas pelo mesmo nome
  const keyMap = new Map<string, string>()
  const characters: StoryCharacter[] = [...next.characters]
  for (const fresh of built.characters) {
    const old = characters.find((c) => normalizeName(c.name) === normalizeName(fresh.name))
    if (old) {
      keyMap.set(fresh.key, old.key)
      const decided = old.matchStatus === 'confirmed' || old.matchStatus === 'manual'
      const merged = { ...old, mentions: [...new Set([...old.mentions, ...fresh.mentions])] }
      Object.assign(merged, decided ? {} : { libraryId: fresh.libraryId, matchStatus: fresh.matchStatus, candidates: fresh.candidates })
      characters[characters.indexOf(old)] = merged
    } else {
      characters.push(fresh)
      keyMap.set(fresh.key, fresh.key)
    }
  }

  // aprovadas e cenas que já têm imagem gerada ficam como estão
  const approved = next.scenes.filter((s) => s.status === 'approved' || (s.images?.length ?? 0) > 0)
  const overlaps = (a: StoryScene, b: StoryScene) => a.source.start < b.source.end && b.source.start < a.source.end
  const freshScenes = built.scenes
    .filter((s) => !approved.some((a) => overlaps(a, s)))
    .map((s) => ({
      ...s,
      characterKeys: s.characterKeys.map((k) => keyMap.get(k) ?? k),
      speakerKey: s.speakerKey ? (keyMap.get(s.speakerKey) ?? s.speakerKey) : null,
    }))
  const notApproved = next.scenes.filter((s) => !approved.includes(s))
  const scenes = withParts([...approved, ...freshScenes].sort((a, b) => a.source.start - b.source.start))

  const summary: ApplySummary = {
    keptApproved: approved.length,
    added: freshScenes.length,
    replaced: notApproved.length,
    replacedReviewed: notApproved.filter((s) => s.status === 'reviewed').length,
  }
  next = {
    ...next,
    characters,
    scenes,
    interpretation: { ...meta, at: now, warnings: built.warnings },
    approvedAt: null,
  }
  const parts = [
    `${scenes.length} cena(s)`,
    summary.keptApproved ? `${summary.keptApproved} aprovada(s) preservada(s)` : null,
    summary.replacedReviewed ? `${summary.replacedReviewed} revisada(s) não aprovada(s) substituída(s) — restaurável em "Versões anteriores"` : null,
  ].filter(Boolean)
  return { board: log(next, `Interpretação ${meta.mode === 'simulated' ? 'SIMULADA' : 'por IA'}: ${parts.join(', ')}.`, now), summary }
}

const CONTENT_FIELDS: Array<keyof StoryScene> = [
  'characterKeys', 'speakerKey', 'dialogue', 'environment', 'action', 'emotions', 'wardrobe', 'objects', 'timeShift',
  'continuity', 'framing', 'camera', 'visualDescription', 'motion', 'promptOverride',
]

export type ScenePatch = Partial<Pick<StoryScene, 'characterKeys' | 'speakerKey' | 'dialogue' | 'environment' | 'action' | 'emotions' | 'wardrobe' | 'objects' | 'timeShift' | 'continuity' | 'framing' | 'camera' | 'visualDescription' | 'motion' | 'promptOverride' | 'flags'>>

// Edita uma cena. Mudar o conteúdo de uma cena aprovada a devolve para
// "revisada" (precisa ser aprovada de novo). O trecho da copy não é editável.
export function updateScene(board: Storyboard, sceneId: string, patch: ScenePatch, now = Date.now()): Storyboard {
  let changed = false
  const scenes = board.scenes.map((s) => {
    if (s.id !== sceneId) return s
    const touchesContent = CONTENT_FIELDS.some((f) => f in patch && JSON.stringify(patch[f as keyof ScenePatch]) !== JSON.stringify(s[f]))
    if (!touchesContent && !('flags' in patch)) return s
    changed = true
    return { ...s, ...patch, status: touchesContent ? ('reviewed' as SceneStatus) : s.status, updatedAt: now }
  })
  if (!changed) return board
  const n = board.scenes.findIndex((s) => s.id === sceneId) + 1
  return log({ ...board, scenes, approvedAt: null }, `Cena ${n} editada.`, now)
}

export function setSceneStatus(board: Storyboard, sceneId: string, status: SceneStatus, now = Date.now()): Storyboard {
  const n = board.scenes.findIndex((s) => s.id === sceneId) + 1
  if (n === 0) return board
  const scenes = board.scenes.map((s) => (s.id === sceneId ? { ...s, status, updatedAt: now } : s))
  const label = status === 'approved' ? 'aprovada' : status === 'reviewed' ? 'marcada como revisada' : 'voltou para pendente'
  return log({ ...board, scenes, approvedAt: status === 'approved' ? board.approvedAt : null }, `Cena ${n} ${label}.`, now)
}

export function approveAll(board: Storyboard, now = Date.now()): Storyboard {
  const scenes = board.scenes.map((s) => (s.status === 'approved' ? s : { ...s, status: 'approved' as SceneStatus, updatedAt: now }))
  return log({ ...board, scenes, approvedAt: now }, `Storyboard completo aprovado (${scenes.length} cenas).`, now)
}

// Divide uma cena em duas. Se o trecho tem mais de uma frase, divide no
// limite de frase mais próximo do meio; senão, as duas imagens usam o mesmo
// trecho (uma passagem → duas imagens). O texto da copy não muda.
export function splitScene(board: Storyboard, sceneId: string, makeId: (p: string) => string, now = Date.now()): Storyboard {
  const index = board.scenes.findIndex((s) => s.id === sceneId)
  if (index < 0) return board
  const s = board.scenes[index]
  const cuts = sentenceBoundaries(s.excerpt).filter((c) => c > 0 && c < s.excerpt.length)
  const middle = s.excerpt.length / 2
  const cut = cuts.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0]

  let first: StoryScene
  let second: StoryScene
  if (cut) {
    const end1 = s.source.start + s.excerpt.slice(0, cut).trimEnd().length
    const start2 = s.source.start + cut
    first = { ...s, source: { start: s.source.start, end: end1 }, excerpt: board.copy.slice(s.source.start, end1) }
    second = { ...s, id: makeId('cena'), source: { start: start2, end: s.source.end }, excerpt: board.copy.slice(start2, s.source.end) }
  } else {
    first = { ...s }
    second = { ...s, id: makeId('cena') }
  }
  // as imagens já geradas ficam com a primeira parte; a nova parte começa sem imagem
  second = { ...second, images: [], officialImageId: null, imageApprovedAt: null }
  const reset = { status: 'pending' as SceneStatus, origin: 'split' as const, updatedAt: now, promptOverride: undefined }
  const scenes = [...board.scenes]
  scenes.splice(index, 1, { ...first, ...reset }, { ...second, ...reset })
  return log({ ...board, scenes: withParts(scenes), approvedAt: null }, `Cena ${index + 1} dividida em duas.`, now)
}

// Une uma cena com a seguinte: o trecho passa a ir do início da primeira ao
// fim da segunda (continua sendo texto literal da copy).
export function mergeWithNext(board: Storyboard, sceneId: string, now = Date.now()): Storyboard {
  const index = board.scenes.findIndex((s) => s.id === sceneId)
  if (index < 0 || index >= board.scenes.length - 1) return board
  const a = board.scenes[index]
  const b = board.scenes[index + 1]
  const start = Math.min(a.source.start, b.source.start)
  const end = Math.max(a.source.end, b.source.end)
  const join = (x: string, y: string) => (x && y && x !== y ? `${x} / ${y}` : x || y)
  const merged: StoryScene = {
    ...a,
    source: { start, end },
    excerpt: board.copy.slice(start, end),
    characterKeys: [...new Set([...a.characterKeys, ...b.characterKeys])],
    speakerKey: a.speakerKey ?? b.speakerKey,
    dialogue: join(a.dialogue, b.dialogue),
    action: join(a.action, b.action),
    emotions: join(a.emotions, b.emotions),
    wardrobe: join(a.wardrobe, b.wardrobe),
    objects: [...new Set([...a.objects, ...b.objects])],
    timeShift: join(a.timeShift, b.timeShift),
    continuity: join(a.continuity, b.continuity),
    visualDescription: join(a.visualDescription, b.visualDescription),
    motion: join(a.motion, b.motion),
    flags: [...new Set([...a.flags, ...b.flags])],
    status: 'pending',
    origin: 'merged',
    promptOverride: undefined,
    updatedAt: now,
    // nenhuma imagem se perde ao unir; a oficial precisa ser aprovada de novo
    images: [...(a.images ?? []), ...(b.images ?? [])],
    officialImageId: a.officialImageId ?? b.officialImageId ?? null,
    imageApprovedAt: null,
  }
  const scenes = [...board.scenes]
  scenes.splice(index, 2, merged)
  return log({ ...board, scenes: withParts(scenes), approvedAt: null }, `Cenas ${index + 1} e ${index + 2} unidas.`, now)
}

export function moveScene(board: Storyboard, sceneId: string, toIndex: number, now = Date.now()): Storyboard {
  const from = board.scenes.findIndex((s) => s.id === sceneId)
  const to = Math.max(0, Math.min(board.scenes.length - 1, toIndex))
  if (from < 0 || from === to) return board
  const scenes = [...board.scenes]
  const [moved] = scenes.splice(from, 1)
  scenes.splice(to, 0, moved)
  return log({ ...board, scenes: withParts(scenes), approvedAt: null }, `Cena ${from + 1} movida para a posição ${to + 1}.`, now)
}

// Liga (ou desliga) um personagem da copy a um personagem da biblioteca.
export function resolveCharacter(board: Storyboard, key: string, libraryId: string | null, now = Date.now()): Storyboard {
  const c = board.characters.find((x) => x.key === key)
  if (!c) return board
  const characters = board.characters.map((x) =>
    x.key === key ? { ...x, libraryId, matchStatus: libraryId ? ('confirmed' as const) : ('unregistered' as const), candidates: libraryId ? [] : x.candidates } : x,
  )
  return log({ ...board, characters }, libraryId ? `${c.name} associado à biblioteca.` : `${c.name} desassociado da biblioteca.`, now)
}

// Adiciona um personagem da biblioteca ao storyboard (seleção manual).
export function addLibraryCharacter(board: Storyboard, library: { id: string; name: string }, makeId: (p: string) => string, now = Date.now()): { board: Storyboard; key: string } {
  const existing = board.characters.find((c) => c.libraryId === library.id)
  if (existing) return { board, key: existing.key }
  const c: StoryCharacter = { key: makeId('sc'), name: library.name, mentions: [], libraryId: library.id, matchStatus: 'manual', candidates: [] }
  return { board: log({ ...board, characters: [...board.characters, c] }, `${library.name} adicionado manualmente.`, now), key: c.key }
}

// Recalcula as correspondências automáticas (ex.: depois de cadastrar alguém
// na biblioteca). Não mexe no que a pessoa já confirmou.
export function refreshMatches(board: Storyboard, library: LibraryEntry[], now = Date.now()): Storyboard {
  let changed = false
  const characters = board.characters.map((c) => {
    if (c.matchStatus === 'confirmed' || c.matchStatus === 'manual') {
      if (c.libraryId && !library.some((l) => l.id === c.libraryId)) {
        changed = true
        return { ...c, libraryId: null, matchStatus: 'unregistered' as const }
      }
      return c
    }
    const m = matchCharacter(c.name, library)
    if (m.libraryId !== c.libraryId || m.matchStatus !== c.matchStatus || m.candidates.join() !== c.candidates.join()) changed = true
    return { ...c, ...m }
  })
  return changed ? { ...board, characters, updatedAt: now } : board
}

export function restoreSnapshot(board: Storyboard, index: number, now = Date.now()): Storyboard {
  const snap = board.snapshots[index]
  if (!snap) return board
  const current = snapshot(board, 'antes de restaurar uma versão anterior', now)
  const restored = { ...current, characters: snap.characters, scenes: snap.scenes, approvedAt: null }
  // a copy atual continua valendo; reencaixa as cenas restauradas nela
  const relocated = snap.copy === board.copy ? restored : saveCopy({ ...restored, copy: snap.copy }, board.copy, now)
  return log(relocated, `Versão de ${new Date(snap.at).toLocaleString('pt-BR')} restaurada (${snap.reason}).`, now)
}
