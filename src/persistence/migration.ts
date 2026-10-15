import { loadFlowsRaw } from '../lib/storage'
import { repository } from './repository'
import { PROJECT_SCHEMA_VERSION, type PersistedNode, type ProjectRecord } from './schema'

// Migração única dos fluxos que ficavam no localStorage (versão anterior do
// app) para o IndexedDB. Os dados antigos NÃO são apagados: continuam no
// localStorage como cópia de segurança.

export const LEGACY_MIGRATION_KEY = 'legacyLocalStorageMigration'

// ids antigos têm o formato "flow-<timestamp>-<n>" — usamos o timestamp como
// data de criação pra manter a ordem original dos fluxos
export function createdAtFromId(id: string, fallback: number): number {
  const ts = Number(/^[a-z]+-(\d{10,})-/.exec(id)?.[1])
  return Number.isFinite(ts) && ts > 0 ? ts : fallback
}

export function legacyFlowToProject(raw: unknown): ProjectRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const flow = raw as Record<string, unknown>
  if (typeof flow.id !== 'string' || !flow.id) return null

  const updatedAt = typeof flow.updatedAt === 'number' ? flow.updatedAt : Date.now()
  const nodes = Array.isArray(flow.nodes) ? (flow.nodes as PersistedNode[]) : []
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: flow.id,
    name: typeof flow.name === 'string' && flow.name.trim() ? flow.name : 'Sem nome',
    createdAt: createdAtFromId(flow.id, updatedAt),
    updatedAt,
    // a versão antiga nunca salvava imagens; garante a lista vazia
    nodes: nodes.map((n) =>
      n?.type === 'image' ? { ...n, data: { ...n.data, images: [], notice: undefined } } : n,
    ),
    edges: Array.isArray(flow.edges) ? (flow.edges as ProjectRecord['edges']) : [],
  }
}

// Devolve quantos fluxos foram importados (0 se a migração já tinha rodado).
export async function migrateLegacyFlows(): Promise<number> {
  const done = await repository.getMeta(LEGACY_MIGRATION_KEY)
  if (done) return 0

  const existingIds = new Set((await repository.listProjects()).map((p) => p.id))
  const projects = Object.values(loadFlowsRaw())
    .map(legacyFlowToProject)
    .filter((p): p is ProjectRecord => !!p && !existingIds.has(p.id))

  await repository.saveProjects(projects)
  await repository.setMeta(LEGACY_MIGRATION_KEY, { migratedAt: Date.now(), count: projects.length })
  return projects.length
}
