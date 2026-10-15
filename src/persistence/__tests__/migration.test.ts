import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from '../db'
import { createdAtFromId, LEGACY_MIGRATION_KEY, legacyFlowToProject, migrateLegacyFlows } from '../migration'
import { repository } from '../repository'

const legacyFlows = {
  'flow-1700000000000-1': {
    id: 'flow-1700000000000-1',
    name: 'Fluxo antigo',
    updatedAt: 1700000005000,
    nodes: [
      { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: 'gato' } },
      { id: 'i1', type: 'image', position: { x: 300, y: 0 }, data: { model: 'dall-e-3', size: '1024x1024', count: 1, images: [] } },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'i1', sourceHandle: 'prompt-out', targetHandle: 'prompt-in' }],
  },
  'flow-1700000001000-2': { id: 'flow-1700000001000-2', name: 'Vazio', updatedAt: 1700000001000, nodes: [], edges: [] },
}

beforeEach(async () => {
  await resetDbForTests()
  localStorage.clear()
})

describe('migração do localStorage', () => {
  it('copia os fluxos antigos para o banco e mantém o localStorage intacto', async () => {
    localStorage.setItem('ifs.flows', JSON.stringify(legacyFlows))
    const before = localStorage.getItem('ifs.flows')

    expect(await migrateLegacyFlows()).toBe(2)

    const projects = (await repository.listProjects()).sort((a, b) => a.createdAt - b.createdAt)
    expect(projects.map((p) => p.name)).toEqual(['Fluxo antigo', 'Vazio'])
    expect(projects[0].nodes).toHaveLength(2)
    expect(projects[0].edges).toHaveLength(1)
    expect(projects[0].createdAt).toBe(1700000000000)
    expect(localStorage.getItem('ifs.flows')).toBe(before)
    expect(await repository.getMeta(LEGACY_MIGRATION_KEY)).toMatchObject({ count: 2 })
  })

  it('roda uma vez só (não ressuscita fluxos apagados depois)', async () => {
    localStorage.setItem('ifs.flows', JSON.stringify(legacyFlows))
    await migrateLegacyFlows()
    await repository.deleteProject('flow-1700000001000-2')

    expect(await migrateLegacyFlows()).toBe(0)
    expect((await repository.listProjects()).map((p) => p.id)).toEqual(['flow-1700000000000-1'])
  })

  it('não sobrescreve um projeto que já existe no banco', async () => {
    await repository.saveProjects([
      { ...legacyFlowToProject(legacyFlows['flow-1700000000000-1'])!, name: 'Versão do banco' },
    ])
    localStorage.setItem('ifs.flows', JSON.stringify(legacyFlows))
    expect(await migrateLegacyFlows()).toBe(1)
    const p = (await repository.listProjects()).find((x) => x.id === 'flow-1700000000000-1')
    expect(p?.name).toBe('Versão do banco')
  })

  it('ignora lixo e funciona sem dados antigos', async () => {
    localStorage.setItem('ifs.flows', JSON.stringify({ a: null, b: { nome: 'sem id' } }))
    expect(await migrateLegacyFlows()).toBe(0)
    expect(legacyFlowToProject('texto')).toBeNull()
  })

  it('extrai a data de criação do id antigo', () => {
    expect(createdAtFromId('flow-1700000000000-3', 5)).toBe(1700000000000)
    expect(createdAtFromId('qualquer', 5)).toBe(5)
  })
})
