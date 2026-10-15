import { classifyGenerationError } from '../batch/errors'
import { officialVersion, planBatch, type BatchPlan } from '../batch/planner'
import { GenerationQueue, type TaskPatch } from '../batch/queue'
import type { BatchRun, BatchScope, BatchSettings, BatchTask, ImageAnalysis, ImageReview, ProblemTag, SceneImageVersion, TaskReference } from '../batch/types'
import { approveImage, chooseOfficial, unapproveImage, withNewVersion } from '../batch/versions'
import { getProvider } from '../generation/providers'
import { effectiveFidelity, REFERENCE_MIME_TYPES, type ReferenceImageInput, type ReferenceMimeType } from '../generation/references'
import { runGeneration } from '../generation/service'
import { ProviderError, type BatchImageJob, type CostQuote, type ImageProvider } from '../generation/types'
import { bytesToBase64, bytesToDataUrl, dataUrlToBytes, readImageSize, sha256Hex, toArrayBuffer } from '../lib/binary'
import { rasterizeToPng } from '../lib/rasterize'
import { analyzeImage, DUPLICATE_DISTANCE, hashDistance, type PixelStats } from '../lib/imageAnalysis'
import { emptyReview } from '../batch/review'
import { expandToFrame, reframeToFrame } from '../lib/image'
import { containRect, describeFormat, FORMAT_LABELS, isNineSixteen, MAX_REFRAME_LOSS, reframeRect, TARGET_HEIGHT, TARGET_WIDTH, type FormatMethod } from '../batch/format'
import { getAssetUrl, releaseAssetUrl } from '../persistence/assetUrls'
import { repository } from '../persistence/repository'
import type { AssetRecord } from '../persistence/schema'
import type { Storyboard, StoryScene } from '../story/types'
import { useCharacterStore } from './useCharacterStore'
import { useFlowStore } from './useFlowStore'
import { flushStorySaves, onProjectRemoved, useStoryStore } from './useStoryStore'

// Geração em lote das imagens do storyboard: planeja, pede orçamento e
// confirmação (provedor pago), executa a fila, salva cada imagem assim que
// ela chega e associa à cena certa (pelo id da tarefa + token da tentativa).
//
// O estado da fila fica no storyboard (salvo no banco). Este módulo guarda
// só o que não deve sobreviver a um recarregamento: a fila em execução e as
// autorizações de custo desta sessão.

// Padrão: gpt-image-2 em 1152×2048 (9:16 exato, nativo). Os modelos 1.x
// geram 2:3 e a versão 9:16 é criada por expansão (sem corte).
export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  model: 'gpt-image-2',
  size: '1152x2048',
  quality: 'medium',
  inputFidelity: 'high',
  continuity: 'approved',
  concurrency: 2,
  autoExpand: true,
}

export function formatNoteFor(settings: Pick<BatchSettings, 'model' | 'size' | 'autoExpand'>): string {
  const [w, h] = settings.size.split('x').map(Number)
  if (isNineSixteen(w, h)) return `${settings.size}: 9:16 nativo do modelo — sem corte, sem expansão.`
  return (
    `${settings.size}: este modelo não gera 9:16. A imagem vem em ${w}×${h}, SEM recorte` +
    (settings.autoExpand
      ? '; em seguida é criada automaticamente uma versão 9:16 expandida (imagem inteira + bordas preenchidas com a própria imagem desfocada). A original fica guardada.'
      : '; ajuste para 9:16 depois, imagem por imagem (expandir ou reenquadrar).')
  )
}

export type StartResult = { ok: true; images: number; simulated: boolean } | { ok: false; cancelled?: boolean; error: string }

interface Engine {
  queue: GenerationQueue
  provider: ImageProvider
  authorized: Set<string> // tarefas com custo autorizado nesta sessão
  quoteOf: Map<string, string> // tarefa → orçamento confirmado
  expiresAt: Map<string, number> // tarefa → validade do orçamento
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
  analyze?: (src: string) => Promise<PixelStats>
  provider?: ImageProvider
  renderFormat?: (src: string, method: 'expanded' | 'reframed', offset: number) => Promise<string>
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
  if (!(Date.parse(quote.expiresAt) > Date.now())) {
    return { ok: false, error: 'O orçamento venceu antes da confirmação. Nenhuma chamada foi feita — peça de novo.' }
  }
  const engine = ensureEngine(projectId, provider)
  engine.chargeRisk = quote.paid
  const expires = Date.parse(quote.expiresAt)
  for (const t of tasks) {
    engine.authorized.add(t.id)
    engine.quoteOf.set(t.id, quote.quoteId)
    engine.expiresAt.set(t.id, Number.isFinite(expires) ? expires : 0)
  }
  return { ok: true, quote }
}

