import { sheetOf, type Character } from '../generation/characters'
import { MODEL_LABELS } from '../generation/models'
import { REFERENCE_MIME_TYPES, supportsReferences } from '../generation/references'
import type { StyleGuide } from '../generation/styleGuide'
import { planScene } from '../story/scenePrompt'
import { hashText, normalizeForSearch } from '../story/text'
import type { Storyboard, StoryScene } from '../story/types'
import type { BatchScope, BatchSettings, BatchTask, SceneImageVersion, TaskReference } from './types'

// Planejamento do lote: decide quais cenas entram, monta o prompt e a lista
// de referências de CADA cena (com o mesmo planScene da pré-visualização) e
// aponta o que precisa de revisão antes de gastar.

export interface SceneReport {
  sceneId: string
  number: number
  included: boolean
  reason?: string // por que ficou de fora
  blocking: string[]
  warnings: string[]
  flags: number
}

export interface BatchPlan {
  tasks: BatchTask[]
  scenes: SceneReport[]
  summary: {
    images: number
    excluded: number
    notApproved: number
    blocked: number
    flagged: number
    withDependencies: number
    storyboardApproved: boolean
    ambiguous: string[]
    unregistered: string[]
  }
  errors: string[] // impedem o lote inteiro (ex.: modelo sem referências)
}

// Impressão digital do conteúdo da cena: se mudar depois da geração, a
// imagem aparece como "gerada antes da última edição".
export function sceneFingerprint(scene: StoryScene, board: Storyboard): string {
  const cast = scene.characterKeys.map((k) => {
    const c = board.characters.find((x) => x.key === k)
    return [c?.name, c?.libraryId]
  })
  return hashText(
    JSON.stringify([
      scene.excerpt, cast, scene.speakerKey, scene.dialogue, scene.environment, scene.action, scene.emotions, scene.wardrobe,
      scene.objects, scene.timeShift, scene.continuity, scene.framing, scene.camera, scene.visualDescription, scene.promptOverride ?? '',
    ]),
  )
}

export function officialVersion(scene: StoryScene): SceneImageVersion | undefined {
  return scene.images?.find((v) => v.id === scene.officialImageId)
}

function sharesCharacter(a: StoryScene, b: StoryScene): boolean {
  return a.characterKeys.some((k) => b.characterKeys.includes(k))
}

function sameEnvironment(a: StoryScene, b: StoryScene): boolean {
  return !!a.environment.trim() && normalizeForSearch(a.environment) === normalizeForSearch(b.environment)
}

// Cenas anteriores que servem de referência de continuidade para a cena
// `index`, da mais adequada para a menos: mesmo ambiente E algum personagem
// em comum; depois só o mesmo ambiente.
export function continuityCandidates(board: Storyboard, index: number): StoryScene[] {
  const scene = board.scenes[index]
  const before = board.scenes.slice(0, index).reverse()
  const strong = before.filter((s) => sameEnvironment(s, scene) && sharesCharacter(s, scene))
  const weak = before.filter((s) => sameEnvironment(s, scene) && !sharesCharacter(s, scene))
  return [...strong, ...weak]
}

function sendable(mimeType: string): boolean {
  return (REFERENCE_MIME_TYPES as readonly string[]).includes(mimeType)
}

