import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySheet, LIBRARY_PROJECT_ID } from '../../generation/characters'
import { jpegBytes, pngBytes } from '../../test/fixtures'
import { testing } from './testProvider'

vi.mock('../../generation/providers', async () => {
  const { testProvider } = await import('./testProvider')
  return {
    getProvider: testProvider,
    isProviderKind: (v: unknown) => v === 'mock' || v === 'backend',
    DEFAULT_PROVIDER: 'mock',
    PROVIDER_KINDS: ['mock', 'backend'],
    backendProvider: testProvider('backend'),
  }
})
vi.mock('../../lib/image', async () => ({ cropToAspect: (await import('./testProvider')).fakeCrop }))

type DbModule = typeof import('../../persistence/db')
let currentDb: DbModule | null = null

// Simula abrir o app do zero (como depois de atualizar a página)
async function openApp() {
  await currentDb?.closeDbForTests()
  vi.resetModules()
  currentDb = await import('../../persistence/db')
  const { repository } = await import('../../persistence/repository')
  const flows = await import('../useFlowStore')
  const chars = await import('../useCharacterStore')
  await flows.useFlowStore.getState().hydrate()
  await chars.useCharacterStore.getState().hydrate()
  return { repository, F: flows.useFlowStore, C: chars.useCharacterStore, flushDirtyFlows: flows.flushDirtyFlows }
}

async function addCharacter(app: Awaited<ReturnType<typeof openApp>>, name: string, photos: Uint8Array[], extra = {}) {
  const r = await app.C.getState().saveCharacter({
    sheet: { ...emptySheet(), name, ...extra },
    photos: photos.map((bytes, i) => ({ kind: 'new' as const, name: `${name}-${i}.png`, bytes })),
    primaryIndex: photos.length > 1 ? 1 : 0,
  })
  if (!r.ok) throw new Error(r.error)
  return r.id
}

beforeEach(async () => {
  testing.pending.length = 0
  localStorage.clear()
  await currentDb?.resetDbForTests()
})
afterEach(() => vi.restoreAllMocks())

describe('persistência da biblioteca', () => {
  it('personagens, fotos, elenco das cenas e guia de estilo voltam depois de reabrir', async () => {
    const app = await openApp()
    const photos = [pngBytes(400, 600, 1), jpegBytes(500, 700, 2)]
    const maria = await addCharacter(app, 'Maria', photos, { apparentAge: '60 anos', hair: 'grisalho' })
    const flowId = app.F.getState().createFlow()
    app.F.getState().addImageNode(flowId, { x: 0, y: 0 })
    const imageId = app.F.getState().flowsData[flowId].nodes[0].id
    app.F.getState().setCast(flowId, imageId, [maria])
    app.F.getState().setCastNote(flowId, imageId, maria, 'de avental')
    app.F.getState().updateStyleGuide(flowId, { environment: 'cozinha clara' })
    await app.flushDirtyFlows()

    const reopened = await openApp()
    const c = reopened.C.getState().characters.find((x) => x.id === maria)!
    expect(c).toMatchObject({ name: 'Maria', apparentAge: '60 anos', hair: 'grisalho', version: 1 })
    expect(c.photos.every((p) => !!p.src && !p.missing)).toBe(true)
    expect(c.primaryPhotoId).toBe(c.photos[1].id)
    for (const [i, p] of c.photos.entries()) {
      expect(new Uint8Array((await reopened.repository.getAsset(p.assetId!))!.bytes)).toEqual(photos[i])
    }
    const node = reopened.F.getState().flowsData[flowId].nodes[0]
    expect(node.type === 'image' && node.data.castIds).toEqual([maria])
    expect(node.type === 'image' && node.data.castNotes).toEqual({ [maria]: 'de avental' })
    expect(reopened.F.getState().flowsData[flowId].styleGuide).toMatchObject({ enabled: true, aspect: '9:16', environment: 'cozinha clara' })
  })

  it('REGRESSÃO: a limpeza de arquivos órfãos dos projetos não apaga as fotos da biblioteca', async () => {
    const app = await openApp()
    const id = await addCharacter(app, 'Sem projeto', [pngBytes(100, 100, 9)])
    const assetId = app.C.getState().characters.find((c) => c.id === id)!.photos[0].assetId!
    const reopened = await openApp()
    expect(await reopened.repository.getAsset(assetId)).toBeDefined()
    expect((await reopened.repository.listAssetsByProject(LIBRARY_PROJECT_ID)).map((a) => a.id)).toContain(assetId)
  })

  it('foto da biblioteca gravada sem ficha (app fechado no meio) é limpa ao reabrir', async () => {
    const app = await openApp()
    await app.repository.putAsset({
      id: 'foto-solta',
      projectId: LIBRARY_PROJECT_ID,
      kind: 'character',
      mimeType: 'image/png',
      bytes: new ArrayBuffer(8),
      byteLength: 8,
      createdAt: 1,
    })
    const reopened = await openApp()
    expect(await reopened.repository.getAsset('foto-solta')).toBeUndefined()
  })

  it('projeto antigo (da versão anterior) recebe o guia de estilo DESLIGADO', async () => {
    localStorage.setItem(
      'ifs.flows',
      JSON.stringify({ 'flow-1700000000000-1': { id: 'flow-1700000000000-1', name: 'Antigo', updatedAt: 1, nodes: [], edges: [] } }),
    )
    const app = await openApp()
    expect(app.F.getState().flowsData['flow-1700000000000-1'].styleGuide?.enabled).toBe(false)
  })
})

