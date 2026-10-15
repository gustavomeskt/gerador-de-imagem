import type { Storyboard, StoryScene } from '../story/types'
import { officialVersion, sceneFingerprint } from './planner'
import type { BatchRun, BatchTask, SceneImageState, SceneImageVersion } from './types'

// Versões de imagem de uma cena. Toda imagem gerada fica guardada; a
// "oficial" é a que vai para a exportação. Uma imagem nova NUNCA toma o
// lugar de uma oficial já aprovada — só a pessoa troca.

export function withNewVersion(scene: StoryScene, version: SceneImageVersion): StoryScene {
  if (scene.images?.some((v) => v.id === version.id)) return scene
  const images = [...(scene.images ?? []), version]
  const keepOfficial = !!officialVersion(scene) && !!scene.imageApprovedAt
  return {
    ...scene,
    images,
    officialImageId: keepOfficial ? scene.officialImageId : version.id,
    imageApprovedAt: keepOfficial ? scene.imageApprovedAt : null,
  }
}

export function chooseOfficial(scene: StoryScene, versionId: string): StoryScene {
  if (!scene.images?.some((v) => v.id === versionId) || scene.officialImageId === versionId) return scene
  return { ...scene, officialImageId: versionId, imageApprovedAt: null }
}

export function approveImage(scene: StoryScene, now = Date.now()): StoryScene {
  return officialVersion(scene) ? { ...scene, imageApprovedAt: now } : scene
}

export function unapproveImage(scene: StoryScene): StoryScene {
  return scene.imageApprovedAt ? { ...scene, imageApprovedAt: null } : scene
}

// Última tarefa da cena no lote atual (se houver).
export function taskForScene(run: BatchRun | null | undefined, sceneId: string): BatchTask | undefined {
  if (!run) return undefined
  for (let i = run.tasks.length - 1; i >= 0; i--) if (run.tasks[i].sceneId === sceneId) return run.tasks[i]
  return undefined
}

export function sceneImageState(scene: StoryScene, run: BatchRun | null | undefined): SceneImageState {
  const task = taskForScene(run, scene.id)
  if (task && task.status !== 'done') return task.status
  if (officialVersion(scene)) return scene.imageApprovedAt ? 'approved' : 'done'
  return 'none'
}

// A cena mudou depois que a imagem oficial foi gerada?
export function isOutdated(scene: StoryScene, board: Storyboard): boolean {
  const official = officialVersion(scene)
  return !!official && official.sceneFingerprint !== sceneFingerprint(scene, board)
}
