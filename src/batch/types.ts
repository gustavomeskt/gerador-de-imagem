import type { ImageModel } from '../generation/models'
import type { InputFidelity } from '../generation/references'
import type { ProviderKind } from '../generation/types'

// Geração em lote a partir do storyboard: uma tarefa por cena, cada uma com o
// prompt e as referências daquela cena "congelados" no momento do
// planejamento (é exatamente isso que foi orçado e confirmado).

export type ImageTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

// Estado da imagem de uma cena, como aparece na tela.
export type SceneImageState = ImageTaskStatus | 'approved' | 'none'

export const IMAGE_STATE_LABELS: Record<SceneImageState, string> = {
  none: 'Sem imagem',
  pending: 'Pendente',
  running: 'Gerando',
  done: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  approved: 'Aprovada',
}

// Imagens de cenas anteriores como referência de continuidade:
//   off      — nenhuma
//   approved — só imagens já APROVADAS (as cenas não dependem umas das outras)
//   chain    — a cena espera a cena anterior do mesmo ambiente/personagem ser
//              gerada neste lote e usa o resultado (geração em sequência)
export type ContinuityMode = 'off' | 'approved' | 'chain'

export const CONTINUITY_LABELS: Record<ContinuityMode, string> = {
  off: 'Não usar imagens de outras cenas',
  approved: 'Usar imagens já aprovadas de cenas anteriores (recomendado)',
  chain: 'Encadear: esperar a cena anterior e usar a imagem dela (mais lento, em sequência)',
}

export type BatchScope = 'all' | 'pending' | 'selected' | 'single'

export interface BatchSettings {
  model: ImageModel
  size: string
  quality: string
  inputFidelity?: InputFidelity
  continuity: ContinuityMode
  concurrency: number
}

// Uma imagem anexada ao pedido de uma cena.
export interface TaskReference {
  kind: 'character' | 'continuity'
  label: string
  characterId?: string
  characterVersion?: number
  photoId?: string
  sceneId?: string // continuidade: de qual cena
  versionId?: string // continuidade: qual versão (imagem já existente)
  assetId?: string
  sha256?: string
  mimeType?: string
  byteLength?: number
  width?: number
  height?: number
  // continuidade "encadeada": a imagem vem do resultado desta tarefa
  fromTaskId?: string
  // o conteúdo não é conhecido no orçamento (cena do mesmo lote, ou imagem
  // simulada que precisa ser convertida): autoriza-se só a quantidade
  deferred?: boolean
}

export type TaskErrorKind = 'transient' | 'permanent' | 'uncertain' | 'dependency' | 'interrupted' | 'stale'

export interface BatchTask {
  id: string
  sceneId: string
  sceneNumber: number
  prompt: string
  references: TaskReference[]
  dependsOn: string[]
  status: ImageTaskStatus
  attempts: number
  error?: string
  errorKind?: TaskErrorKind
  nextAttemptAt?: number
  startedAt?: number
  finishedAt?: number
  versionId?: string
  token?: string // muda a cada tentativa: resposta atrasada de outra tentativa é ignorada
  pendingAssetId?: string // id reservado para o arquivo desta tentativa (recuperação)
  sceneFingerprint: string
  characters: Array<{ characterId: string; name: string; version: number; sheet: Record<string, string> }>
}

export interface BatchRun {
  id: string
  createdAt: number
  updatedAt: number
  scope: BatchScope
  settings: BatchSettings
  provider: ProviderKind
  simulated: boolean // imagens fictícias (provedor simulado ou servidor em modo simulado)
  estimatedUsd: number | null
  state: 'running' | 'paused' | 'finished' | 'cancelled'
  pausedReason?: string
  tasks: BatchTask[]
}

export interface ImageFormatInfo {
  nativeWidth: number | null
  nativeHeight: number | null
  target: '9:16'
  cropped: false
  note: string
}

export interface SceneImageVersion {
  id: string
  taskId: string
  runId: string
  assetId?: string
  src?: string // só em memória (imagem não salva no banco)
  unsaved?: boolean
  mimeType: string
  width: number | null
  height: number | null
  byteLength: number
  sha256: string
  createdAt: number
  model: string
  size: string
  quality: string
  inputFidelity?: string
  provider: ProviderKind
  simulated: boolean
  prompt: string
  references: TaskReference[]
  characters: BatchTask['characters']
  sceneFingerprint: string
  format: ImageFormatInfo
}
