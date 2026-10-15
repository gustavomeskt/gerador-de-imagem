import type { DBSchema } from 'idb'
import type { Edge } from '@xyflow/react'
import type { SceneImageVersion } from '../batch/types'

// Esquema do banco local (IndexedDB). Fica tudo no navegador: é um
// armazenamento LOCAL, não um backup — o navegador pode apagar os dados se
// faltar espaço ou se a pessoa limpar os dados do site. Por isso o app também
// exporta tudo em ZIP.

export const DB_NAME = 'image-flow-studio'
export const DB_VERSION = 1

// Versão do formato de cada projeto salvo — permite migrar no futuro.
export const PROJECT_SCHEMA_VERSION = 1

// Slot de imagem como fica salvo: só a referência pro arquivo (assetId), nunca
// os bytes nem a URL temporária usada na tela.
export interface PersistedSlot {
  id: string
  assetId: string
  aspect: number
}

// Nós/arestas no formato do React Flow. Os dados de cada nó são JSON livre
// aqui; quem tipa é o store.
export interface PersistedNode {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
  [key: string]: unknown
}

export interface ProjectRecord {
  schemaVersion: number
  id: string
  name: string
  createdAt: number
  updatedAt: number
  nodes: PersistedNode[]
  edges: Edge[]
  // guia de estilo do projeto (ausente em projetos antigos)
  styleGuide?: unknown
}

// Tipos de arquivo guardados. Só 'generated' é usado nesta etapa; os outros
// já ficam reservados pras bibliotecas de referências e personagens.
// 'scene' = imagem gerada para uma cena do storyboard (Etapa 6).
export type AssetKind = 'generated' | 'reference' | 'character' | 'scene'

// De onde veio uma imagem gerada — vai pro manifest.json da exportação.
export interface AssetSource {
  nodeId: string
  slotId: string
  prompt: string
  model: string
  size: string
  quality?: string
  provider: string
  // imagens de referência usadas nesta geração, na ordem enviada
  references?: Array<{ assetId?: string; sha256: string; label: string; role: string }>
  inputFidelity?: string
  // personagens da biblioteca usados, com a ficha COMO ESTAVA na geração —
  // editar ou excluir o personagem depois não apaga esse registro
  characters?: Array<{ characterId: string; version: number; sheet: Record<string, string>; sceneNote?: string; photoSha256: string[] }>
  styleGuideApplied?: boolean
}

// Referência enviada pela pessoa: a que nó pertence e o nome do arquivo.
export interface AssetReferenceInfo {
  nodeId: string
  name: string
}

// Foto de referência como fica salva no projeto (sem bytes nem URL).
export interface PersistedReferenceImage {
  id: string
  assetId: string
  name: string
  mimeType: string
  byteLength: number
  width: number
  height: number
  sha256: string
}

export interface AssetRecord {
  id: string
  projectId: string
  kind: AssetKind
  mimeType: string
  // bytes do arquivo. ArrayBuffer (e não Blob) por ser clonável em qualquer
  // ambiente, inclusive nos testes.
  bytes: ArrayBuffer
  byteLength: number
  width?: number
  height?: number
  createdAt: number
  source?: AssetSource
  // referências: hash do conteúdo (evita guardar a mesma foto duas vezes)
  sha256?: string
  reference?: AssetReferenceInfo
  // imagem de cena: a versão completa (cena, tarefa, prompt, referências) —
  // permite recuperar a imagem mesmo que o storyboard não tenha sido salvo
  sceneImage?: SceneImageVersion
}

// Registro genérico das bibliotecas futuras (personagens, storyboards, cenas,
// prompts e versões de imagem). As tabelas já existem no banco pra não
// precisar de migração de estrutura quando essas etapas chegarem; o conteúdo
// de `data` será definido em cada etapa.
export interface LibraryRecord {
  id: string
  projectId: string | null // null = item global (ex.: personagem reutilizável)
  createdAt: number
  updatedAt: number
  data: Record<string, unknown>
}

// Personagem como fica salvo na tabela "characters" (projectId = null:
// pertence à biblioteca, não a um projeto).
export interface PersistedCharacterPhoto {
  id: string
  assetId: string
  name: string
  mimeType: string
  byteLength: number
  width: number
  height: number
  sha256: string
}

export interface CharacterRecordData {
  sheet: Record<string, string>
  photos: PersistedCharacterPhoto[]
  primaryPhotoId: string
  version: number
}

export type LibraryStoreName = 'characters' | 'storyboards' | 'scenes' | 'prompts' | 'imageVersions'

export const LIBRARY_STORES: LibraryStoreName[] = ['characters', 'storyboards', 'scenes', 'prompts', 'imageVersions']

export interface MetaRecord {
  key: string
  value: unknown
}

export interface AppDB extends DBSchema {
  projects: { key: string; value: ProjectRecord; indexes: { byUpdatedAt: number } }
  assets: { key: string; value: AssetRecord; indexes: { byProject: string; byNode: string } }
  characters: { key: string; value: LibraryRecord; indexes: { byProject: string } }
  storyboards: { key: string; value: LibraryRecord; indexes: { byProject: string } }
  scenes: { key: string; value: LibraryRecord; indexes: { byProject: string } }
  prompts: { key: string; value: LibraryRecord; indexes: { byProject: string } }
  imageVersions: { key: string; value: LibraryRecord; indexes: { byProject: string } }
  meta: { key: string; value: MetaRecord }
}
