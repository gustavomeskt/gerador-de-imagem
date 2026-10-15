import { classifyGenerationError } from '../batch/errors'
import { officialVersion, planBatch, type BatchPlan } from '../batch/planner'
import { GenerationQueue, type TaskPatch } from '../batch/queue'
import type { BatchRun, BatchScope, BatchSettings, BatchTask, SceneImageVersion, TaskReference } from '../batch/types'
import { approveImage, chooseOfficial, unapproveImage, withNewVersion } from '../batch/versions'
import { getSizeOption } from '../generation/models'
import { getProvider } from '../generation/providers'
import { effectiveFidelity, REFERENCE_MIME_TYPES, type ReferenceImageInput, type ReferenceMimeType } from '../generation/references'
import { runGeneration } from '../generation/service'
import { ProviderError, type BatchImageJob, type CostQuote, type ImageProvider } from '../generation/types'
import { bytesToBase64, dataUrlToBytes, readImageSize, sha256Hex, toArrayBuffer } from '../lib/binary'
import { rasterizeToPng } from '../lib/rasterize'
import { getAssetUrl, releaseAssetUrl } from '../persistence/assetUrls'
import { repository } from '../persistence/repository'
import type { AssetRecord } from '../persistence/schema'
import type { Storyboard, StoryScene } from '../story/types'
import { useCharacterStore } from './useCharacterStore'
import { useFlowStore } from './useFlowStore'
import { flushStorySaves, useStoryStore } from './useStoryStore'

// Geração em lote das imagens do storyboard: planeja, pede orçamento e
// confirmação (provedor pago), executa a fila, salva cada imagem assim que
// ela chega e associa à cena certa (pelo id da tarefa + token da tentativa).
//
// O estado da fila fica no storyboard (salvo no banco). Este módulo guarda
// só o que não deve sobreviver a um recarregamento: a fila em execução e as
// autorizações de custo desta sessão.

export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  model: 'gpt-image-1.5',
  size: '1024x1536',
  quality: 'medium',
  inputFidelity: 'high',
  continuity: 'approved',
  concurrency: 2,
}

export const FORMAT_NOTE =
  'Gerada no formato vertical nativo do modelo (2:3), SEM recorte. O alvo é 9:16: o reenquadramento ou a expansão ' +
  'para 9:16 fica para uma próxima etapa, com conferência de rostos, mãos e objetos. As instruções já pedem a ação ' +
  'na área central vertical.'

export type StartResult = { ok: true; images: number; simulated: boolean } | { ok: false; cancelled?: boolean; error: string }

interface Engine {
  queue: GenerationQueue
  provider: ImageProvider
  authorized: Set<string> // tarefas com custo autorizado nesta sessão
  quoteOf: Map<string, string> // tarefa → orçamento confirmado
  chargeRisk: boolean
}

const engines = new Map<string, Engine>()

let idCounter = 0
function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

// --- ganchos para os testes ---
interface Hooks {
  provider?: ImageProvider
  rasterize?: (bytes: Uint8Array, mimeType: string) => Promise<Uint8Array>
  queue?: { baseDelayMs?: number; maxDelayMs?: number }
}
let hooks: Hooks = {}
export function setBatchHooksForTests(next: Hooks) {
  hooks = next
}

const story = () => useStoryStore.getState()
const boardOf = (projectId: string): Storyboard | undefined => story().boards[projectId]
const runOf = (projectId: string): BatchRun | null | undefined => boardOf(projectId)?.batch
const persistent = () => useFlowStore.getState().persistence === 'indexeddb'

function currentProvider(): ImageProvider {
  return hooks.provider ?? getProvider(useFlowStore.getState().providerKind)
}

function log(board: Storyboard, action: string, now = Date.now()): Storyboard {
  return { ...board, history: [...board.history, { at: now, action }].slice(-300), updatedAt: now }
}

