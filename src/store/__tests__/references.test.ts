import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CostQuote, ImageGenerationRequest, ImageJob, ImageProvider } from '../../generation/types'
import { base64ToBytes, sha256Hex } from '../../lib/binary'
import { repository } from '../../persistence/repository'
import { fileFrom, jpegBytes, pngBytes, svgImage, webpBytes } from '../../test/fixtures'
import { useFlowStore, type ImageFlowNode, type ReferenceFlowNode } from '../useFlowStore'

// Provedor de teste que registra tudo o que recebe (inclusive as fotos).
const cap = vi.hoisted(() => ({
  paid: false,
  fail: false,
  requests: [] as ImageGenerationRequest[],
  quotes: [] as ImageJob[],
  quoteIds: [] as Array<string | undefined>,
}))

vi.mock('../../generation/providers', () => {
  const provider: ImageProvider & { quoteImages?: (job: ImageJob) => Promise<CostQuote> } = {
    kind: 'mock',
    label: 'captura',
    async generateImages(request, options) {
      cap.requests.push(request)
      cap.quoteIds.push(options?.quoteId)
      if (cap.fail) throw new Error('falhou de propósito')
      return Array.from({ length: request.n }, (_, i) => svgImage(`gerada-${cap.requests.length}-${i}`))
    },
    async enhancePrompt(p) {
      return p
    },
  }
  const paidProvider: ImageProvider = {
    ...provider,
    kind: 'backend',
    async quoteImages(job: ImageJob) {
      cap.quotes.push(job)
      return {
        quoteId: `q-${cap.quotes.length}`,
        kind: 'images',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        mode: 'openai',
        paid: true,
        estimatedUsd: 0.1,
        images: job.totalImages,
        breakdown: [],
        notes: [],
      }
    },
  }
  return {
    getProvider: () => (cap.paid ? paidProvider : provider),
    isProviderKind: (v: unknown) => v === 'mock' || v === 'backend',
    DEFAULT_PROVIDER: 'mock',
    PROVIDER_KINDS: ['mock', 'backend'],
    backendProvider: paidProvider,
  }
})
vi.mock('../../lib/image', async () => ({ cropToAspect: (await import('./testProvider')).fakeCrop }))

await useFlowStore.getState().hydrate()

const S = () => useFlowStore.getState()
const nodeOf = <T,>(flowId: string, id: string) => S().flowsData[flowId].nodes.find((n) => n.id === id) as T
const refNode = (flowId: string, id: string) => nodeOf<ReferenceFlowNode>(flowId, id)
const imgNode = (flowId: string, id: string) => nodeOf<ImageFlowNode>(flowId, id)

function setup(model: 'gpt-image-1.5' | 'gpt-image-1-mini' | 'dall-e-3' = 'gpt-image-1.5') {
  const flowId = S().createFlow()
  S().updateStyleGuide(flowId, { enabled: false }) // guia de estilo testado à parte
  S().addPromptNode(flowId, { x: 0, y: 0 })
  S().addImageNode(flowId, { x: 400, y: 0 })
  const [p, i] = S().flowsData[flowId].nodes
  S().updatePromptData(flowId, p.id, { prompt: 'Maria sorri na cozinha' })
  S().updateImageConfig(flowId, i.id, { model, size: model === 'dall-e-3' ? '1024x1024' : '1024x1536', count: 1 })
  S().onConnect(flowId, { source: p.id, sourceHandle: 'prompt-out', target: i.id, targetHandle: 'prompt-in' })
  return { flowId, imageId: i.id }
}

function addRef(flowId: string, label: string, role: 'character' | 'clothing' | 'object' | 'style' = 'character') {
  S().addReferenceNode(flowId, { x: 0, y: 300 })
  const nodes = S().flowsData[flowId].nodes
  const id = nodes[nodes.length - 1].id
  S().updateReferenceData(flowId, id, { label, role })
  return id
}

function connectRef(flowId: string, refId: string, imageId: string) {
  S().onConnect(flowId, { source: refId, sourceHandle: 'ref-out', target: imageId, targetHandle: 'refs-in' })
}