// Autorização VÁLIDA para esta tarefa: o provedor simulado do navegador é
// grátis; os outros exigem um orçamento confirmado nesta sessão, para esta
// tarefa, e ainda dentro da validade. Conferido ao escolher a próxima tarefa
// E de novo dentro da execução, imediatamente antes da chamada.
function isAuthorized(engine: Engine, taskId: string, now = Date.now()): boolean {
  if (!engine.provider.quoteBatch) return true
  const expires = engine.expiresAt.get(taskId) ?? 0
  return engine.authorized.has(taskId) && !!engine.quoteOf.get(taskId) && expires > now
}

const NOT_AUTHORIZED = 'Imagem sem autorização de custo válida: nenhuma chamada foi feita. Peça um novo orçamento (Retomar).'

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
  if (!isAuthorized(engine, taskId)) throw new ProviderError(NOT_AUTHORIZED, { code: 'not_authorized' })
  const runId = run.id

  // reserva o id do arquivo e grava "gerando" ANTES da chamada: se o app
  // fechar no meio, ao reabrir dá para saber o que chegou a ser salvo
  const assetId = nextId('asset')
  updateTask(projectId, taskId, { pendingAssetId: assetId })
  await flushStorySaves()

  const { inputs, resolved } = await resolveReferences(projectId, task, engine.provider)
  const settings = run.settings
  const deferred = task.references.filter((r) => r.deferred).length
  // a autorização pode ter vencido ou sido retirada enquanto as fotos carregavam
  if (!isAuthorized(engine, taskId)) throw new ProviderError(NOT_AUTHORIZED, { code: 'not_authorized' })
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
      method: isNineSixteen(size?.width, size?.height) ? 'native' : 'unadjusted',
      nativeWidth: size?.width ?? null,
      nativeHeight: size?.height ?? null,
      target: '9:16',
      cropped: false,
      note: describeFormat(isNineSixteen(size?.width, size?.height) ? 'native' : 'unadjusted', { nativeWidth: size?.width, nativeHeight: size?.height }),
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
  await analyzeVersionPixels(projectId, task.sceneId, saved.id)
  if (settings.autoExpand && saved.format.method === 'unadjusted') {
    const r = await adjustFormat(projectId, task.sceneId, saved.id, 'expanded')
    if (!r.ok) useStoryStore.setState({ issue: `Cena ${task.sceneNumber}: não foi possível criar a versão 9:16 expandida (${r.error}). A imagem original foi mantida.` })
  }
}

// --- formato 9:16: versões derivadas (a original nunca é alterada) ---

export function formatMethodOf(version: SceneImageVersion): FormatMethod {
  return version.format.method ?? (isNineSixteen(version.width, version.height) ? 'native' : 'unadjusted')
}

async function versionBytes(version: SceneImageVersion): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
  if (version.assetId && persistent()) {
    const asset = await repository.getAsset(version.assetId)
    if (asset) return { bytes: new Uint8Array(asset.bytes), mimeType: asset.mimeType }
  }
  return version.src?.startsWith('data:') ? dataUrlToBytes(version.src) : undefined
}

export type AdjustResult = { ok: true; versionId: string; lossPercent?: number } | { ok: false; error: string; needsConfirmation?: boolean }

