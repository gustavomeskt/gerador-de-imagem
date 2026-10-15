import { describe, expect, it } from 'vitest'
import type { AssetRecord, ProjectRecord } from '../../persistence/schema'
import { collectAssetIds, MISSING_ASSET_MESSAGE, restoreProject, serializeProject } from '../projectSerialization'
import type { FlowMeta, FlowSlice } from '../types'

const meta: FlowMeta = { id: 'f1', name: 'Projeto', createdAt: 10, updatedAt: 20 }

const slice: FlowSlice = {
  nodes: [
    { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { prompt: 'gato', enhancing: true } },
    {
      id: 'i1',
      type: 'image',
      position: { x: 300, y: 0 },
      data: {
        model: 'gpt-image-1.5',
        size: '1024x1536',
        count: 4,
        notice: 'aviso passageiro',
        images: [
          { id: 's1', status: 'done', assetId: 'a1', src: 'blob:x', mimeType: 'image/png', aspect: 0.5625 },
          { id: 's2', status: 'loading', aspect: 0.5625 },
          { id: 's3', status: 'error', error: 'falhou', aspect: 0.5625 },
          { id: 's4', status: 'done', src: 'data:image/png;base64,AA', unsaved: true, aspect: 0.5625 },
        ],
      },
    },
  ],
  edges: [{ id: 'e1', source: 'p1', target: 'i1', selected: true }],
}

function asset(id: string, nodeId: string, slotId: string, createdAt = 1): AssetRecord {
  return {
    id,
    projectId: 'f1',
    kind: 'generated',
    mimeType: 'image/svg+xml',
    bytes: new TextEncoder().encode(id).buffer,
    byteLength: id.length,
    width: 9,
    height: 16,
    createdAt,
    source: { nodeId, slotId, prompt: 'gato', model: 'gpt-image-1.5', size: '1024x1536', provider: 'mock' },
  }
}

describe('serializeProject', () => {
  it('salva só referências de imagens prontas e salvas, sem bytes nem URLs', () => {
    const record = serializeProject(meta, slice, 99)
    const image = record.nodes.find((n) => n.id === 'i1')!
    expect(image.data.images).toEqual([{ id: 's1', assetId: 'a1', aspect: 0.5625 }])
    expect(image.data.notice).toBeUndefined()
    expect(JSON.stringify(record)).not.toMatch(/blob:|data:image/)
    expect(record).toMatchObject({ id: 'f1', name: 'Projeto', createdAt: 10, updatedAt: 99, schemaVersion: 1 })
  })

  it('não salva estado passageiro da tela', () => {
    const record = serializeProject(meta, slice)
    const prompt = record.nodes.find((n) => n.id === 'p1')!
    expect(prompt.selected).toBeUndefined()
    expect(prompt.data.enhancing).toBeUndefined()
    expect(prompt.data.prompt).toBe('gato')
    expect(record.edges[0]).not.toHaveProperty('selected')
  })
})

describe('restoreProject', () => {
  const record: ProjectRecord = serializeProject(meta, slice)

  it('religa as imagens aos arquivos salvos', () => {
    const restored = restoreProject(record, [asset('a1', 'i1', 's1')])
    const node = restored.slice.nodes.find((n) => n.id === 'i1')
    expect(node?.type === 'image' && node.data.images).toEqual([
      expect.objectContaining({ id: 's1', status: 'done', assetId: 'a1', mimeType: 'image/svg+xml', aspect: 0.5625 }),
    ])
    expect(restored.meta).toEqual({ id: 'f1', name: 'Projeto', createdAt: 10, updatedAt: record.updatedAt })
  })

  it('arquivo sumido vira slot com erro claro', () => {
    const restored = restoreProject(record, [])
    const node = restored.slice.nodes.find((n) => n.id === 'i1')
    expect(node?.type === 'image' && node.data.images[0]).toMatchObject({ status: 'error', error: MISSING_ASSET_MESSAGE })
  })

  it('recupera imagens salvas que não estavam na estrutura e separa as órfãs', () => {
    const restored = restoreProject(record, [
      asset('a1', 'i1', 's1'),
      asset('a2', 'i1', 's-nova', 5), // gerada, mas o app fechou antes de salvar a estrutura
      asset('a3', 'no-apagado', 'sx'),
    ])
    const node = restored.slice.nodes.find((n) => n.id === 'i1')
    const images = node?.type === 'image' ? node.data.images : []
    expect(images.map((s) => s.assetId)).toEqual(['a1', 'a2'])
    expect(images[1].id).toBe('s-nova')
    expect(images[1].aspect).toBeCloseTo(9 / 16)
    expect(restored.recoveredCount).toBe(1)
    expect(restored.orphanAssetIds).toEqual(['a3'])
  })

  it('não duplica id de slot ao recuperar', () => {
    const restored = restoreProject(record, [asset('a1', 'i1', 's1'), asset('a-velha', 'i1', 's1')])
    const node = restored.slice.nodes.find((n) => n.id === 'i1')
    const ids = node?.type === 'image' ? node.data.images.map((s) => s.id) : []
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('collectAssetIds lista os arquivos dos nós', () => {
    expect(collectAssetIds(slice.nodes)).toEqual(['a1'])
  })
})
