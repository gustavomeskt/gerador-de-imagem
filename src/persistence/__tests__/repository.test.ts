import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDbForTests } from '../db'
import { repository } from '../repository'
import { DB_VERSION, LIBRARY_STORES, PROJECT_SCHEMA_VERSION, type AssetRecord, type ProjectRecord } from '../schema'

function project(id: string, name = id): ProjectRecord {
  return { schemaVersion: PROJECT_SCHEMA_VERSION, id, name, createdAt: 1, updatedAt: 2, nodes: [], edges: [] }
}

function asset(id: string, projectId: string, text = id): AssetRecord {
  const bytes = new TextEncoder().encode(text)
  return {
    id,
    projectId,
    kind: 'generated',
    mimeType: 'image/svg+xml',
    bytes: bytes.buffer,
    byteLength: bytes.byteLength,
    createdAt: Date.now(),
    source: { nodeId: 'n1', slotId: `s-${id}`, prompt: 'p', model: 'gpt-image-1.5', size: '1024x1024', provider: 'mock' },
  }
}

beforeEach(async () => {
  await resetDbForTests()
})

describe('estrutura do banco', () => {
  it('cria as tabelas atuais e as reservadas para as próximas etapas', async () => {
    const db = await getDb()
    expect(db.version).toBe(DB_VERSION)
    expect([...db.objectStoreNames].sort()).toEqual(
      ['assets', 'meta', 'projects', ...LIBRARY_STORES].sort(),
    )
  })
})

describe('projetos', () => {
  it('salva, lista e atualiza', async () => {
    await repository.saveProjects([project('a'), project('b')])
    await repository.saveProjects([project('a', 'renomeado')])
    const list = await repository.listProjects()
    expect(list.map((p) => [p.id, p.name]).sort()).toEqual([
      ['a', 'renomeado'],
      ['b', 'b'],
    ])
  })
})

describe('arquivos (imagens)', () => {
  it('salva e recupera os bytes intactos', async () => {
    await repository.putAsset(asset('x', 'a', 'conteúdo da imagem'))
    const loaded = await repository.getAsset('x')
    expect(new TextDecoder().decode(loaded!.bytes)).toBe('conteúdo da imagem')
    expect(loaded?.source?.prompt).toBe('p')
  })

  it('lista por projeto e exclui', async () => {
    await repository.putAsset(asset('x1', 'a'))
    await repository.putAsset(asset('x2', 'a'))
    await repository.putAsset(asset('y1', 'b'))

    expect((await repository.listAssetsByProject('a')).map((a) => a.id).sort()).toEqual(['x1', 'x2'])
    expect((await repository.listAssetOwners()).sort((p, q) => p.assetId.localeCompare(q.assetId))).toEqual([
      { assetId: 'x1', projectId: 'a' },
      { assetId: 'x2', projectId: 'a' },
      { assetId: 'y1', projectId: 'b' },
    ])

    await repository.deleteAssets(['x1'])
    expect(await repository.getAsset('x1')).toBeUndefined()
    expect(await repository.getAsset('x2')).toBeDefined()
  })

  it('excluir o projeto leva junto os arquivos e registros das bibliotecas dele', async () => {
    await repository.saveProjects([project('a'), project('b')])
    await repository.putAsset(asset('x1', 'a'))
    await repository.putAsset(asset('y1', 'b'))
    const db = await getDb()
    await db.put('characters', { id: 'c1', projectId: 'a', createdAt: 1, updatedAt: 1, data: {} })
    await db.put('characters', { id: 'c2', projectId: null, createdAt: 1, updatedAt: 1, data: {} })

    await repository.deleteProject('a')

    expect((await repository.listProjects()).map((p) => p.id)).toEqual(['b'])
    expect(await repository.getAsset('x1')).toBeUndefined()
    expect(await repository.getAsset('y1')).toBeDefined()
    expect(await db.get('characters', 'c1')).toBeUndefined()
    expect(await db.get('characters', 'c2')).toBeDefined() // personagem global continua
  })
})

describe('meta', () => {
  it('guarda e lê valores', async () => {
    expect(await repository.getMeta('k')).toBeUndefined()
    await repository.setMeta('k', { a: 1 })
    expect(await repository.getMeta('k')).toEqual({ a: 1 })
  })
})