// Cria a versão 9:16 de uma imagem: 'expanded' (inteira, sem corte) ou
// 'reframed' (corte na posição escolhida; acima de MAX_REFRAME_LOSS só com
// confirmação). A nova versão vira a oficial se a de origem era a oficial;
// se a oficial estava APROVADA, a aprovação precisa ser refeita.
export async function adjustFormat(
  projectId: string,
  sceneId: string,
  versionId: string,
  method: 'expanded' | 'reframed',
  options: { offset?: number; confirmLoss?: boolean } = {},
): Promise<AdjustResult> {
  const scene = boardOf(projectId)?.scenes.find((s) => s.id === sceneId)
  const source = scene?.images?.find((v) => v.id === versionId)
  if (!scene || !source) return { ok: false, error: 'Imagem não encontrada.' }
  if (formatMethodOf(source) !== 'unadjusted') return { ok: false, error: 'Esta imagem já está em 9:16.' }
  const offset = options.offset ?? 0.5
  let lossPercent: number | undefined
  if (method === 'reframed') {
    lossPercent = reframeRect(source.width ?? 1, source.height ?? 1, offset).lossPercent
    if (lossPercent > MAX_REFRAME_LOSS && !options.confirmLoss) {
      return { ok: false, needsConfirmation: true, error: `O reenquadramento cortaria ${lossPercent}% da imagem. Prefira expandir, ou confirme o corte.` }
    }
  }
  const loaded = await versionBytes(source)
  if (!loaded) return { ok: false, error: 'O arquivo da imagem não foi encontrado no armazenamento.' }
  const src = bytesToDataUrl(loaded.bytes, loaded.mimeType)
  let out: string
  try {
    out = hooks.renderFormat
      ? await hooks.renderFormat(src, method, offset)
      : method === 'expanded'
        ? await expandToFrame(src, TARGET_WIDTH, TARGET_HEIGHT)
        : await reframeToFrame(src, offset, TARGET_WIDTH, TARGET_HEIGHT)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'falha ao ajustar a imagem' }
  }
  const { bytes, mimeType } = dataUrlToBytes(out)
  const size = readImageSize(bytes, mimeType)
  if (!isNineSixteen(size?.width, size?.height)) return { ok: false, error: 'O ajuste não resultou em 9:16 — nada foi salvo.' }
  const scale = source.width ? containRect(source.width, source.height ?? 1).scale : undefined
  const version: SceneImageVersion = {
    ...source,
    id: nextId('versao'),
    assetId: undefined,
    src: undefined,
    unsaved: undefined,
    review: undefined,
    analysis: undefined,
    derivedFrom: source.id,
    mimeType,
    width: size?.width ?? null,
    height: size?.height ?? null,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    createdAt: Date.now(),
    format: {
      method,
      nativeWidth: source.width,
      nativeHeight: source.height,
      target: '9:16',
      cropped: method === 'reframed',
      ...(lossPercent !== undefined ? { lossPercent } : {}),
      ...(method === 'expanded' && scale ? { scale: Math.round(scale * 1000) / 1000 } : {}),
      note: describeFormat(method, { lossPercent, nativeWidth: source.width, nativeHeight: source.height }),
    },
  }
  let saved: SceneImageVersion = { ...version, src: out, unsaved: true }
  if (persistent()) {
    try {
      const assetId = nextId('asset')
      await repository.putAsset({
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
      })
      saved = { ...version, assetId }
    } catch (err) {
      useStoryStore.setState({ issue: `A versão 9:16 não pôde ser salva no navegador: ${(err as Error).message}` })
    }
  }
  story().mutate(
    projectId,
    (board) => {
      const n = board.scenes.findIndex((s) => s.id === sceneId) + 1
      if (n === 0) return board
      const scenes = board.scenes.map((s) => {
        if (s.id !== sceneId) return s
        const wasOfficial = s.officialImageId === source.id
        return {
          ...s,
          images: [...(s.images ?? []), saved],
          officialImageId: wasOfficial ? saved.id : s.officialImageId,
          imageApprovedAt: wasOfficial ? null : s.imageApprovedAt,
        }
      })
      return log({ ...board, scenes }, `Cena ${n}: versão ${FORMAT_LABELS[method]} criada a partir da imagem ${source.width}×${source.height}.`)
    },
    { prompts: false },
  )
  await analyzeVersionPixels(projectId, sceneId, saved.id)
  return { ok: true, versionId: saved.id, ...(lossPercent !== undefined ? { lossPercent } : {}) }
}

// --- análise dos pixels (indicadores técnicos) ---

function updateVersion(projectId: string, sceneId: string, versionId: string, change: (v: SceneImageVersion) => SceneImageVersion) {
  story().mutate(
    projectId,
    (board) => ({
      ...board,
      scenes: board.scenes.map((s) =>
        s.id === sceneId ? { ...s, images: s.images?.map((v) => (v.id === versionId ? change(v) : v)) } : s,
      ),
    }),
    { prompts: false },
  )
}