export function planBatch(params: {
  board: Storyboard
  library: Character[]
  style?: StyleGuide
  settings: BatchSettings
  scope: BatchScope
  selectedIds?: string[]
  simulated: boolean // lote de imagens fictícias
  makeId: (prefix: string) => string
}): BatchPlan {
  const { board, library, style, settings, scope, makeId } = params
  const selected = new Set(params.selectedIds ?? [])
  const errors: string[] = []
  const usesPhotos = board.characters.some((c) => c.libraryId)
  if (usesPhotos && !supportsReferences(settings.model)) {
    errors.push(`${MODEL_LABELS[settings.model]} não aceita fotos de referência — escolha um modelo GPT Image.`)
  }

  const taskOfScene = new Map<string, BatchTask>()
  const tasks: BatchTask[] = []
  const reports: SceneReport[] = []

  board.scenes.forEach((scene, index) => {
    const number = index + 1
    const report: SceneReport = { sceneId: scene.id, number, included: false, blocking: [], warnings: [], flags: scene.flags.length }
    reports.push(report)

    const inScope =
      scope === 'all' ||
      (scope === 'pending' && !officialVersion(scene)) ||
      ((scope === 'selected' || scope === 'single') && selected.has(scene.id))
    if (!inScope) {
      report.reason = scope === 'pending' ? 'já tem imagem' : 'não selecionada'
      return
    }
    if (scene.status !== 'approved') {
      report.reason = 'cena ainda não aprovada no storyboard'
      return
    }

    // continuidade: imagem de uma cena anterior (se o modo pedir)
    const continuity: TaskReference[] = []
    let dependsOn: string[] = []
    if (settings.continuity !== 'off') {
      for (const candidate of continuityCandidates(board, index)) {
        const candidateNumber = board.scenes.indexOf(candidate) + 1
        const label = `Cena ${candidateNumber}${candidate.environment ? ` (${candidate.environment})` : ''}`
        const dep = taskOfScene.get(candidate.id)
        if (settings.continuity === 'chain' && dep) {
          continuity.push({ kind: 'continuity', label, sceneId: candidate.id, fromTaskId: dep.id, deferred: true })
          dependsOn = [dep.id]
          break
        }
        const official = officialVersion(candidate)
        // só imagem APROVADA, e fictícia não guia imagem real
        if (official && candidate.imageApprovedAt && official.simulated === params.simulated && (official.assetId || official.src)) {
          continuity.push({
            kind: 'continuity',
            label,
            sceneId: candidate.id,
            versionId: official.id,
            assetId: official.assetId,
            sha256: official.sha256,
            mimeType: official.mimeType,
            byteLength: official.byteLength,
            width: official.width ?? undefined,
            height: official.height ?? undefined,
            // imagem simulada (SVG) é convertida na hora de enviar
            deferred: !sendable(official.mimeType),
          })
          break
        }
        if (official && candidate.imageApprovedAt && official.simulated !== params.simulated) {
          report.warnings.push(`A imagem aprovada da cena ${candidateNumber} é ${official.simulated ? 'simulada' : 'real'} e não serve de continuidade para este lote.`)
        }
      }
    }

    const plan = planScene(scene, board, library, style, { continuity: continuity.map((c) => ({ label: c.label })) })
    report.blocking.push(...plan.blocking)
    report.warnings.push(...plan.warnings)
    if (scene.flags.length) report.warnings.push(`${scene.flags.length} alerta(s) de revisão no storyboard.`)
    if (plan.blocking.length || errors.length) {
      report.reason = 'precisa de revisão'
      return
    }
    const used = continuity.slice(0, plan.continuityUsed)
    if (used.length === 0) dependsOn = []

    const references: TaskReference[] = [
      ...plan.photos.map((p): TaskReference => {
        const lib = library.find((c) => c.id === p.characterId)
        return {
          kind: 'character',
          label: p.name,
          characterId: p.characterId,
          characterVersion: lib?.version,
          photoId: p.photo.id,
          assetId: p.photo.assetId,
          sha256: p.photo.sha256,
          mimeType: p.photo.mimeType,
          byteLength: p.photo.byteLength,
          width: p.photo.width,
          height: p.photo.height,
        }
      }),
      ...used,
    ]

    const task: BatchTask = {
      id: makeId('tarefa'),
      sceneId: scene.id,
      sceneNumber: number,
      prompt: plan.prompt,
      references,
      dependsOn,
      status: 'pending',
      attempts: 0,
      sceneFingerprint: sceneFingerprint(scene, board),
      characters: plan.cast.map((c) => {
        const lib = library.find((l) => l.id === c.libraryId)!
        return { characterId: lib.id, name: lib.name, version: lib.version, sheet: { ...sheetOf(lib) } }
      }),
    }
    taskOfScene.set(scene.id, task)
    tasks.push(task)
    report.included = true
  })

  const characterIssues = (status: 'ambiguous' | 'unregistered') =>
    board.characters
      .filter((c) => c.matchStatus === status && !c.libraryId)
      .filter((c) => board.scenes.some((s) => s.characterKeys.includes(c.key)))
      .map((c) => c.name)

  return {
    tasks: errors.length ? [] : tasks,
    scenes: reports,
    summary: {
      images: errors.length ? 0 : tasks.length,
      excluded: reports.filter((r) => !r.included).length,
      notApproved: reports.filter((r) => r.reason === 'cena ainda não aprovada no storyboard').length,
      blocked: reports.filter((r) => r.blocking.length > 0).length,
      flagged: reports.filter((r) => r.included && r.flags > 0).length,
      withDependencies: tasks.filter((t) => t.dependsOn.length > 0).length,
      storyboardApproved: !!board.approvedAt && board.scenes.every((s) => s.status === 'approved'),
      ambiguous: characterIssues('ambiguous'),
      unregistered: characterIssues('unregistered'),
    },
    errors: errors.length ? errors : [],
  }
}
