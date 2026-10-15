import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySheet, LIBRARY_PROJECT_ID, type CharacterSheet } from '../../generation/characters'
import type { ImageGenerationRequest, ImageProvider } from '../../generation/types'
import { base64ToBytes, sha256Hex } from '../../lib/binary'
import { repository } from '../../persistence/repository'
import { jpegBytes, pngBytes, svgImage, webpBytes } from '../../test/fixtures'
import { projectsUsingCharacter } from '../characterUsage'
import { useCharacterStore, type DraftPhoto } from '../useCharacterStore'
import { useFlowStore, type ImageFlowNode } from '../useFlowStore'

const cap = vi.hoisted(() => ({ requests: [] as ImageGenerationRequest[] }))

vi.mock('../../generation/providers', () => {
  const provider: ImageProvider = {
    kind: 'mock',
    label: 'captura',
    async generateImages(request) {
      cap.requests.push(request)
      return Array.from({ length: request.n }, (_, i) => svgImage(`gerada-${cap.requests.length}-${i}`))
    },
    async enhancePrompt(p) {
      return p
    },
  }
  return {
    getProvider: () => provider,
    isProviderKind: (v: unknown) => v === 'mock' || v === 'backend',
    DEFAULT_PROVIDER: 'mock',
    PROVIDER_KINDS: ['mock', 'backend'],
    backendProvider: provider,
  }
})
vi.mock('../../lib/image', async () => ({ cropToAspect: (await import('./testProvider')).fakeCrop }))

await useFlowStore.getState().hydrate()
await useCharacterStore.getState().hydrate()

const F = () => useFlowStore.getState()
const C = () => useCharacterStore.getState()
const newPhoto = (name: string, bytes: Uint8Array): DraftPhoto => ({ kind: 'new', name, bytes })

async function createCharacter(name: string, photos: Uint8Array[], extra: Partial<CharacterSheet> = {}) {
  const result = await C().saveCharacter({
    sheet: { ...emptySheet(), name, ...extra },
    photos: photos.map((b, i) => newPhoto(`${name}-${i + 1}.png`, b)),
    primaryIndex: 0,
  })
  if (!result.ok) throw new Error(result.error)
  return result.id
}

function setupProject(name: string, style = false) {
  const flowId = F().createFlow()
  F().renameFlow(flowId, name)
  if (!style) F().updateStyleGuide(flowId, { enabled: false })
  F().addPromptNode(flowId, { x: 0, y: 0 })
  F().addImageNode(flowId, { x: 400, y: 0 })
  const [p, i] = F().flowsData[flowId].nodes
  F().updatePromptData(flowId, p.id, { prompt: 'Maria e João conversam na cozinha' })
  F().updateImageConfig(flowId, i.id, { model: 'gpt-image-1.5', size: '1024x1536', count: 1 })
  F().onConnect(flowId, { source: p.id, sourceHandle: 'prompt-out', target: i.id, targetHandle: 'prompt-in' })
  return { flowId, imageId: i.id }
}

const imgNode = (flowId: string, id: string) => F().flowsData[flowId].nodes.find((n) => n.id === id) as ImageFlowNode
let seed = 100
const photo = () => pngBytes(400, 600, seed++)

beforeEach(() => {
  cap.requests.length = 0
})