function mutateRun(projectId: string, change: (run: BatchRun, board: Storyboard) => Storyboard | BatchRun) {
  story().mutate(
    projectId,
    (board) => {
      if (!board.batch) return board
      const result = change(board.batch, board)
      return 'tasks' in result ? { ...board, batch: { ...result, updatedAt: Date.now() } } : result
    },
    { prompts: false },
  )
}

function updateTask(projectId: string, taskId: string, patch: TaskPatch | Partial<BatchTask>) {
  mutateRun(projectId, (run) => ({ ...run, tasks: run.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) }))
}

// --- planejamento (mostrado no diálogo antes de gerar) ---

export function previewBatch(projectId: string, settings: BatchSettings, scope: BatchScope, selectedIds?: string[]): BatchPlan {
  const board = story().ensureBoard(projectId)
  return planBatch({
    board,
    library: useCharacterStore.getState().characters,
    style: useFlowStore.getState().flowsData[projectId]?.styleGuide,
    settings,
    scope,
    selectedIds,
    simulated: currentProvider().kind === 'mock',
    makeId: nextId,
  })
}

// --- custo: orçamento + confirmação explícita (só provedores que cobram) ---

function descriptorOf(r: TaskReference) {
  return { sha256: r.sha256!, mimeType: r.mimeType as ReferenceMimeType, byteLength: r.byteLength!, width: r.width!, height: r.height! }
}

export function batchJobFor(settings: BatchSettings, tasks: BatchTask[]): BatchImageJob {
  const anyRefs = tasks.some((t) => t.references.length > 0)
  const fidelity = anyRefs ? effectiveFidelity(settings.model, settings.inputFidelity) : undefined
  return {
    model: settings.model,
    size: settings.size,
    quality: settings.quality,
    ...(fidelity ? { inputFidelity: fidelity } : {}),
    items: tasks.map((t) => {
      const known = t.references.filter((r) => !r.deferred)
      const deferred = t.references.length - known.length
      return {
        prompt: t.prompt,
        ...(known.length ? { references: known.map(descriptorOf) } : {}),
        ...(deferred ? { deferredReferences: deferred } : {}),
      }
    }),
  }
}

// Pede o orçamento das tarefas e a confirmação. Provedor grátis: autoriza direto.
async function authorize(
  projectId: string,
  provider: ImageProvider,
  settings: BatchSettings,
  tasks: BatchTask[],
  title: string,
): Promise<{ ok: true; quote: CostQuote | null } | { ok: false; cancelled?: boolean; error: string }> {
  if (tasks.length === 0) return { ok: true, quote: null }
  if (!provider.quoteBatch) return { ok: true, quote: null }
  let quote: CostQuote
  try {
    quote = await provider.quoteBatch(batchJobFor(settings, tasks))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Não foi possível calcular o custo do lote.' }
  }
  if (!(await useFlowStore.getState().confirmCost(title, quote))) {
    return { ok: false, cancelled: true, error: 'Geração cancelada: nenhuma chamada paga foi feita.' }
  }
  const engine = ensureEngine(projectId, provider)
  engine.chargeRisk = quote.paid
  for (const t of tasks) {
    engine.authorized.add(t.id)
    engine.quoteOf.set(t.id, quote.quoteId)
  }
  return { ok: true, quote }
}

// --- execução de uma tarefa ---

async function loadBytes(ref: TaskReference, board: Storyboard): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
  if (ref.assetId && persistent()) {
    const asset = await repository.getAsset(ref.assetId)
    if (asset) return { bytes: new Uint8Array(asset.bytes), mimeType: asset.mimeType }
  }
  // sem banco: a foto/imagem só existe em memória (data URL)
  if (ref.kind === 'character') {
    const photo = useCharacterStore
      .getState()
      .characters.find((c) => c.id === ref.characterId)
      ?.photos.find((p) => p.id === ref.photoId)
    if (photo?.src?.startsWith('data:')) return dataUrlToBytes(photo.src)
  } else {
    const version = board.scenes.find((s) => s.id === ref.sceneId)?.images?.find((v) => v.id === ref.versionId)
    if (version?.src?.startsWith('data:')) return dataUrlToBytes(version.src)
  }
  return undefined
}