describe('backup da biblioteca', () => {
  it('exporta fichas + fotos originais e restaura tudo em um navegador "zerado"', async () => {
    const app = await openApp()
    const photosA = [pngBytes(400, 600, 11), jpegBytes(300, 300, 12)]
    const a = await addCharacter(app, 'Ana', photosA, { faceFeatures: 'sardas', defaultOutfit: 'jaleco' })
    const b = await addCharacter(app, 'Beto', [pngBytes(200, 200, 13)])
    const flowId = app.F.getState().createFlow()
    app.F.getState().addImageNode(flowId, { x: 0, y: 0 })
    const imageId = app.F.getState().flowsData[flowId].nodes[0].id
    app.F.getState().setCast(flowId, imageId, [a, b])
    await app.flushDirtyFlows()

    const { buildCharacterBackup, parseCharacterBackup } = await import('../../export/characterBackup')
    const { loadPhotoBytes } = await import('../../export/libraryBackup')
    const original = app.C.getState().characters
    const backup = await buildCharacterBackup({ characters: original, loadBytes: loadPhotoBytes })
    expect(backup.manifest).toMatchObject({ characterCount: 2, photoCount: 3, missingPhotos: [] })
    const zip = await JSZip.loadAsync(backup.data)
    expect(Object.keys(zip.files).filter((f) => f.startsWith('fotos/') && !zip.files[f].dir)).toHaveLength(3)

    // "outro computador": banco vazio
    await currentDb!.resetDbForTests()
    const fresh = await openApp()
    expect(fresh.C.getState().characters).toEqual([])
    const parsed = await parseCharacterBackup(backup.data)
    expect(parsed.errors).toEqual([])
    const report = await fresh.C.getState().importCharacters(parsed.characters)
    expect(report).toMatchObject({ imported: ['Ana', 'Beto'], updated: [], skipped: [], errors: [] })

    const restored = fresh.C.getState().characters.find((c) => c.id === a)!
    const before = original.find((c) => c.id === a)!
    expect(restored).toMatchObject({ name: 'Ana', faceFeatures: 'sardas', defaultOutfit: 'jaleco', version: before.version, createdAt: before.createdAt, updatedAt: before.updatedAt })
    expect(restored.primaryPhotoId).toBe(before.primaryPhotoId)
    for (const [i, p] of restored.photos.entries()) {
      expect(new Uint8Array((await fresh.repository.getAsset(p.assetId!))!.bytes)).toEqual(photosA[i])
    }

    // importar de novo não duplica
    const again = await fresh.C.getState().importCharacters(parsed.characters)
    expect(again.skipped).toHaveLength(2)
    expect(fresh.C.getState().characters).toHaveLength(2)
  })

  it('versão mais nova no backup atualiza; mais antiga é ignorada', async () => {
    const app = await openApp()
    const id = await addCharacter(app, 'Caio', [pngBytes(100, 100, 21)], { hair: 'preto' })
    const { buildCharacterBackup, parseCharacterBackup } = await import('../../export/characterBackup')
    const { loadPhotoBytes } = await import('../../export/libraryBackup')
    const oldBackup = await buildCharacterBackup({ characters: app.C.getState().characters, loadBytes: loadPhotoBytes })

    await new Promise((r) => setTimeout(r, 5))
    const c = app.C.getState().characters[0]
    await app.C.getState().saveCharacter({ id, sheet: { ...emptySheet(), name: 'Caio', hair: 'grisalho' }, photos: [{ kind: 'existing', photoId: c.photos[0].id }], primaryIndex: 0 })
    const skipped = await app.C.getState().importCharacters((await parseCharacterBackup(oldBackup.data)).characters)
    expect(skipped.skipped).toHaveLength(1)
    expect(app.C.getState().characters[0].hair).toBe('grisalho')

    const newBackup = await buildCharacterBackup({ characters: app.C.getState().characters, loadBytes: loadPhotoBytes })
    await currentDb!.resetDbForTests()
    const other = await openApp()
    await other.C.getState().importCharacters((await parseCharacterBackup(oldBackup.data)).characters)
    const updated = await other.C.getState().importCharacters((await parseCharacterBackup(newBackup.data)).characters)
    expect(updated.updated).toEqual(['Caio'])
    expect(other.C.getState().characters[0]).toMatchObject({ hair: 'grisalho', version: 2 })
  })

  it('validação: arquivos que não são backup, adulterados ou inseguros', async () => {
    const app = await openApp()
    await addCharacter(app, 'Duda', [pngBytes(100, 100, 31)])
    await addCharacter(app, 'Eva', [pngBytes(100, 100, 32)])
    const { buildCharacterBackup, parseCharacterBackup, BackupError } = await import('../../export/characterBackup')
    const { loadPhotoBytes } = await import('../../export/libraryBackup')
    const good = await buildCharacterBackup({ characters: app.C.getState().characters, loadBytes: loadPhotoBytes })

    await expect(parseCharacterBackup(new TextEncoder().encode('não é zip'))).rejects.toBeInstanceOf(BackupError)
    const empty = new JSZip()
    empty.file('outra-coisa.txt', 'x')
    await expect(parseCharacterBackup(await empty.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/backup\.json não encontrado/)
    const wrong = new JSZip()
    wrong.file('backup.json', JSON.stringify({ format: 'outro', formatVersion: 1, characters: [] }))
    await expect(parseCharacterBackup(await wrong.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/não é um backup/)

    // adultera: troca a foto da Duda e aponta a da Eva para fora da pasta
    const zip = await JSZip.loadAsync(good.data)
    const manifest = JSON.parse(await zip.file('backup.json')!.async('string'))
    const duda = manifest.characters.find((c: { sheet: { name: string } }) => c.sheet.name === 'Duda')
    zip.file(duda.photos[0].file, pngBytes(100, 100, 999))
    const eva = manifest.characters.find((c: { sheet: { name: string } }) => c.sheet.name === 'Eva')
    eva.photos[0].file = '../../segredo.png'
    zip.file('backup.json', JSON.stringify(manifest))
    const parsed = await parseCharacterBackup(await zip.generateAsync({ type: 'uint8array' }))
    expect(parsed.characters).toEqual([])
    expect(parsed.errors.join(' | ')).toMatch(/Duda: foto .* corrompida \(hash não confere\)/)
    expect(parsed.errors.join(' | ')).toMatch(/Eva: caminho de foto inválido/)
  })

  it('backup com um personagem ruim importa os outros e relata o problema', async () => {
    const app = await openApp()
    await addCharacter(app, 'Fábio', [pngBytes(100, 100, 41)])
    await addCharacter(app, 'Gina', [pngBytes(100, 100, 42)])
    const { buildCharacterBackup, parseCharacterBackup } = await import('../../export/characterBackup')
    const { loadPhotoBytes } = await import('../../export/libraryBackup')
    const good = await buildCharacterBackup({ characters: app.C.getState().characters, loadBytes: loadPhotoBytes })
    const zip = await JSZip.loadAsync(good.data)
    const manifest = JSON.parse(await zip.file('backup.json')!.async('string'))
    const gina = manifest.characters.find((c: { sheet: { name: string } }) => c.sheet.name === 'Gina')
    zip.file(gina.photos[0].file, new TextEncoder().encode('GIF89a não é foto aceita'))
    const parsed = await parseCharacterBackup(await zip.generateAsync({ type: 'uint8array' }))
    expect(parsed.characters.map((c) => c.sheet.name)).toEqual(['Fábio'])
    expect(parsed.errors[0]).toMatch(/Gina: foto .*formato não suportado/)
  })
})