describe('cadastro de personagens', () => {
  it('cria com ficha completa, várias fotos e foto principal; fotos ficam na biblioteca', async () => {
    const photos = [pngBytes(400, 600, 1), jpegBytes(500, 700, 2), webpBytes(640, 480, 3)]
    const result = await C().saveCharacter({
      sheet: { ...emptySheet(), name: 'Dona Maria', apparentAge: '60 anos', faceFeatures: 'rosto redondo', hair: 'grisalho', defaultOutfit: 'avental' },
      photos: photos.map((b, i) => newPhoto(`m${i}`, b)),
      primaryIndex: 1,
    })
    expect(result.ok).toBe(true)
    const c = C().characters.find((x) => result.ok && x.id === result.id)!
    expect(c).toMatchObject({ name: 'Dona Maria', apparentAge: '60 anos', version: 1 })
    expect(c.photos.map((p) => p.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(c.primaryPhotoId).toBe(c.photos[1].id)
    expect(c.createdAt).toBe(c.updatedAt)
    const asset = await repository.getAsset(c.photos[0].assetId!)
    expect(asset).toMatchObject({ kind: 'character', projectId: LIBRARY_PROJECT_ID })
    expect(new Uint8Array(asset!.bytes)).toEqual(photos[0])
    expect((await repository.listCharacters()).some((r) => r.id === c.id && r.projectId === null)).toBe(true)
  })

  it('validação: nome, ao menos uma foto, arquivo inválido e foto repetida', async () => {
    expect(await C().saveCharacter({ sheet: emptySheet(), photos: [newPhoto('a', photo())], primaryIndex: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/nome/) })
    expect(await C().saveCharacter({ sheet: { ...emptySheet(), name: 'X' }, photos: [], primaryIndex: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/pelo menos uma foto/) })
    expect(
      await C().saveCharacter({ sheet: { ...emptySheet(), name: 'X' }, photos: [newPhoto('a.gif', new TextEncoder().encode('GIF89a...'))], primaryIndex: 0 }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/formato não suportado/) })
    const same = photo()
    expect(
      await C().saveCharacter({ sheet: { ...emptySheet(), name: 'X' }, photos: [newPhoto('a', same), newPhoto('b', same)], primaryIndex: 0 }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/já está neste personagem/) })
  })

  it('edição atualiza a ficha, a versão e a data; trocar fotos apaga as que saíram', async () => {
    const id = await createCharacter('Ana', [photo(), photo()])
    const before = C().characters.find((c) => c.id === id)!
    await new Promise((r) => setTimeout(r, 5))
    const result = await C().saveCharacter({
      id,
      sheet: { ...emptySheet(), name: 'Ana Paula', hair: 'cacheado' },
      photos: [{ kind: 'existing', photoId: before.photos[1].id }, newPhoto('nova.jpg', jpegBytes(300, 300, 900))],
      primaryIndex: 1,
    })
    expect(result.ok).toBe(true)
    const after = C().characters.find((c) => c.id === id)!
    expect(after).toMatchObject({ name: 'Ana Paula', hair: 'cacheado', version: 2, createdAt: before.createdAt })
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(after.primaryPhotoId).toBe(after.photos[1].id)
    await vi.waitFor(async () => expect(await repository.getAsset(before.photos[0].assetId!)).toBeUndefined())
    expect(await repository.getAsset(before.photos[1].assetId!)).toBeDefined()
  })

  it('duplicar cria outra ficha com os mesmos arquivos; excluir uma não apaga as fotos da outra', async () => {
    const id = await createCharacter('Bia', [photo()])
    const copyId = await C().duplicateCharacter(id)
    const original = C().characters.find((c) => c.id === id)!
    const copy = C().characters.find((c) => c.id === copyId)!
    expect(copy.name).toBe('Bia (cópia)')
    expect(copy.photos[0].assetId).toBe(original.photos[0].assetId)
    await C().deleteCharacter(id)
    expect(await repository.getAsset(copy.photos[0].assetId!)).toBeDefined()
    await C().deleteCharacter(copyId!)
    expect(await repository.getAsset(copy.photos[0].assetId!)).toBeUndefined()
  })
})