async function toInput(bytes: Uint8Array, mimeType: string, provider: ImageProvider): Promise<ReferenceImageInput> {
  let data = bytes
  let type = mimeType
  if (!(REFERENCE_MIME_TYPES as readonly string[]).includes(type)) {
    // imagem simulada (SVG): vira PNG para poder ir como referência
    try {
      data = await (hooks.rasterize ?? rasterizeToPng)(bytes, mimeType)
      type = 'image/png'
    } catch (err) {
      // o provedor simulado do navegador não confere o formato
      if (provider.kind !== 'mock') throw new Error(`não foi possível converter a imagem simulada da cena anterior (${(err as Error).message})`)
    }
  }
  const size = readImageSize(data, type)
  return {
    sha256: await sha256Hex(data),
    mimeType: type as ReferenceMimeType,
    byteLength: data.byteLength,
    width: size?.width ?? 1,
    height: size?.height ?? 1,
    b64: bytesToBase64(data),
  }
}

async function resolveReferences(projectId: string, task: BatchTask, provider: ImageProvider): Promise<{ inputs: ReferenceImageInput[]; resolved: TaskReference[] }> {
  const board = boardOf(projectId)!
  const run = board.batch!
  const inputs: ReferenceImageInput[] = []
  const resolved: TaskReference[] = []
  for (const ref of task.references) {
    let source = ref
    if (ref.fromTaskId) {
      // encadeada: a imagem que a tarefa anterior acabou de gerar
      const dep = run.tasks.find((t) => t.id === ref.fromTaskId)
      const version = board.scenes.find((s) => s.id === ref.sceneId)?.images?.find((v) => v.id === dep?.versionId)
      if (!version) throw new Error(`a imagem da ${ref.label}, usada como continuidade, não está disponível`)
      source = { ...ref, versionId: version.id, assetId: version.assetId }
    }
    const loaded = await loadBytes(source, board)
    if (!loaded) throw new Error(`a imagem de referência "${ref.label}" não foi encontrada no armazenamento`)
    const input = await toInput(loaded.bytes, loaded.mimeType, provider)
    inputs.push(input)
    resolved.push({ ...source, sha256: input.sha256, mimeType: input.mimeType, byteLength: input.byteLength, width: input.width, height: input.height })
  }
  return { inputs, resolved }
}

function isCurrent(projectId: string, runId: string, taskId: string, token: string): boolean {
  const run = runOf(projectId)
  const task = run?.tasks.find((t) => t.id === taskId)
  return !!run && run.id === runId && !!task && task.token === token && task.status === 'running'
}

