import { deleteDB, openDB, type IDBPDatabase } from 'idb'
import { StorageError, STORAGE_MESSAGES } from './errors'
import { DB_NAME, DB_VERSION, LIBRARY_STORES, type AppDB } from './schema'

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null

export function getDb(): Promise<IDBPDatabase<AppDB>> {
  if (!dbPromise) {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new StorageError('unavailable', STORAGE_MESSAGES.unavailable))
    }

    dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // versão 1: estrutura inicial. Futuras versões adicionam passos aqui
        // (if (oldVersion < 2) ...) sem apagar o que já existe.
        if (oldVersion < 1) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' })
          projects.createIndex('byUpdatedAt', 'updatedAt')

          const assets = db.createObjectStore('assets', { keyPath: 'id' })
          assets.createIndex('byProject', 'projectId')
          assets.createIndex('byNode', 'source.nodeId')

          for (const name of LIBRARY_STORES) {
            const store = db.createObjectStore(name, { keyPath: 'id' })
            store.createIndex('byProject', 'projectId')
          }

          db.createObjectStore('meta', { keyPath: 'key' })
        }
      },
      blocking() {
        // outra aba quer atualizar a estrutura: fecha esta conexão pra não travar
        void dbPromise?.then((db) => db.close())
        dbPromise = null
      },
    }).catch((err: unknown) => {
      dbPromise = null
      throw new StorageError('unavailable', STORAGE_MESSAGES.unavailable, { cause: err })
    })
  }
  return dbPromise
}

// Só pra testes: fecha a conexão e apaga o banco.
export async function resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
    dbPromise = null
  }
  await deleteDB(DB_NAME)
}

// Só pra testes: fecha a conexão sem apagar (simula fechar/reabrir o app).
export async function closeDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
    dbPromise = null
  }
}