export async function analyzeVersionPixels(projectId: string, sceneId: string, versionId: string): Promise<void> {
  const board = boardOf(projectId)
  const index = board?.scenes.findIndex((s) => s.id === sceneId) ?? -1
  const scene = board?.scenes[index]
  const version = scene?.images?.find((v) => v.id === versionId)
  if (!board || !scene || !version) return
  let analysis: ImageAnalysis
  try {
    const loaded = await versionBytes(version)
    if (!loaded) throw new Error('arquivo não encontrado')
    const stats = await (hooks.analyze ?? analyzeImage)(bytesToDataUrl(loaded.bytes, loaded.mimeType))
    analysis = {
      measuredAt: Date.now(),
      width: stats.width,
      height: stats.height,
      aspectOk: isNineSixteen(stats.width, stats.height),
      blank: stats.stdLuma < 3,
      meanLuma: stats.meanLuma,
      hash: stats.hash,
    }
    // cena anterior APROVADA com algum personagem em comum
    const current = boardOf(projectId)!
    for (let i = index - 1; i >= 0; i--) {
      const prev = current.scenes[i]
      const prevOfficial = officialVersion(prev)
      if (!prev.imageApprovedAt || !prevOfficial?.analysis?.hash) continue
      if (!prev.characterKeys.some((k) => scene.characterKeys.includes(k))) continue
      analysis.similarToPrevious = { sceneNumber: i + 1, distance: hashDistance(stats.hash, prevOfficial.analysis.hash) }
      break
    }
    // imagem quase idêntica à de outra cena
    current.scenes.forEach((other, i) => {
      if (analysis.duplicateOf || other.id === sceneId) return
      const h = officialVersion(other)?.analysis?.hash
      if (h && hashDistance(stats.hash, h) <= DUPLICATE_DISTANCE) analysis.duplicateOf = i + 1
    })
  } catch (err) {
    analysis = {
      measuredAt: Date.now(),
      width: version.width ?? 0,
      height: version.height ?? 0,
      aspectOk: isNineSixteen(version.width, version.height),
      blank: false,
      meanLuma: 0,
      hash: '',
      unavailable: err instanceof Error ? err.message : 'falha na análise',
    }
  }
  updateVersion(projectId, sceneId, versionId, (v) => ({ ...v, analysis }))
}

// --- revisão humana ---

export type ReviewResult = { ok: true } | { ok: false; needsConfirmation?: boolean; error: string }

export function reviewImage(projectId: string, sceneId: string, versionId: string, patch: Partial<Omit<ImageReview, 'status'>>) {
  updateVersion(projectId, sceneId, versionId, (v) => ({ ...v, review: { ...(v.review ?? emptyReview()), ...patch } }))
}

// Aprova uma versão e a torna oficial. Se outra versão já estava aprovada
// como oficial, exige confirmação explícita.
export function approveVersion(projectId: string, sceneId: string, versionId: string, options: { confirmReplace?: boolean } = {}): ReviewResult {
  const scene = boardOf(projectId)?.scenes.find((s) => s.id === sceneId)
  if (!scene?.images?.some((v) => v.id === versionId)) return { ok: false, error: 'Imagem não encontrada.' }
  if (scene.imageApprovedAt && scene.officialImageId !== versionId && !options.confirmReplace) {
    return { ok: false, needsConfirmation: true, error: 'Já existe uma imagem oficial aprovada nesta cena. Confirme para trocar (a atual continua guardada).' }
  }
  const now = Date.now()
  story().mutate(
    projectId,
    (board) => {
      const n = board.scenes.findIndex((s) => s.id === sceneId) + 1
      return log(
        {
          ...board,
          scenes: board.scenes.map((s) =>
            s.id !== sceneId
              ? s
              : {
                  ...s,
                  officialImageId: versionId,
                  imageApprovedAt: now,
                  images: s.images!.map((v) => (v.id === versionId ? { ...v, review: { ...(v.review ?? emptyReview()), status: 'approved' as const, reviewedAt: now } } : v)),
                },
          ),
        },
        `Imagem da cena ${n} aprovada na revisão.`,
      )
    },
    { prompts: false },
  )
  return { ok: true }
}