async function executeTask(projectId: string, taskId: string, token: string): Promise<void> {
  const engine = engines.get(projectId)
  const run = runOf(projectId)
  const task = run?.tasks.find((t) => t.id === taskId)
  if (!engine || !run || !task) return
  const runId = run.id

  // reserva o id do arquivo e grava "gerando" ANTES da chamada: se o app
  // fechar no meio, ao reabrir dá para saber o que chegou a ser salvo
  const assetId = nextId('asset')
  updateTask(projectId, taskId, { pendingAssetId: assetId })
  await flushStorySaves()

  const { inputs, resolved } = await resolveReferences(projectId, task, engine.provider)
  const settings = run.settings
  const deferred = task.references.filter((r) => r.deferred).length
  const [result] = await runGeneration({
    provider: engine.provider,
    config: { model: settings.model, size: settings.size, quality: settings.quality },
    prompt: task.prompt,
    count: 1,
    // sem recorte: a imagem fica no formato nativo do modelo (ver FORMAT_NOTE)
    crop: async (src) => src,
    quoteId: engine.quoteOf.get(taskId),
    references: inputs,
    inputFidelity: inputs.length ? effectiveFidelity(settings.model, settings.inputFidelity) : undefined,
    deferredReferences: deferred || undefined,
  })
  if (!result.ok) throw result.cause ?? new ProviderError(result.error)
  if (!isCurrent(projectId, runId, taskId, token)) return // resposta de uma tentativa que já não vale

  const { bytes, mimeType } = dataUrlToBytes(result.image.src)
  const size = readImageSize(bytes, mimeType)
  const sizeOption = getSizeOption(settings.model, settings.size)
  const version: SceneImageVersion = {
    id: nextId('versao'),
    taskId,
    runId,
    mimeType,
    width: size?.width ?? null,
    height: size?.height ?? null,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    createdAt: Date.now(),
    model: settings.model,
    size: settings.size,
    quality: settings.quality,
    ...(inputs.length && settings.inputFidelity ? { inputFidelity: effectiveFidelity(settings.model, settings.inputFidelity) } : {}),
    provider: engine.provider.kind,
    simulated: run.simulated,
    prompt: task.prompt,
    references: resolved,
    characters: task.characters,
    sceneFingerprint: task.sceneFingerprint,
    format: {
      nativeWidth: size?.width ?? null,
      nativeHeight: size?.height ?? null,
      target: '9:16',
      cropped: false,
      note: sizeOption?.crop ? FORMAT_NOTE : 'Formato nativo do modelo, sem recorte.',
    },
  }

  let saved: SceneImageVersion = { ...version, src: result.image.src, unsaved: true }
  if (persistent()) {
    try {
      const asset: AssetRecord = {
        id: assetId,
        projectId,
        kind: 'scene',
        mimeType,
        bytes: toArrayBuffer(bytes),
        byteLength: bytes.byteLength,
        width: size?.width,
        height: size?.height,
        createdAt: version.createdAt,
        sha256: version.sha256,
        sceneImage: { ...version, assetId },
      }
      await repository.putAsset(asset)
      saved = { ...version, assetId }
      getAssetUrl(assetId, asset.bytes, mimeType)
    } catch (err) {
      useStoryStore.setState({ issue: `Imagem da cena ${task.sceneNumber} não pôde ser salva no navegador: ${(err as Error).message}` })
    }
  }

  if (!isCurrent(projectId, runId, taskId, token)) {
    if (saved.assetId) await discardAsset(saved.assetId)
    return
  }
  const scene = boardOf(projectId)?.scenes.find((s) => s.id === task.sceneId)
  if (!scene) {
    if (saved.assetId) await discardAsset(saved.assetId)
    updateTask(projectId, taskId, { status: 'failed', errorKind: 'stale', error: 'A cena foi removida do storyboard durante a geração.', finishedAt: Date.now() })
    return
  }
  story().mutate(
    projectId,
    (board) => {
      const n = board.scenes.findIndex((s) => s.id === task.sceneId) + 1
      const next: Storyboard = {
        ...board,
        scenes: board.scenes.map((s) => (s.id === task.sceneId ? withNewVersion(s, saved) : s)),
        batch: board.batch && {
          ...board.batch,
          updatedAt: Date.now(),
          tasks: board.batch.tasks.map((t) =>
            t.id === taskId ? { ...t, status: 'done' as const, versionId: saved.id, finishedAt: Date.now(), error: undefined, errorKind: undefined } : t,
          ),
        },
      }
      return log(next, `Imagem da cena ${n} gerada${run.simulated ? ' (simulada)' : ''}.`)
    },
    { prompts: false },
  )
}

async function discardAsset(assetId: string) {
  releaseAssetUrl(assetId)
  try {
    await repository.deleteAssets([assetId])
  } catch {
    // fica como arquivo solto; não afeta o storyboard
  }
}

// --- fila por projeto ---

