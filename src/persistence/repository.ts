import { getDb } from './db'
import { toStorageError } from './errors'
import { LIBRARY_STORES, type AssetRecord, type CharacterRecordData, type LibraryRecord, type ProjectRecord } from './schema'

export type CharacterRecord = LibraryRecord & { data: CharacterRecordData & Record<string, unknown> }

// Acesso ao banco local. Toda falha vira StorageError com mensagem clara
// (falta de espaço, banco indisponível, erro de gravação).
//
// É um objeto (e não funções soltas) pra que os testes possam simular falhas
// trocando um método.

async function run<T>(kind: 'read' | 'write', action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (err) {
    throw toStorageError(err, kind)
  }
}

export const repository = {
  async open(): Promise<void> {
    await getDb()
  },

  listProjects(): Promise<ProjectRecord[]> {
    return run('read', async () => (await getDb()).getAll('projects'))
  },

  saveProjects(projects: ProjectRecord[]): Promise<void> {
    return run('write', async () => {
      const tx = (await getDb()).transaction('projects', 'readwrite')
      await Promise.all([...projects.map((p) => tx.store.put(p)), tx.done])
    })
  },

  // Apaga o projeto, todas as imagens dele e os registros das bibliotecas
  // vinculados a ele — tudo numa transação só (ou apaga tudo, ou nada).
  deleteProject(projectId: string): Promise<void> {
    return run('write', async () => {
      const db = await getDb()
      const tx = db.transaction(['projects', 'assets', ...LIBRARY_STORES], 'readwrite')
      const ops: Promise<unknown>[] = [tx.objectStore('projects').delete(projectId)]

      const assetKeys = await tx.objectStore('assets').index('byProject').getAllKeys(projectId)
      for (const key of assetKeys) ops.push(tx.objectStore('assets').delete(key))

      for (const name of LIBRARY_STORES) {
        const store = tx.objectStore(name)
        const keys = await store.index('byProject').getAllKeys(projectId)
        for (const key of keys) ops.push(store.delete(key))
      }

      await Promise.all([...ops, tx.done])
    })
  },

  putAsset(asset: AssetRecord): Promise<void> {
    return run('write', async () => {
      await (await getDb()).put('assets', asset)
    })
  },

  getAsset(id: string): Promise<AssetRecord | undefined> {
    return run('read', async () => (await getDb()).get('assets', id))
  },

  listAssetsByProject(projectId: string): Promise<AssetRecord[]> {
    return run('read', async () => (await getDb()).getAllFromIndex('assets', 'byProject', projectId))
  },

  // Pares (assetId, projectId) de todos os arquivos, sem carregar os bytes —
  // usado pra achar arquivos de projetos que já não existem.
  listAssetOwners(): Promise<Array<{ assetId: string; projectId: string }>> {
    return run('read', async () => {
      const owners: Array<{ assetId: string; projectId: string }> = []
      let cursor = await (await getDb()).transaction('assets').store.index('byProject').openKeyCursor()
      while (cursor) {
        owners.push({ assetId: String(cursor.primaryKey), projectId: String(cursor.key) })
        cursor = await cursor.continue()
      }
      return owners
    })
  },

  deleteAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    return run('write', async () => {
      const tx = (await getDb()).transaction('assets', 'readwrite')
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
    })
  },

  // --- biblioteca de personagens (independente dos projetos) ---

  listCharacters(): Promise<CharacterRecord[]> {
    return run('read', async () => (await getDb()).getAll('characters') as Promise<CharacterRecord[]>)
  },

  saveCharacter(record: CharacterRecord): Promise<void> {
    return run('write', async () => {
      await (await getDb()).put('characters', record)
    })
  },

  // Apaga a ficha e, na MESMA transação, as fotos que nenhum outro
  // personagem usa (duplicatas compartilham arquivos).
  deleteCharacter(id: string, photoAssetIds: string[]): Promise<void> {
    return run('write', async () => {
      const tx = (await getDb()).transaction(['characters', 'assets'], 'readwrite')
      await Promise.all([
        tx.objectStore('characters').delete(id),
        ...photoAssetIds.map((assetId) => tx.objectStore('assets').delete(assetId)),
        tx.done,
      ])
    })
  },

  // --- storyboards (um por projeto; id = projectId, apagado junto com o projeto) ---

  listStoryboards(): Promise<LibraryRecord[]> {
    return run('read', async () => (await getDb()).getAll('storyboards'))
  },

  saveStoryboard(record: LibraryRecord): Promise<void> {
    return run('write', async () => {
      await (await getDb()).put('storyboards', record)
    })
  },

  getMeta<T>(key: string): Promise<T | undefined> {
    return run('read', async () => (await (await getDb()).get('meta', key))?.value as T | undefined)
  },

  setMeta(key: string, value: unknown): Promise<void> {
    return run('write', async () => {
      await (await getDb()).put('meta', { key, value })
    })
  },
}

export type Repository = typeof repository