beforeEach(() => {
  cap.paid = false
  cap.fail = false
  cap.requests.length = 0
  cap.quotes.length = 0
  cap.quoteIds.length = 0
})

describe('upload de referências', () => {
  it('uma foto: guarda no IndexedDB (tipo referência, bytes e hash) e mostra a prévia', async () => {
    const { flowId } = setup()
    const refId = addRef(flowId, 'Maria')
    const photo = pngBytes(800, 1200, 1)
    await S().addReferenceImages(flowId, refId, [fileFrom('maria.png', photo)])

    const [img] = refNode(flowId, refId).data.images
    expect(img).toMatchObject({ name: 'maria.png', mimeType: 'image/png', width: 800, height: 1200, byteLength: photo.byteLength })
    expect(img.sha256).toBe(await sha256Hex(photo))
    expect(img.src).toBeTruthy()
    const asset = await repository.getAsset(img.assetId!)
    expect(asset).toMatchObject({ kind: 'reference', projectId: flowId, sha256: img.sha256, reference: { nodeId: refId, name: 'maria.png' } })
    expect(new Uint8Array(asset!.bytes)).toEqual(photo)
  })

  it('várias fotos de uma vez (PNG, JPG e WebP)', async () => {
    const { flowId } = setup()
    const refId = addRef(flowId, 'Maria')
    await S().addReferenceImages(flowId, refId, [
      fileFrom('a.png', pngBytes(100, 100, 1)),
      fileFrom('b.jpg', jpegBytes(200, 300, 2)),
      fileFrom('c.webp', webpBytes(640, 480, 3)),
    ])
    expect(refNode(flowId, refId).data.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(refNode(flowId, refId).data.notice).toBeUndefined()
  })

  it('arquivos inválidos são recusados com aviso e não são salvos', async () => {
    const { flowId } = setup()
    const refId = addRef(flowId, 'Maria')
    const big = new Uint8Array(8 * 1024 * 1024 + 1)
    big.set(pngBytes(10, 10))
    await S().addReferenceImages(flowId, refId, [
      fileFrom('anim.gif', new TextEncoder().encode('GIF89a....')),
      fileFrom('notas.txt', new TextEncoder().encode('texto')),
      fileFrom('enorme.png', big),
      fileFrom('ok.png', pngBytes(50, 50, 9)),
    ])
    const node = refNode(flowId, refId)
    expect(node.data.images.map((i) => i.name)).toEqual(['ok.png'])
    expect(node.data.notice).toMatch(/anim\.gif: formato não suportado/)
    expect(node.data.notice).toMatch(/notas\.txt/)
    expect(node.data.notice).toMatch(/enorme\.png: maior que 8 MB/)
    const stored = (await repository.listAssetsByProject(flowId)).filter((a) => a.kind === 'reference')
    expect(stored).toHaveLength(1)
  })

  it('limite de fotos por nó e foto repetida no mesmo nó', async () => {
    const { flowId } = setup()
    const refId = addRef(flowId, 'Maria')
    const files = [1, 2, 3, 4, 5, 6, 7].map((n) => fileFrom(`f${n}.png`, pngBytes(10, 10, n)))
    await S().addReferenceImages(flowId, refId, files)
    expect(refNode(flowId, refId).data.images).toHaveLength(6)
    expect(refNode(flowId, refId).data.notice).toMatch(/f7\.png: limite de 6/)

    const other = addRef(flowId, 'João')
    await S().addReferenceImages(flowId, other, [fileFrom('x.png', pngBytes(10, 10, 50)), fileFrom('x-de-novo.png', pngBytes(10, 10, 50))])
    expect(refNode(flowId, other).data.images).toHaveLength(1)
    expect(refNode(flowId, other).data.notice).toMatch(/já está neste nó/)
  })

  it('a mesma foto em dois nós usa um arquivo só; só é apagada quando ninguém mais usa', async () => {
    const { flowId } = setup()
    const a = addRef(flowId, 'Maria (frente)')
    const b = addRef(flowId, 'Maria (perfil)')
    const photo = pngBytes(300, 300, 7)
    await S().addReferenceImages(flowId, a, [fileFrom('m.png', photo)])
    await S().addReferenceImages(flowId, b, [fileFrom('m-copia.png', photo)])
    const assetA = refNode(flowId, a).data.images[0].assetId
    expect(refNode(flowId, b).data.images[0].assetId).toBe(assetA)
    expect((await repository.listAssetsByProject(flowId)).filter((x) => x.kind === 'reference')).toHaveLength(1)

    S().removeReferenceImage(flowId, a, refNode(flowId, a).data.images[0].id)
    await new Promise((r) => setTimeout(r, 20))
    expect(await repository.getAsset(assetA!)).toBeDefined()

    S().removeReferenceImage(flowId, b, refNode(flowId, b).data.images[0].id)
    await vi.waitFor(async () => expect(await repository.getAsset(assetA!)).toBeUndefined())
  })

  it('substituir uma foto mantém a posição e apaga o arquivo antigo', async () => {
    const { flowId } = setup()
    const refId = addRef(flowId, 'Maria')
    await S().addReferenceImages(flowId, refId, [fileFrom('1.png', pngBytes(10, 10, 1)), fileFrom('2.png', pngBytes(10, 10, 2))])
    const [first, second] = refNode(flowId, refId).data.images
    await S().replaceReferenceImage(flowId, refId, first.id, fileFrom('nova.jpg', jpegBytes(400, 500, 3)))
    const images = refNode(flowId, refId).data.images
    expect(images.map((i) => [i.id, i.name])).toEqual([
      [first.id, 'nova.jpg'],
      [second.id, '2.png'],
    ])
    await vi.waitFor(async () => expect(await repository.getAsset(first.assetId!)).toBeUndefined())

    await S().replaceReferenceImage(flowId, refId, second.id, fileFrom('ruim.txt', new TextEncoder().encode('x')))
    expect(refNode(flowId, refId).data.images[1].name).toBe('2.png')
    expect(refNode(flowId, refId).data.notice).toMatch(/ruim\.txt/)
  })
})

describe('conexões', () => {
  it('várias referências por nó de imagem; tipos de conexão errados são ignorados', () => {
    const { flowId, imageId } = setup()
    const a = addRef(flowId, 'A')
    const b = addRef(flowId, 'B')
    connectRef(flowId, a, imageId)
    connectRef(flowId, b, imageId)
    connectRef(flowId, a, imageId) // repetida
    S().onConnect(flowId, { source: a, sourceHandle: 'ref-out', target: imageId, targetHandle: 'prompt-in' }) // errada
    const refEdges = S().flowsData[flowId].edges.filter((e) => e.targetHandle === 'refs-in')
    expect(refEdges.map((e) => e.source)).toEqual([a, b])
    expect(S().flowsData[flowId].edges.filter((e) => e.targetHandle === 'prompt-in')).toHaveLength(1)
  })
})

describe('geração com referências', () => {
  it('cada nó de imagem recebe só as suas referências, com os bytes reais, personagem primeiro', async () => {
    const { flowId, imageId } = setup()
    S().addImageNode(flowId, { x: 400, y: 400 })
    const image2 = S().flowsData[flowId].nodes.at(-1)!.id
    const prompt = S().flowsData[flowId].nodes.find((n) => n.type === 'prompt')!.id
    S().onConnect(flowId, { source: prompt, sourceHandle: 'prompt-out', target: image2, targetHandle: 'prompt-in' })
    S().updateImageConfig(flowId, image2, { model: 'gpt-image-1.5', size: '1024x1536', count: 1 })

    const pot = addRef(flowId, 'Pote de gelatina', 'object')
    const maria = addRef(flowId, 'Maria', 'character')
    const joao = addRef(flowId, 'João', 'character')
    const potPhoto = pngBytes(500, 500, 1)
    const mariaPhotos = [jpegBytes(800, 1200, 2), webpBytes(900, 1200, 3)]
    const joaoPhoto = pngBytes(700, 700, 4)
    await S().addReferenceImages(flowId, pot, [fileFrom('pote.png', potPhoto)])
    await S().addReferenceImages(flowId, maria, [fileFrom('m1.jpg', mariaPhotos[0]), fileFrom('m2.webp', mariaPhotos[1])])
    await S().addReferenceImages(flowId, joao, [fileFrom('j.png', joaoPhoto)])

    connectRef(flowId, pot, imageId) // conectado antes, mas é objeto
    connectRef(flowId, maria, imageId)
    connectRef(flowId, joao, image2)

    await S().generate(flowId, imageId)
    const req = cap.requests.at(-1)!
    expect(req.references?.map((r) => base64ToBytes(r.b64))).toEqual([...mariaPhotos, potPhoto])
    expect(req.references?.map((r) => [r.mimeType, r.width, r.height])).toEqual([
      ['image/jpeg', 800, 1200],
      ['image/webp', 900, 1200],
      ['image/png', 500, 500],
    ])
    expect(req.prompt).toContain('Images 1-2: "Maria"')
    expect(req.prompt).toContain('Image 3: "Pote de gelatina"')
    expect(req.prompt).toContain('Scene: Maria sorri na cozinha')
    expect(req.prompt).not.toContain('João')
    expect(req.inputFidelity).toBe('high')

    await S().generate(flowId, image2)
    const req2 = cap.requests.at(-1)!
    expect(req2.references?.map((r) => base64ToBytes(r.b64))).toEqual([joaoPhoto])
    expect(req2.prompt).toContain('"João"')
  })

  it('a imagem gerada guarda quais referências foram usadas', async () => {
    const { flowId, imageId } = setup()
    const maria = addRef(flowId, 'Maria')
    await S().addReferenceImages(flowId, maria, [fileFrom('m.png', pngBytes(10, 10, 5))])
    connectRef(flowId, maria, imageId)
    await S().generate(flowId, imageId)
    const slot = imgNode(flowId, imageId).data.images[0]
    const asset = await repository.getAsset(slot.assetId!)
    expect(asset?.source?.references).toEqual([
      { assetId: refNode(flowId, maria).data.images[0].assetId, sha256: refNode(flowId, maria).data.images[0].sha256, label: 'Maria', role: 'character' },
    ])
    expect(asset?.source?.inputFidelity).toBe('high')
  })

  it('sem referências conectadas, a geração tradicional não muda', async () => {
    const { flowId, imageId } = setup()
    await S().generate(flowId, imageId)
    expect(cap.requests.at(-1)?.references).toBeUndefined()
    expect(cap.requests.at(-1)?.prompt).toBe('Maria sorri na cozinha')
  })

  it('modelo incompatível (DALL-E) avisa e não chama o provedor', async () => {
    const { flowId, imageId } = setup('dall-e-3')
    const maria = addRef(flowId, 'Maria')
    await S().addReferenceImages(flowId, maria, [fileFrom('m.png', pngBytes(10, 10, 6))])
    connectRef(flowId, maria, imageId)
    await S().generate(flowId, imageId)
    expect(cap.requests).toHaveLength(0)
    expect(imgNode(flowId, imageId).data.notice).toMatch(/DALL-E 3 não aceita imagens de referência/)
  })

  it('gpt-image-1-mini envia as fotos sem input_fidelity; nó de referência vazio é avisado', async () => {
    const { flowId, imageId } = setup('gpt-image-1-mini')
    const maria = addRef(flowId, 'Maria')
    connectRef(flowId, maria, imageId)
    await S().generate(flowId, imageId)
    expect(imgNode(flowId, imageId).data.notice).toMatch(/"Maria" está sem fotos/)
    expect(cap.requests).toHaveLength(0)

    await S().addReferenceImages(flowId, maria, [fileFrom('m.png', pngBytes(10, 10, 8))])
    await S().generate(flowId, imageId)
    expect(cap.requests.at(-1)?.references).toHaveLength(1)
    expect(cap.requests.at(-1)?.inputFidelity).toBeUndefined()
  })

  it('fidelidade baixa escolhida no nó é respeitada', async () => {
    const { flowId, imageId } = setup()
    const maria = addRef(flowId, 'Maria')
    await S().addReferenceImages(flowId, maria, [fileFrom('m.png', pngBytes(10, 10, 9))])
    connectRef(flowId, maria, imageId)
    S().updateImageConfig(flowId, imageId, { inputFidelity: 'low' })
    await S().generate(flowId, imageId)
    expect(cap.requests.at(-1)?.inputFidelity).toBe('low')
  })

  it('regerar uma imagem reenvia as referências e preserva as outras; se falhar, mantém a anterior', async () => {
    const { flowId, imageId } = setup()
    S().updateImageConfig(flowId, imageId, { count: 2 })
    const maria = addRef(flowId, 'Maria')
    const photo = pngBytes(10, 10, 10)
    await S().addReferenceImages(flowId, maria, [fileFrom('m.png', photo)])
    connectRef(flowId, maria, imageId)
    await S().generate(flowId, imageId)
    const [approved, other] = imgNode(flowId, imageId).data.images

    await S().regenerateSlot(flowId, imageId, other.id)
    const req = cap.requests.at(-1)!
    expect(req.n).toBe(1)
    expect(req.references?.map((r) => base64ToBytes(r.b64))).toEqual([photo])
    expect(imgNode(flowId, imageId).data.images[0]).toEqual(approved)

    const current = imgNode(flowId, imageId).data.images[1]
    cap.fail = true
    await S().regenerateSlot(flowId, imageId, current.id)
    expect(imgNode(flowId, imageId).data.images[1]).toEqual(current)
    expect(imgNode(flowId, imageId).data.images[0]).toEqual(approved)
    expect(imgNode(flowId, imageId).data.notice).toMatch(/imagem anterior foi mantida/)
  })

  it('apagar o nó de imagem não apaga as fotos de referência', async () => {
    const { flowId, imageId } = setup()
    const maria = addRef(flowId, 'Maria')
    await S().addReferenceImages(flowId, maria, [fileFrom('m.png', pngBytes(10, 10, 11))])
    connectRef(flowId, maria, imageId)
    await S().generate(flowId, imageId)
    const refAsset = refNode(flowId, maria).data.images[0].assetId!
    S().deleteNode(flowId, imageId)
    await new Promise((r) => setTimeout(r, 20))
    expect(await repository.getAsset(refAsset)).toBeDefined()
  })
})

describe('controle de custos com referências', () => {
  it('o orçamento leva só a identificação das fotos (sem bytes) e a geração usa o orçamento confirmado', async () => {
    cap.paid = true
    const { flowId, imageId } = setup()
    const maria = addRef(flowId, 'Maria')
    const photo = jpegBytes(800, 1200, 12)
    await S().addReferenceImages(flowId, maria, [fileFrom('m.jpg', photo)])
    connectRef(flowId, maria, imageId)

    const running = S().generate(flowId, imageId)
    await vi.waitFor(() => expect(S().costConfirmation).not.toBeNull())
    expect(S().costConfirmation?.title).toBe('Gerar 1 imagem(ns) com 1 referência(s)')
    const job = cap.quotes[0]
    expect(job.references).toEqual([
      { sha256: await sha256Hex(photo), mimeType: 'image/jpeg', byteLength: photo.byteLength, width: 800, height: 1200 },
    ])
    expect(JSON.stringify(job)).not.toContain('b64')
    expect(job.inputFidelity).toBe('high')
    expect(job.prompt).toContain('"Maria"')
    expect(cap.requests).toHaveLength(0)

    S().resolveCostConfirmation(true)
    await running
    expect(cap.quoteIds.at(-1)).toBe('q-1')
    expect(cap.requests.at(-1)?.prompt).toBe(job.prompt)
    expect(base64ToBytes(cap.requests.at(-1)!.references![0].b64)).toEqual(photo)
  })
})