function ensureEngine(projectId: string, provider: ImageProvider): Engine {
  const existing = engines.get(projectId)
  if (existing && existing.provider === provider) return existing
  existing?.queue.stop()
  const engine: Engine = {
    provider,
    authorized: new Set(),
    quoteOf: new Map(),
    chargeRisk: false,
    queue: null as unknown as GenerationQueue,
  }
  engine.queue = new GenerationQueue({
    getTasks: () => runOf(projectId)?.tasks ?? [],
    update: (taskId, patch) => updateTask(projectId, taskId, patch),
    execute: (taskId, token) => executeTask(projectId, taskId, token),
    classify: classifyGenerationError,
    concurrency: () => runOf(projectId)?.settings.concurrency ?? 1,
    canStart: (taskId) => !provider.quoteBatch || engine.authorized.has(taskId),
    chargeRisk: () => engine.chargeRisk,
    dependencyFailed: (_taskId, depId) => {
      const dep = runOf(projectId)?.tasks.find((t) => t.id === depId)
      return `Depende da imagem da cena ${dep?.sceneNumber ?? '?'} (continuidade), que não foi gerada.`
    },
    onIdle: () => finishRun(projectId),
    ...(hooks.queue ?? {}),
  })
  engines.set(projectId, engine)
  return engine
}

function finishRun(projectId: string) {
  const run = runOf(projectId)
  if (!run || run.state !== 'running') return
  const done = run.tasks.filter((t) => t.status === 'done').length
  const failed = run.tasks.filter((t) => t.status === 'failed').length
  const cancelled = run.tasks.filter((t) => t.status === 'cancelled').length
  mutateRun(projectId, (r, board) =>
    log(
      { ...board, batch: { ...r, state: 'finished', pausedReason: undefined, updatedAt: Date.now() } },
      `Lote encerrado: ${done} concluída(s), ${failed} com falha, ${cancelled} cancelada(s).`,
    ),
  )
}

function pendingUnauthorized(projectId: string): BatchTask[] {
  const engine = engines.get(projectId)
  return (runOf(projectId)?.tasks ?? []).filter((t) => t.status === 'pending' && !engine?.authorized.has(t.id))
}

// --- ações ---

export async function startBatch(projectId: string, settings: BatchSettings, scope: BatchScope, selectedIds?: string[]): Promise<StartResult> {
  const current = runOf(projectId)
  if (current && current.tasks.some((t) => t.status === 'running' || t.status === 'pending')) {
    return { ok: false, error: 'Já existe um lote com imagens pendentes. Retome, cancele as pendentes ou espere terminar.' }
  }
  const provider = currentProvider()
  const plan = previewBatch(projectId, settings, scope, selectedIds)
  if (plan.errors.length) return { ok: false, error: plan.errors.join(' ') }
  if (plan.tasks.length === 0) return { ok: false, error: 'Nenhuma cena pode ser gerada com estas opções (veja os motivos na lista).' }

  // a fila nova começa sem autorizações antigas
  engines.get(projectId)?.queue.stop()
  engines.delete(projectId)
  const auth = await authorize(projectId, provider, settings, plan.tasks, `Gerar ${plan.tasks.length} imagem(ns) do storyboard`)
  if (!auth.ok) return auth
  const simulated = provider.kind === 'mock' || auth.quote?.mode === 'simulated'
  const now = Date.now()
  const run: BatchRun = {
    id: nextId('lote'),
    createdAt: now,
    updatedAt: now,
    scope,
    settings,
    provider: provider.kind,
    simulated,
    estimatedUsd: auth.quote ? auth.quote.estimatedUsd : null,
    state: 'running',
    tasks: plan.tasks,
  }
  story().mutate(
    projectId,
    (board) => log({ ...board, batch: run }, `Lote iniciado: ${plan.tasks.length} imagem(ns)${simulated ? ' SIMULADAS (fictícias)' : ''}.`),
    { prompts: false },
  )
  const engine = ensureEngine(projectId, provider)
  if (!provider.quoteBatch) for (const t of plan.tasks) engine.authorized.add(t.id)
  engine.queue.start()
  return { ok: true, images: plan.tasks.length, simulated }
}

export function pauseBatch(projectId: string) {
  engines.get(projectId)?.queue.pause()
  mutateRun(projectId, (run) => (run.state === 'running' ? { ...run, state: 'paused', pausedReason: 'Pausado por você.' } : run))
}

