import type { AssetRecord } from '../persistence/schema'
import type { Storyboard } from '../story/types'
import { withNewVersion } from './versions'

// Ao reabrir o app: o lote que estava rodando é PAUSADO (nada recomeça
// sozinho). Cada tarefa que estava "gerando" é conferida:
//   • se o arquivo dela chegou a ser salvo, a imagem é recuperada;
//   • senão, fica como "interrompida" — a pessoa decide se gera de novo.

export const INTERRUPTED_PAUSE_REASON =
  'O aplicativo foi fechado durante a geração. Nada foi retomado automaticamente — confira e clique em "Retomar".'

export async function recoverInterruptedRun(
  board: Storyboard,
  loadAsset: (id: string) => Promise<AssetRecord | undefined>,
  now = Date.now(),
): Promise<{ board: Storyboard; recovered: number; interrupted: number }> {
  const run = board.batch
  if (!run || (!run.tasks.some((t) => t.status === 'running') && run.state !== 'running')) {
    return { board, recovered: 0, interrupted: 0 }
  }
  let scenes = board.scenes
  let recovered = 0
  let interrupted = 0
  const tasks = []
  for (const task of run.tasks) {
    if (task.status === 'pending' && task.nextAttemptAt) {
      tasks.push({ ...task, nextAttemptAt: undefined })
      continue
    }
    if (task.status !== 'running') {
      tasks.push(task)
      continue
    }
    const asset = task.pendingAssetId ? await loadAsset(task.pendingAssetId).catch(() => undefined) : undefined
    const version = asset?.sceneImage
    const scene = scenes.find((s) => s.id === task.sceneId)
    if (version && version.taskId === task.id && scene) {
      scenes = scenes.map((s) => (s.id === scene.id ? withNewVersion(s, version) : s))
      tasks.push({ ...task, status: 'done' as const, versionId: version.id, finishedAt: version.createdAt, token: undefined })
      recovered += 1
    } else {
      tasks.push({
        ...task,
        status: 'failed' as const,
        errorKind: 'interrupted' as const,
        token: undefined,
        finishedAt: now,
        error: run.simulated
          ? 'Interrompida ao fechar o aplicativo (imagem simulada, sem custo). Gere de novo.'
          : 'Interrompida ao fechar o aplicativo: a chamada pode ter sido processada e cobrada. Confira o consumo antes de gerar de novo.',
      })
      interrupted += 1
    }
  }
  const hasPending = tasks.some((t) => t.status === 'pending')
  const history = [...board.history]
  if (recovered || interrupted) {
    history.push({ at: now, action: `Ao reabrir: ${recovered} imagem(ns) recuperada(s), ${interrupted} geração(ões) interrompida(s).` })
  }
  return {
    board: {
      ...board,
      scenes,
      history,
      batch: {
        ...run,
        tasks,
        state: hasPending ? 'paused' : 'finished',
        pausedReason: hasPending || interrupted ? INTERRUPTED_PAUSE_REASON : undefined,
        updatedAt: now,
      },
    },
    recovered,
    interrupted,
  }
}