describe('personagens nos projetos', () => {
  it('o mesmo personagem em dois projetos usa os mesmos arquivos (sem cópia)', async () => {
    const maria = await createCharacter('Maria', [photo()])
    const a = setupProject('Projeto A')
    const b = setupProject('Projeto B')
    F().setCast(a.flowId, a.imageId, [maria])
    F().setCast(b.flowId, b.imageId, [maria])
    const libraryBefore = (await repository.listAssetsByProject(LIBRARY_PROJECT_ID)).length

    await F().generate(a.flowId, a.imageId)
    await F().generate(b.flowId, b.imageId)

    const [reqA, reqB] = cap.requests
    expect(reqA.references?.[0].b64).toBe(reqB.references?.[0].b64)
    expect((await repository.listAssetsByProject(LIBRARY_PROJECT_ID)).length).toBe(libraryBefore)
    expect((await repository.listAssetsByProject(a.flowId)).filter((x) => x.kind !== 'generated')).toEqual([])
    expect(projectsUsingCharacter(maria).map((u) => u.flowName).sort()).toEqual(['Projeto A', 'Projeto B'])
  })

  it('as fotos do personagem vão de verdade (principal primeiro) com a ficha no prompt', async () => {
    const photos = [pngBytes(400, 600, 501), jpegBytes(500, 500, 502)]
    const result = await C().saveCharacter({
      sheet: { ...emptySheet(), name: 'Maria', apparentAge: '60 anos', hair: 'grisalho', defaultOutfit: 'avental branco' },
      photos: photos.map((b, i) => newPhoto(`m${i}`, b)),
      primaryIndex: 1,
    })
    const maria = result.ok ? result.id : ''
    const { flowId, imageId } = setupProject('Fichas')
    F().setCast(flowId, imageId, [maria])
    F().setCastNote(flowId, imageId, maria, 'de pijama nesta cena')
    await F().generate(flowId, imageId)

    const req = cap.requests.at(-1)!
    expect(req.references?.map((r) => base64ToBytes(r.b64))).toEqual([photos[1], photos[0]])
    expect(req.prompt).toContain('Images 1-2: "Maria"')
    expect(req.prompt).toContain('apparent age: 60 anos')
    expect(req.prompt).toContain('default outfit: avental branco')
    expect(req.prompt).toContain('In this scene only: de pijama nesta cena')
    // a nota da cena não muda a ficha permanente
    expect(C().characters.find((c) => c.id === maria)?.defaultOutfit).toBe('avental branco')
  })

  it('cena com quatro personagens: uma foto principal de cada, extras pelo limite, separação de identidades', async () => {
    const ids = []
    const primaries: Uint8Array[] = []
    for (const name of ['Ana', 'Beto', 'Caio', 'Duda']) {
      const p1 = photo()
      primaries.push(p1)
      ids.push(await createCharacter(name, [p1, photo(), photo()]))
    }
    const { flowId, imageId } = setupProject('Quatro')
    F().setCast(flowId, imageId, ids)
    const preview = F().getGenerationPreview(flowId, imageId)
    if ('error' in preview) throw new Error(preview.error)
    // 4 principais + 2 extras (rodízio) = limite de 6; 6 extras ficam de fora
    expect(preview.characters.map((c) => [c.name, c.sent])).toEqual([
      ['Ana', 2],
      ['Beto', 2],
      ['Caio', 1],
      ['Duda', 1],
    ])
    expect(preview.omitted).toHaveLength(6)

    await F().generate(flowId, imageId)
    const req = cap.requests.at(-1)!
    const sent = req.references!.map((r) => base64ToBytes(r.b64))
    expect(sent).toHaveLength(6)
    expect(sent[0]).toEqual(primaries[0])
    expect(sent[2]).toEqual(primaries[1])
    expect(sent[4]).toEqual(primaries[2])
    expect(sent[5]).toEqual(primaries[3])
    expect(req.prompt).toContain('Images 1-2: "Ana"')
    expect(req.prompt).toContain('Image 6: "Duda"')
    expect(req.prompt).toContain('never mix or swap features between different people')
  })

  it('personagens + nó de referência: personagens primeiro; acima do limite avisa', async () => {
    const ana = await createCharacter('Ana', [photo()])
    const { flowId, imageId } = setupProject('Misto')
    F().setCast(flowId, imageId, [ana])
    F().addReferenceNode(flowId, { x: 0, y: 300 })
    const refId = F().flowsData[flowId].nodes.at(-1)!.id
    F().updateReferenceData(flowId, refId, { label: 'Pote', role: 'object' })
    const potBytes = pngBytes(300, 300, 777)
    await F().addReferenceImages(flowId, refId, [{ name: 'pote.png', arrayBuffer: async () => potBytes.slice().buffer }])
    F().onConnect(flowId, { source: refId, sourceHandle: 'ref-out', target: imageId, targetHandle: 'refs-in' })
    await F().generate(flowId, imageId)
    const req = cap.requests.at(-1)!
    expect(req.prompt).toContain('Image 1: "Ana"')
    expect(req.prompt).toContain('Image 2: "Pote" — object')
    expect(base64ToBytes(req.references![1].b64)).toEqual(potBytes)

    const many = []
    for (const n of ['E', 'F', 'G', 'H', 'I', 'J']) many.push(await createCharacter(n, [photo()]))
    F().setCast(flowId, imageId, many)
    await F().generate(flowId, imageId)
    expect(imgNode(flowId, imageId).data.notice).toMatch(/precisa de 7 fotos/)
  })

  it('a imagem gerada guarda a ficha como estava; editar o personagem depois não muda esse registro', async () => {
    const id = await createCharacter('Lia', [photo()], { hair: 'ruivo' })
    const { flowId, imageId } = setupProject('Histórico')
    F().setCast(flowId, imageId, [id])
    await F().generate(flowId, imageId)
    const slot = imgNode(flowId, imageId).data.images[0]
    const c = C().characters.find((x) => x.id === id)!
    await C().saveCharacter({ id, sheet: { ...emptySheet(), name: 'Lia', hair: 'loiro' }, photos: [{ kind: 'existing', photoId: c.photos[0].id }], primaryIndex: 0 })
    const asset = await repository.getAsset(slot.assetId!)
    expect(asset?.source?.characters?.[0]).toMatchObject({ characterId: id, version: 1, sheet: { hair: 'ruivo' } })
  })

  it('excluir personagem usado: avisa os projetos, o nó mostra erro claro e as imagens geradas ficam', async () => {
    const id = await createCharacter('Rui', [photo()])
    const { flowId, imageId } = setupProject('Exclusão')
    F().setCast(flowId, imageId, [id])
    await F().generate(flowId, imageId)
    const generated = imgNode(flowId, imageId).data.images[0].assetId!
    expect(projectsUsingCharacter(id)).toEqual([{ flowId, flowName: 'Exclusão', nodeCount: 1 }])

    await C().deleteCharacter(id)
    expect(imgNode(flowId, imageId).data.castIds).toEqual([id]) // não some em silêncio
    const before = cap.requests.length
    await F().generate(flowId, imageId)
    expect(cap.requests.length).toBe(before)
    expect(imgNode(flowId, imageId).data.notice).toMatch(/foi excluído da biblioteca/)
    expect(await repository.getAsset(generated)).toBeDefined()

    F().setCast(flowId, imageId, [])
    await F().generate(flowId, imageId)
    expect(cap.requests.length).toBe(before + 1)
  })

  it('guia de estilo do projeto entra no prompt; projeto novo nasce em 9:16', async () => {
    const id = await createCharacter('Gil', [photo()])
    const { flowId } = setupProject('Com guia', true)
    F().addImageNode(flowId, { x: 0, y: 500 })
    const node = F().flowsData[flowId].nodes.at(-1) as ImageFlowNode
    expect(node.data.size).toBe('1024x1536')
    const prompt = F().flowsData[flowId].nodes.find((n) => n.type === 'prompt')!.id
    F().onConnect(flowId, { source: prompt, sourceHandle: 'prompt-out', target: node.id, targetHandle: 'prompt-in' })
    F().setCast(flowId, node.id, [id])
    F().updateStyleGuide(flowId, { environment: 'cozinha clara' })
    await F().generate(flowId, node.id)
    const req = cap.requests.at(-1)!
    expect(req.prompt).toContain('Photorealistic, natural photograph')
    expect(req.prompt).toContain('Recurring environment details: cozinha clara')
    expect(req.prompt).toContain('Do not add any text')
    expect(req.prompt.endsWith('Scene: Maria e João conversam na cozinha')).toBe(true)
  })

  it('a pré-visualização mostra exatamente o que a geração usa', async () => {
    const id = await createCharacter('Téo', [photo(), photo()])
    const { flowId, imageId } = setupProject('Prévia', true)
    F().setCast(flowId, imageId, [id])
    const preview = F().getGenerationPreview(flowId, imageId)
    if ('error' in preview) throw new Error(preview.error)
    expect(preview.style?.aspect).toBe('9:16')
    expect(preview.images.map((i) => i.ownerLabel)).toEqual(['Téo', 'Téo'])
    await F().generate(flowId, imageId)
    expect(cap.requests.at(-1)!.prompt).toBe(preview.prompt)
    expect(cap.requests.at(-1)!.references!.map((r) => r.sha256)).toEqual(preview.images.map((i) => i.sha256))
  })

  it('modelo sem suporte a referências com personagens: aviso e nenhuma chamada', async () => {
    const id = await createCharacter('Ivo', [photo()])
    const { flowId, imageId } = setupProject('DALL-E')
    F().updateImageConfig(flowId, imageId, { model: 'dall-e-3', size: '1024x1024' })
    F().setCast(flowId, imageId, [id])
    const before = cap.requests.length
    await F().generate(flowId, imageId)
    expect(cap.requests.length).toBe(before)
    expect(imgNode(flowId, imageId).data.notice).toMatch(/não aceita imagens de referência/)
  })
})