// Retomar: tarefas sem autorização nesta sessão (ex.: depois de reabrir o
// app) passam por um NOVO orçamento e confirmação antes de qualquer chamada.
export async function resumeBatch(projectId: string, title = 'Retomar a geração das imagens'): Promise<StartResult> {
  const run = runOf(projectId)
  if (!run) return { ok: false, error: 'Nenhum lote para retomar.' }
  const provider = currentProvider()
  if (provider.kind !== run.provider) {
    return { ok: false, error: `Este lote foi criado com o provedor "${run.provider}". Volte a esse provedor em Configuração para retomar.` }
  }
  const engine = ensureEngine(projectId, provider)
  if (!provider.quoteBatch) {
    for (const t of run.tasks) if (t.status === 'pending') engine.authorized.add(t.id)
  } else {
    const auth = await authorize(projectId, provider, run.settings, pendingUnauthorized(projectId), title)
    if (!auth.ok) return auth
    if (auth.quote && auth.quote.mode === 'openai' && run.simulated) {
      return { ok: false, error: 'O servidor agora está em modo real, mas este lote é de imagens simuladas. Inicie um lote novo.' }
    }
  }
  mutateRun(projectId, (r) => ({ ...r, state: 'running', pausedReason: undefined }))
  engine.queue.start()
  return { ok: true, images: run.tasks.filter((t) => t.status === 'pending').length, simulated: run.simulated }
}

export function cancelPending(projectId: string) {
  const run = runOf(projectId)
  if (!run) return
  const count = run.tasks.filter((t) => t.status === 'pending').length
  mutateRun(projectId, (r, board) =>
    log(
      {
        ...board,
        batch: {
          ...r,
          tasks: r.tasks.map((t) => (t.status === 'pending' ? { ...t, status: 'cancelled' as const, error: undefined, finishedAt: Date.now() } : t)),
        },
      },
      `${count} imagem(ns) pendente(s) cancelada(s) (as que já estavam gerando terminam normalmente).`,
    ),
  )
  engines.get(projectId)?.queue.pump()
}

export async function retryFailed(projectId: string): Promise<StartResult> {
  const run = runOf(projectId)
  const failed = run?.tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled') ?? []
  if (!run || failed.length === 0) return { ok: false, error: 'Nenhuma imagem com falha para gerar de novo.' }
  const engine = engines.get(projectId)
  const ids = new Set(failed.map((t) => t.id))
  for (const id of ids) engine?.authorized.delete(id)
  mutateRun(projectId, (r) => ({
    ...r,
    tasks: r.tasks.map((t) =>
      ids.has(t.id) ? { ...t, status: 'pending' as const, attempts: 0, error: undefined, errorKind: undefined, token: undefined, nextAttemptAt: undefined } : t,
    ),
  }))
  const result = await resumeBatch(projectId, `Gerar de novo ${failed.length} imagem(ns) com falha`)
  if (!result.ok) {
    // sem autorização: voltam a ficar como estavam
    mutateRun(projectId, (r) => ({ ...r, tasks: r.tasks.map((t) => (ids.has(t.id) && t.status === 'pending' ? failed.find((f) => f.id === t.id)! : t)) }))
  }
  return result
}

