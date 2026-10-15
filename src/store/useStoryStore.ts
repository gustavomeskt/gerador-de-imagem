import { create } from 'zustand'
import { toStorageError } from '../persistence/errors'
import { repository } from '../persistence/repository'
import type { LibraryRecord } from '../persistence/schema'
import { buildFromRaw, InterpretationError, parseRawInterpretation } from '../story/interpretation'
import { createBackendInterpreter, createLocalSimulatedInterpreter, type StoryInterpreter } from '../story/interpreters'
import {
  addLibraryCharacter,
  applyInterpretation,
  approveAll,
  emptyStoryboard,
  mergeWithNext,
  moveScene,
  refreshMatches,
  resolveCharacter,
  restoreSnapshot,
  saveCopy,
  setSceneStatus,
  splitScene,
  updateScene,
  type ApplySummary,
  type ScenePatch,
} from '../story/operations'
import { recoverInterruptedRun } from '../batch/recovery'
import { buildScenePrompt } from '../story/scenePrompt'
import type { SceneStatus, Storyboard } from '../story/types'
import { useCharacterStore } from './useCharacterStore'
import { useFlowStore } from './useFlowStore'

// Storyboards das historinhas — um por projeto, salvo no IndexedDB (tabela
// "storyboards", id = id do projeto; apagar o projeto apaga o storyboard).
//
// Garantias:
//   • a copy é guardada exatamente como foi colada;
//   • uma interpretação que falha (ou é cancelada) não mexe no storyboard;
//   • cenas aprovadas sobrevivem a uma nova interpretação;
//   • toda mudança é gravada; se a gravação falhar, o storyboard continua na
//     tela e o aviso aparece (nada é descartado).

let idCounter = 0
function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

export type InterpretResult =
  | { ok: true; summary: ApplySummary; mode: 'simulated' | 'openai'; scenes: number; warnings: string[] }
  | { ok: false; cancelled?: boolean; error: string }

interface StoryState {
  hydrated: boolean
  persistent: boolean
  boards: Record<string, Storyboard>
  busy: Record<string, string | null>
  issue: string | null

  hydrate: () => Promise<void>
  ensureBoard: (projectId: string) => Storyboard
  saveCopy: (projectId: string, copy: string) => void
  interpret: (projectId: string) => Promise<InterpretResult>
  updateScene: (projectId: string, sceneId: string, patch: ScenePatch) => void
  setSceneStatus: (projectId: string, sceneId: string, status: SceneStatus) => void
  approveAll: (projectId: string) => void
  splitScene: (projectId: string, sceneId: string) => void
  mergeWithNext: (projectId: string, sceneId: string) => void
  moveScene: (projectId: string, sceneId: string, toIndex: number) => void
  resolveCharacter: (projectId: string, key: string, libraryId: string | null) => void
  addLibraryCharacter: (projectId: string, libraryId: string) => string | null
  refreshMatches: (projectId: string) => void
  restoreSnapshot: (projectId: string, index: number) => void
  refreshPrompts: (projectId: string) => void
  dismissIssue: () => void
  // alteração direta (usada pela geração em lote); prompts: recalcular os
  // prompts das cenas (desnecessário para mudanças só de imagens/fila)
  mutate: (projectId: string, change: (board: Storyboard) => Storyboard, options?: { prompts?: boolean }) => void
  forget: (projectId: string) => void
}

// Quem interpreta: provedor "Simulado" → regras locais; "Backend" → servidor
// local (que pode estar em modo simulado ou openai). Trocável nos testes.
let interpreterOverride: StoryInterpreter | null = null
export function setStoryInterpreterForTests(interpreter: StoryInterpreter | null) {
  interpreterOverride = interpreter
}
function currentInterpreter(): StoryInterpreter {
  if (interpreterOverride) return interpreterOverride
  return useFlowStore.getState().providerKind === 'backend' ? createBackendInterpreter() : createLocalSimulatedInterpreter()
}

function libraryEntries() {
  return useCharacterStore.getState().characters.map((c) => ({ id: c.id, name: c.name }))
}

