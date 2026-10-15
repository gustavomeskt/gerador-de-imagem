import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { dataUrlToBytes, sha256Hex } from '../../lib/binary'
import type { AssetRecord } from '../../persistence/schema'
import type { FlowMeta, FlowSlice, ImageSlot } from '../../store/types'
import { labelFromBytes, svgImage } from '../../test/fixtures'
import { buildProjectZip, imageFileName, slugify, zipFileName, type ProjectManifest } from '../projectZip'

const meta: FlowMeta = { id: 'f1', name: 'Gelatina — Cena da Cozinha!', createdAt: Date.UTC(2026, 0, 1), updatedAt: Date.UTC(2026, 0, 2) }

function storedAsset(id: string, label: string, nodeId: string): AssetRecord {
  const { bytes } = dataUrlToBytes(svgImage(label, 864, 1536).src)
  return {
    id,
    projectId: 'f1',
    kind: 'generated',
    mimeType: 'image/svg+xml',
    bytes: bytes.slice().buffer,
    byteLength: bytes.byteLength,
    width: 864,
    height: 1536,
    createdAt: Date.UTC(2026, 0, 1, 12),
    source: { nodeId, slotId: `slot-${id}`, prompt: `prompt ${label}`, model: 'gpt-image-1.5', size: '1024x1536', provider: 'mock' },
  }
}

const assets = new Map(
  [storedAsset('a1', 'cima-1', 'top'), storedAsset('a2', 'cima-2', 'top'), storedAsset('b1', 'baixo-1', 'bottom')].map(
    (a) => [a.id, a],
  ),
)

const done = (id: string, assetId: string): ImageSlot => ({ id, status: 'done', assetId, src: 'blob:x', aspect: 9 / 16 })

const slice: FlowSlice = {
  nodes: [
    // fora de ordem de propósito: o de baixo vem primeiro na lista
    {
      id: 'bottom',
      type: 'image',
      position: { x: 0, y: 500 },
      data: {
        model: 'gpt-image-1.5',
        size: '1024x1536',
        count: 3,
        images: [
          done('sb1', 'b1'),
          { id: 'sb2', status: 'error', error: 'falhou', aspect: 9 / 16 },
          { id: 'sb3', status: 'done', src: svgImage('nao-salva').src, mimeType: 'image/svg+xml', unsaved: true, aspect: 1 },
          done('sb4', 'sumiu'),
        ],
      },
    },
    { id: 'p1', type: 'prompt', position: { x: -300, y: 0 }, data: { prompt: 'Uma cozinha' } },
    {
      id: 'top',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { model: 'gpt-image-1.5', size: '1024x1536', quality: 'high', count: 2, images: [done('st1', 'a1'), done('st2', 'a2')] },
    },
  ],
  edges: [{ id: 'e1', source: 'p1', target: 'top', targetHandle: 'prompt-in' }],
}

async function exportAndOpen() {
  const result = await buildProjectZip({
    meta,
    slice,
    loadAsset: async (id) => assets.get(id),
    now: new Date(2026, 4, 6, 9, 5),
  })
  const zip = await JSZip.loadAsync(result.data)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as ProjectManifest
  return { result, zip, manifest }
}

describe('exportação em ZIP', () => {
  it('organiza as imagens em ordem com nomes padronizados', async () => {
    const { zip, manifest } = await exportAndOpen()
    const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort()
    expect(files).toEqual([
      'imagens/001_grupo-01_imagem-01.svg',
      'imagens/002_grupo-01_imagem-02.svg',
      'imagens/003_grupo-02_imagem-01.svg',
      'imagens/004_grupo-02_imagem-02.svg',
      'manifest.json',
    ])

    const labels = await Promise.all(
      manifest.images.map(async (img) => labelFromBytes(await zip.file(img.file)!.async('uint8array'))),
    )
    expect(labels).toEqual(['cima-1', 'cima-2', 'baixo-1', 'nao-salva'])
  })

  it('o manifest descreve projeto, grupos, origem e o que ficou de fora', async () => {
    const { manifest } = await exportAndOpen()
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.project).toEqual({
      id: 'f1',
      name: 'Gelatina — Cena da Cozinha!',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(manifest.imageCount).toBe(4)
    expect(manifest.groups).toEqual([
      { group: 1, nodeId: 'top', prompt: 'Uma cozinha', model: 'gpt-image-1.5', size: '1024x1536', quality: 'high', imageCount: 2 },
      { group: 2, nodeId: 'bottom', prompt: null, model: 'gpt-image-1.5', size: '1024x1536', quality: null, imageCount: 2 },
    ])
    expect(manifest.images[0]).toMatchObject({
      sequence: 1,
      group: 1,
      indexInGroup: 1,
      nodeId: 'top',
      slotId: 'st1',
      assetId: 'a1',
      width: 864,
      height: 1536,
      source: { prompt: 'prompt cima-1', provider: 'mock' },
    })
    // imagem que falhou ao salvar no banco também é exportada (vem da memória)
    expect(manifest.images[3]).toMatchObject({ slotId: 'sb3', assetId: null, width: 100, height: 100 })
    expect(manifest.skipped).toEqual([
      { nodeId: 'bottom', slotId: 'sb2', reason: 'com erro' },
      { nodeId: 'bottom', slotId: 'sb4', reason: 'arquivo não encontrado no armazenamento local' },
    ])
  })

  it('integridade: hash e tamanho do manifest batem com os arquivos do ZIP', async () => {
    const { zip, manifest } = await exportAndOpen()
    for (const img of manifest.images) {
      const bytes = await zip.file(img.file)!.async('uint8array')
      expect(bytes.byteLength).toBe(img.byteLength)
      expect(await sha256Hex(bytes)).toBe(img.sha256)
    }
    // bytes exportados são idênticos aos salvos
    const original = new Uint8Array(assets.get('a1')!.bytes)
    expect(await zip.file(manifest.images[0].file)!.async('uint8array')).toEqual(original)
  })

  it('projeto sem imagens gera ZIP só com o manifest', async () => {
    const result = await buildProjectZip({ meta, slice: { nodes: [], edges: [] }, loadAsset: async () => undefined })
    const zip = await JSZip.loadAsync(result.data)
    expect(Object.keys(zip.files)).toEqual(['manifest.json'])
    expect(result.manifest.imageCount).toBe(0)
  })

  it('nome do ZIP e dos arquivos', () => {
    expect(slugify('Gelatina — Cena da Cozinha!')).toBe('gelatina-cena-da-cozinha')
    expect(slugify('***')).toBe('projeto')
    expect(zipFileName('Ação Nº 1', new Date(2026, 4, 6, 9, 5))).toBe('acao-n-1_2026-05-06_09-05.zip')
    expect(imageFileName(12, 3, 4, 'image/png')).toBe('imagens/012_grupo-03_imagem-04.png')
  })
})
