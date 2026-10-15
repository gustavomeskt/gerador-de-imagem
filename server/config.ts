import { isImageModel, MODEL_LABELS, type ImageModel } from '../src/generation/models'
import { DEFAULT_MAX_REFERENCE_BYTES, DEFAULT_MAX_REFERENCES, REFERENCE_SUPPORT } from '../src/generation/references'

// Configuração do servidor, lida SÓ de variáveis de ambiente (arquivo .env na
// raiz, que não vai pro repositório). Os padrões são os mais seguros:
// modo simulado, só aceita conexões do próprio computador e limites de
// consumo baixos.

export type BackendMode = 'simulated' | 'openai'

export interface ServerConfig {
  mode: BackendMode
  // a chave fica só aqui, no processo do servidor. Nunca é devolvida em
  // nenhuma resposta nem escrita em log.
  openaiApiKey: string | undefined
  openaiBaseUrl: string
  host: string
  port: number
  allowedOrigins: string[]
  allowedModels: ImageModel[]
  maxBodyBytes: number
  // geração com referências (fotos em base64): limite maior, calculado a
  // partir do número e do tamanho máximo das referências
  maxEditBodyBytes: number
  maxReferenceImages: number
  maxReferenceBytes: number
  imageTimeoutMs: number
  textTimeoutMs: number
  maxConcurrent: number
  maxQueued: number
  maxRequestsPerMinute: number
  maxImagesPerJob: number
  maxCostPerJobUsd: number
  dailyImageLimit: number
  dailyBudgetUsd: number
  quoteTtlMs: number
  dataDir: string
  priceTableFile: string | undefined
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

type Env = Record<string, string | undefined>

function readNumber(env: Env, name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} inválido: "${raw}" (esperado um número entre ${min} e ${max}).`)
  }
  return value
}

function readList(env: Env, name: string): string[] | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const modeRaw = (env.IMAGE_BACKEND_MODE ?? 'simulated').trim().toLowerCase()
  if (modeRaw !== 'simulated' && modeRaw !== 'openai') {
    throw new ConfigError(`IMAGE_BACKEND_MODE inválido: "${modeRaw}" (use "simulated" ou "openai").`)
  }
  const mode: BackendMode = modeRaw

  const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined
  if (mode === 'openai' && !openaiApiKey) {
    throw new ConfigError('IMAGE_BACKEND_MODE=openai exige OPENAI_API_KEY no arquivo .env do servidor.')
  }

  const host = (env.HOST ?? '127.0.0.1').trim()
  // sem autenticação, o servidor NUNCA escuta em interfaces de rede — só no
  // próprio computador. Expor na rede exige uma etapa futura com login,
  // autorização por usuário e controle de consumo por pessoa.
  if (!isLoopbackHost(host)) {
    throw new ConfigError(
      `HOST="${host}" recusado: este servidor não tem autenticação e só pode escutar em 127.0.0.1, ::1 ou localhost.`,
    )
  }

  const port = readNumber(env, 'PORT', 8787, { min: 1, max: 65535 })

  const allowedModelsRaw = readList(env, 'ALLOWED_MODELS')
  const allowedModels = (allowedModelsRaw ?? (Object.keys(MODEL_LABELS) as ImageModel[])).map((m) => {
    if (!isImageModel(m)) throw new ConfigError(`ALLOWED_MODELS contém modelo desconhecido: "${m}".`)
    return m
  })
  if (allowedModels.length === 0) throw new ConfigError('ALLOWED_MODELS não pode ficar vazio.')

  const allowedOrigins = readList(env, 'ALLOWED_ORIGINS') ?? [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]

  const maxReferenceImages = readNumber(env, 'MAX_REFERENCE_IMAGES', DEFAULT_MAX_REFERENCES, { min: 1, max: 16 })
  const maxReferenceBytes =
    readNumber(env, 'MAX_REFERENCE_FILE_MB', DEFAULT_MAX_REFERENCE_BYTES / 1024 / 1024, { min: 0.1, max: 50 }) * 1024 * 1024
  // base64 ocupa 4/3 do tamanho original, + folga pro resto do JSON
  const computedEditLimit = Math.ceil((maxReferenceImages * maxReferenceBytes * 4) / 3) + 1024 * 1024

  return {
    mode,
    openaiApiKey,
    openaiBaseUrl: (env.OPENAI_BASE_URL ?? 'https://api.openai.com').trim().replace(/\/+$/, ''),
    host,
    port,
    allowedOrigins,
    allowedModels,
    maxBodyBytes: readNumber(env, 'MAX_BODY_BYTES', 128 * 1024, { min: 1024, max: 50 * 1024 * 1024 }),
    maxEditBodyBytes: readNumber(env, 'MAX_EDIT_BODY_BYTES', computedEditLimit, { min: 1024, max: 1100 * 1024 * 1024 }),
    maxReferenceImages,
    maxReferenceBytes,
    imageTimeoutMs: readNumber(env, 'OPENAI_IMAGE_TIMEOUT_MS', 180_000, { min: 1000, max: 600_000 }),
    textTimeoutMs: readNumber(env, 'OPENAI_TEXT_TIMEOUT_MS', 60_000, { min: 1000, max: 600_000 }),
    maxConcurrent: readNumber(env, 'MAX_CONCURRENT_REQUESTS', 2, { min: 1, max: 20 }),
    maxQueued: readNumber(env, 'MAX_QUEUED_REQUESTS', 8, { min: 0, max: 200 }),
    maxRequestsPerMinute: readNumber(env, 'MAX_REQUESTS_PER_MINUTE', 20, { min: 1, max: 1000 }),
    maxImagesPerJob: readNumber(env, 'MAX_IMAGES_PER_JOB', 10, { min: 1, max: 100 }),
    maxCostPerJobUsd: readNumber(env, 'MAX_COST_PER_JOB_USD', 2, { min: 0, max: 1000 }),
    dailyImageLimit: readNumber(env, 'DAILY_IMAGE_LIMIT', 50, { min: 0, max: 100_000 }),
    dailyBudgetUsd: readNumber(env, 'DAILY_BUDGET_USD', 5, { min: 0, max: 100_000 }),
    quoteTtlMs: readNumber(env, 'QUOTE_TTL_SECONDS', 600, { min: 10, max: 86_400 }) * 1000,
    dataDir: (env.SERVER_DATA_DIR ?? 'server/.data').trim(),
    priceTableFile: env.PRICE_TABLE_FILE?.trim() || undefined,
  }
}

// Visão da configuração que pode ser mostrada na tela: sem a chave, só se
// ela existe.
export function publicConfig(config: ServerConfig) {
  return {
    mode: config.mode,
    keyConfigured: !!config.openaiApiKey,
    allowedModels: config.allowedModels,
    limits: {
      maxConcurrent: config.maxConcurrent,
      maxQueued: config.maxQueued,
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      maxImagesPerJob: config.maxImagesPerJob,
      maxCostPerJobUsd: config.maxCostPerJobUsd,
      dailyImageLimit: config.dailyImageLimit,
      dailyBudgetUsd: config.dailyBudgetUsd,
      quoteTtlSeconds: config.quoteTtlMs / 1000,
      maxBodyBytes: config.maxBodyBytes,
      maxReferenceImages: config.maxReferenceImages,
      maxReferenceBytes: config.maxReferenceBytes,
    },
    referenceModels: config.allowedModels.filter((m) => REFERENCE_SUPPORT[m] !== null),
  }
}