// Recalcula o prompt de cada cena (fichas, fotos e guia de estilo atuais) —
// o prompt fica salvo junto com a cena.
function withPrompts(board: Storyboard): Storyboard {
  const library = useCharacterStore.getState().characters
  const style = useFlowStore.getState().flowsData[board.projectId]?.styleGuide
  let changed = false
  const scenes = board.scenes.map((s) => {
    const prompt = buildScenePrompt(s, board, library, style).prompt
    if (prompt === s.prompt) return s
    changed = true
    return { ...s, prompt }
  })
  return changed ? { ...board, scenes } : board
}

function toRecord(board: Storyboard): LibraryRecord {
  return {
    id: board.projectId,
    projectId: board.projectId,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    data: board as unknown as Record<string, unknown>,
  }
}

// Confere o mínimo do formato salvo antes de usar (registro corrompido ou de
// outra versão é ignorado, não derruba o app).
function fromRecord(record: LibraryRecord): Storyboard | null {
  const d = record.data as Partial<Storyboard>
  if (!d || typeof d.copy !== 'string' || !Array.isArray(d.scenes) || !Array.isArray(d.characters)) return null
  const base = emptyStoryboard(record.id, record.createdAt)
  return {
    ...base,
    ...d,
    projectId: record.id,
    history: Array.isArray(d.history) ? d.history : [],
    snapshots: Array.isArray(d.snapshots) ? d.snapshots : [],
  } as Storyboard
}

let hydrating: Promise<void> | null = null
// gravações em fila, uma por vez por projeto, sempre com a versão mais nova;
// várias mudanças seguidas viram uma gravação só
const saveQueues = new Map<string, Promise<void>>()
const saveScheduled = new Set<string>()