// Regenera só a imagem de uma cena. A imagem anterior continua guardada; se
// a oficial já estava aprovada, ela continua oficial até a pessoa escolher.
export async function regenerateScene(projectId: string, sceneId: string): Promise<StartResult> {
  const run = runOf(projectId)
  if (run?.tasks.some((t) => t.sceneId === sceneId && (t.status === 'pending' || t.status === 'running'))) {
    return { ok: false, error: 'Esta cena já está na fila.' }
  }
  const settings: BatchSettings = { ...(run?.settings ?? DEFAULT_BATCH_SETTINGS) }
  // sozinha, a cena não espera outra: só usa imagens já aprovadas
  if (settings.continuity === 'chain') settings.continuity = 'approved'
  const provider = currentProvider()
  const plan = previewBatch(projectId, settings, 'single', [sceneId])
  const report = plan.scenes.find((s) => s.sceneId === sceneId)
  if (plan.errors.length) return { ok: false, error: plan.errors.join(' ') }
  if (plan.tasks.length === 0) return { ok: false, error: `Esta cena não pode ser gerada: ${[report?.reason, ...(report?.blocking ?? [])].filter(Boolean).join(' — ')}` }

  const auth = await authorize(projectId, provider, settings, plan.tasks, `Gerar de novo a imagem da cena ${plan.tasks[0].sceneNumber}`)
  if (!auth.ok) return auth
  const simulated = provider.kind === 'mock' || auth.quote?.mode === 'simulated'
  const reuse = run && run.provider === provider.kind && run.simulated === simulated && run.state !== 'cancelled'
  const now = Date.now()
  story().mutate(
    projectId,
    (board) => {
      const batch: BatchRun = reuse
        ? { ...board.batch!, state: 'running', pausedReason: undefined, updatedAt: now, tasks: [...board.batch!.tasks, ...plan.tasks] }
        : {
            id: nextId('lote'),
            createdAt: now,
            updatedAt: now,
            scope: 'single',
            settings,
            provider: provider.kind,
            simulated,
            estimatedUsd: auth.quote ? auth.quote.estimatedUsd : null,
            state: 'running',
            tasks: plan.tasks,
          }
      return log({ ...board, batch }, `Nova versão pedida para a imagem da cena ${plan.tasks[0].sceneNumber}.`)
    },
    { prompts: false },
  )
  const engine = ensureEngine(projectId, provider)
  if (!provider.quoteBatch) for (const t of plan.tasks) engine.authorized.add(t.id)
  engine.queue.start()
  return { ok: true, images: 1, simulated }
}

function mutateScene(projectId: string, sceneId: string, change: (s: StoryScene) => StoryScene, action: string) {
  story().mutate(
    projectId,
    (board) => {
      const scene = board.scenes.find((s) => s.id === sceneId)
      if (!scene) return board
      const next = change(scene)
      if (next === scene) return board
      return log({ ...board, scenes: board.scenes.map((s) => (s.id === sceneId ? next : s)) }, action.replace('{n}', String(board.scenes.indexOf(scene) + 1)))
    },
    { prompts: false },
  )
}

export function setOfficialImage(projectId: string, sceneId: string, versionId: string) {
  mutateScene(projectId, sceneId, (s) => chooseOfficial(s, versionId), 'Cena {n}: outra versão escolhida como imagem oficial.')
}

export function approveSceneImage(projectId: string, sceneId: string) {
  mutateScene(projectId, sceneId, (s) => approveImage(s), 'Imagem da cena {n} aprovada.')
}

export function unapproveSceneImage(projectId: string, sceneId: string) {
  mutateScene(projectId, sceneId, (s) => unapproveImage(s), 'Aprovação da imagem da cena {n} desfeita.')
}

export function isQueueActive(projectId: string): boolean {
  const engine = engines.get(projectId)
  return !!engine && !engine.queue.isPaused && (engine.queue.running > 0 || runOf(projectId)?.state === 'running')
}

export function hasOfficialImages(board: Storyboard): boolean {
  return board.scenes.some((s) => !!officialVersion(s))
}

// Projeto apagado: para a fila e esquece o storyboard em memória.
export function stopProject(projectId: string) {
  engines.get(projectId)?.queue.stop()
  engines.delete(projectId)
  story().forget(projectId)
}

// Só testes: esquece filas e autorizações (como ao recarregar a página).
export function resetBatchControllerForTests() {
  for (const e of engines.values()) e.queue.stop()
  engines.clear()
  hooks = {}
}

useFlowStore.subscribe((state, previous) => {
  if (state.flows === previous.flows) return
  const ids = new Set(state.flows.map((f) => f.id))
  for (const f of previous.flows) if (!ids.has(f.id)) stopProject(f.id)
})