// Rejeita uma versão (com os problemas marcados). Rejeitar a oficial já
// aprovada exige confirmação; a imagem continua guardada.
export function rejectVersion(
  projectId: string,
  sceneId: string,
  versionId: string,
  problems: ProblemTag[],
  note = '',
  options: { confirmApproved?: boolean } = {},
): ReviewResult {
  const scene = boardOf(projectId)?.scenes.find((s) => s.id === sceneId)
  if (!scene?.images?.some((v) => v.id === versionId)) return { ok: false, error: 'Imagem não encontrada.' }
  const isOfficialApproved = scene.officialImageId === versionId && !!scene.imageApprovedAt
  if (isOfficialApproved && !options.confirmApproved) {
    return { ok: false, needsConfirmation: true, error: 'Esta é a imagem oficial aprovada. Confirme para rejeitá-la.' }
  }
  const now = Date.now()
  story().mutate(
    projectId,
    (board) => {
      const n = board.scenes.findIndex((s) => s.id === sceneId) + 1
      return log(
        {
          ...board,
          scenes: board.scenes.map((s) =>
            s.id !== sceneId
              ? s
              : {
                  ...s,
                  imageApprovedAt: s.officialImageId === versionId ? null : s.imageApprovedAt,
                  images: s.images!.map((v) =>
                    v.id === versionId ? { ...v, review: { ...(v.review ?? emptyReview()), status: 'rejected' as const, problems, note, reviewedAt: now } } : v,
                  ),
                },
          ),
        },
        `Imagem da cena ${n} rejeitada${problems.length ? ` (${problems.length} problema(s))` : ''}.`,
      )
    },
    { prompts: false },
  )
  return { ok: true }
}

// Expande para 9:16 todas as imagens oficiais que ainda não estão em 9:16.
// Imagens APROVADAS ficam de fora (trocar exige decisão individual).
export async function expandAllUnadjusted(projectId: string): Promise<{ done: number; skippedApproved: number; failed: string[] }> {
  const board = boardOf(projectId)
  const result = { done: 0, skippedApproved: 0, failed: [] as string[] }
  if (!board) return result
  for (const [i, scene] of board.scenes.entries()) {
    const official = officialVersion(scene)
    if (!official || formatMethodOf(official) !== 'unadjusted') continue
    if (scene.imageApprovedAt) {
      result.skippedApproved += 1
      continue
    }
    const r = await adjustFormat(projectId, scene.id, official.id, 'expanded')
    if (r.ok) result.done += 1
    else result.failed.push(`Cena ${i + 1}: ${r.error}`)
  }
  return result
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
    expiresAt: new Map(),
    chargeRisk: false,
    queue: null as unknown as GenerationQueue,
  }
  engine.queue = new GenerationQueue({
    getTasks: () => runOf(projectId)?.tasks ?? [],
    update: (taskId, patch) => updateTask(projectId, taskId, patch),
    execute: (taskId, token) => executeTask(projectId, taskId, token),
    classify: classifyGenerationError,
    concurrency: () => runOf(projectId)?.settings.concurrency ?? 1,
    canStart: (taskId) => isAuthorized(engine, taskId),
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
  const scene = boardOf(projectId)?.scenes.find((s) => s.id === sceneId)
  if (scene?.officialImageId) approveVersion(projectId, sceneId, scene.officialImageId, { confirmReplace: true })
  else mutateScene(projectId, sceneId, (s) => approveImage(s), 'Imagem da cena {n} aprovada.')
}

export function unapproveSceneImage(projectId: string, sceneId: string) {
  mutateScene(
    projectId,
    sceneId,
    (s) => {
      const next = unapproveImage(s)
      return next === s
        ? s
        : { ...next, images: next.images?.map((v) => (v.id === s.officialImageId && v.review?.status === 'approved' ? { ...v, review: { ...v.review, status: 'pending' as const } } : v)) }
    },
    'Aprovação da imagem da cena {n} desfeita.',
  )
}

export function isQueueActive(projectId: string): boolean {
  const engine = engines.get(projectId)
  return !!engine && !engine.queue.isPaused && (engine.queue.running > 0 || runOf(projectId)?.state === 'running')
}

export function hasOfficialImages(board: Storyboard): boolean {
  return board.scenes.some((s) => !!officialVersion(s))
}

// Só testes: esquece filas e autorizações (como ao recarregar a página).
export function resetBatchControllerForTests() {
  for (const e of engines.values()) e.queue.stop()
  engines.clear()
  hooks = {}
}

// projeto apagado (o aviso vem do store da historinha, que está sempre carregado)
onProjectRemoved((projectId) => {
  engines.get(projectId)?.queue.stop()
  engines.delete(projectId)
})

// Só testes: executa uma tarefa diretamente (para provar que a própria
// execução recusa tarefas sem autorização, mesmo fora da fila).
export const executeTaskForTests = executeTask