export const useStoryStore = create<StoryState>((set, get) => {
  function persist(board: Storyboard) {
    if (!get().persistent || saveScheduled.has(board.projectId)) return
    saveScheduled.add(board.projectId)
    const previous = saveQueues.get(board.projectId) ?? Promise.resolve()
    const next = previous.then(async () => {
      saveScheduled.delete(board.projectId)
      const latest = get().boards[board.projectId]
      if (!latest) return
      try {
        await repository.saveStoryboard(toRecord(latest))
      } catch (err) {
        set({ issue: `Não foi possível salvar o storyboard: ${toStorageError(err).message} As alterações continuam na tela.` })
      }
    })
    saveQueues.set(board.projectId, next)
  }

  function commit(projectId: string, change: (board: Storyboard) => Storyboard, prompts = true) {
    const current = get().ensureBoard(projectId)
    const changed = change(current)
    if (changed === current) return
    const board = prompts ? withPrompts(changed) : changed
    set((s) => ({ boards: { ...s.boards, [projectId]: board } }))
    persist(board)
  }

  return {
    hydrated: false,
    persistent: false,
    boards: {},
    busy: {},
    issue: null,

    hydrate: () => {
      hydrating ??= (async () => {
        try {
          await repository.open()
        } catch {
          set({ hydrated: true, persistent: false })
          return
        }
        try {
          const records = await repository.listStoryboards()
          const boards: Record<string, Storyboard> = {}
          let skipped = 0
          const recoveredIds: string[] = []
          for (const r of records) {
            const parsed = fromRecord(r)
            if (!parsed) {
              skipped += 1
              continue
            }
            // lote que estava rodando quando o app fechou: pausa e confere
            const { board, recovered, interrupted } = await recoverInterruptedRun(parsed, (id) => repository.getAsset(id))
            if (recovered || interrupted || board !== parsed) recoveredIds.push(board.projectId)
            boards[board.projectId] = board
          }
          set({
            hydrated: true,
            persistent: true,
            boards,
            issue: skipped ? `${skipped} storyboard(s) salvo(s) em formato desconhecido foram ignorados.` : null,
          })
          for (const id of recoveredIds) persist(boards[id])
        } catch (err) {
          set({ hydrated: true, persistent: false, issue: toStorageError(err, 'read').message })
        }
      })()
      return hydrating
    },

    ensureBoard: (projectId) => get().boards[projectId] ?? emptyStoryboard(projectId),

    saveCopy: (projectId, copy) => commit(projectId, (b) => (b.copy === copy && b.copySavedAt ? b : saveCopy(b, copy))),

    interpret: async (projectId) => {
      if (get().busy[projectId]) return { ok: false, error: 'Já existe uma interpretação em andamento.' }
      const start = get().ensureBoard(projectId)
      const copy = start.copy
      if (!copy.trim()) return { ok: false, error: 'Salve a copy antes de interpretar.' }

      const setBusy = (label: string | null) => set((s) => ({ busy: { ...s.busy, [projectId]: label } }))
      const interpreter = currentInterpreter()
      const library = libraryEntries()
      const names = library.map((c) => c.name)
      setBusy('Interpretando a historinha…')
      try {
        let quoteId: string | undefined
        if (interpreter.quote) {
          setBusy('Calculando o custo…')
          const quote = await interpreter.quote(copy, names)
          setBusy('Aguardando confirmação do custo…')
          if (!(await useFlowStore.getState().confirmCost('Interpretar historinha', quote))) {
            return { ok: false, cancelled: true, error: 'Interpretação cancelada. Nada foi alterado.' }
          }
          quoteId = quote.quoteId
          setBusy('Interpretando a historinha…')
        }
        const output = await interpreter.interpret(copy, names, { quoteId })
        // a pessoa pode ter editado a copy enquanto esperava
        if (get().ensureBoard(projectId).copy !== copy) {
          return { ok: false, error: 'A copy mudou durante a interpretação. Nada foi alterado; interprete de novo.' }
        }
        const raw = parseRawInterpretation(output.raw)
        const built = buildFromRaw(raw, copy, library, nextId)
        built.warnings.unshift(...output.warnings)
        let summary: ApplySummary | null = null
        commit(projectId, (b) => {
          const applied = applyInterpretation(b, built, { mode: output.mode, model: output.model })
          summary = applied.summary
          return applied.board
        })
        const board = get().ensureBoard(projectId)
        return { ok: true, summary: summary!, mode: output.mode, scenes: board.scenes.length, warnings: built.warnings }
      } catch (err) {
        const message =
          err instanceof InterpretationError
            ? `Interpretação recusada na validação: ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Falha na interpretação.'
        return { ok: false, error: `${message} O storyboard anterior foi mantido.` }
      } finally {
        setBusy(null)
      }
    },

    updateScene: (projectId, sceneId, patch) => commit(projectId, (b) => updateScene(b, sceneId, patch)),
    setSceneStatus: (projectId, sceneId, status) => commit(projectId, (b) => setSceneStatus(b, sceneId, status)),
    approveAll: (projectId) => commit(projectId, (b) => (b.scenes.length ? approveAll(b) : b)),
    splitScene: (projectId, sceneId) => commit(projectId, (b) => splitScene(b, sceneId, nextId)),
    mergeWithNext: (projectId, sceneId) => commit(projectId, (b) => mergeWithNext(b, sceneId)),
    moveScene: (projectId, sceneId, toIndex) => commit(projectId, (b) => moveScene(b, sceneId, toIndex)),
    resolveCharacter: (projectId, key, libraryId) => commit(projectId, (b) => resolveCharacter(b, key, libraryId)),

    addLibraryCharacter: (projectId, libraryId) => {
      const lib = libraryEntries().find((c) => c.id === libraryId)
      if (!lib) return null
      let key: string | null = null
      commit(projectId, (b) => {
        const r = addLibraryCharacter(b, lib, nextId)
        key = r.key
        return r.board
      })
      return key
    },

    refreshMatches: (projectId) => {
      if (!get().boards[projectId]) return
      commit(projectId, (b) => refreshMatches(b, libraryEntries()))
    },

    restoreSnapshot: (projectId, index) => commit(projectId, (b) => restoreSnapshot(b, index)),

    refreshPrompts: (projectId) => {
      const current = get().boards[projectId]
      if (!current) return
      const board = withPrompts(current)
      if (board === current) return
      set((s) => ({ boards: { ...s.boards, [projectId]: board } }))
      persist(board)
    },

    dismissIssue: () => set({ issue: null }),

    mutate: (projectId, change, options) => commit(projectId, change, options?.prompts ?? true),

    forget: (projectId) => {
      if (!get().boards[projectId]) return
      set((s) => {
        const boards = { ...s.boards }
        delete boards[projectId]
        return { boards }
      })
    },
  }
})

// Espera as gravações pendentes (usado nos testes e antes de exportar).
export async function flushStorySaves(): Promise<void> {
  await Promise.all([...saveQueues.values()])
}