describe('exportação ZIP do projeto inclui as entradas', () => {
  it('fotos de referência, fotos e ficha dos personagens e guia de estilo', async () => {
    const maria = await createCharacter('Maria ZIP', [pngBytes(100, 100, 4001), jpegBytes(200, 200, 4002)], { hair: 'grisalho' })
    const { flowId, imageId } = setupProject('ZIP', true)
    F().setCast(flowId, imageId, [maria])
    F().addReferenceNode(flowId, { x: 0, y: 300 })
    const refId = F().flowsData[flowId].nodes.at(-1)!.id
    F().updateReferenceData(flowId, refId, { label: 'Pote verde', role: 'object' })
    const pot = webpBytes(320, 240, 4003)
    await F().addReferenceImages(flowId, refId, [{ name: 'pote.webp', arrayBuffer: async () => pot.slice().buffer }])
    await F().generate(flowId, imageId)

    const { buildProjectZip } = await import('../../export/projectZip')
    const state = F()
    const result = await buildProjectZip({
      meta: state.flows.find((f) => f.id === flowId)!,
      slice: state.flowsData[flowId],
      loadAsset: (id) => repository.getAsset(id),
      characters: C().characters,
    })
    const zip = await JSZip.loadAsync(result.data)
    const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort()
    expect(files.some((f) => /^referencias\/01_pote-verde\/01_pote\.webp$/.test(f))).toBe(true)
    expect(files.filter((f) => f.startsWith('personagens/maria-zip_'))).toHaveLength(2)
    expect(result.manifest.characters[0]).toMatchObject({ name: 'Maria ZIP', sheet: { hair: 'grisalho' }, deletedFromLibrary: false })
    expect(result.manifest.styleGuide?.aspect).toBe('9:16')
    const refFile = result.manifest.referenceNodes[0].files[0]
    expect(await sha256Hex(await zip.file(refFile.file)!.async('uint8array'))).toBe(await sha256Hex(pot))
  })
})
