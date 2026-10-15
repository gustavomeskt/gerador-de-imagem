import { getSizeOption, MODEL_MAX_N, splitIntoBatches, type ImageModel } from './models'
import type { InputFidelity, ReferenceImageInput } from './references'
import type { GeneratedImage, ImageProvider } from './types'

// Orquestra uma geração de N imagens, independente do provedor: divide em
// chamadas pelo limite do modelo, recorta quando a proporção pedida não é
// nativa e devolve um resultado POR IMAGEM — uma chamada que falha não
// derruba as que deram certo.

export interface ImageGenerationConfig {
  model: ImageModel
  size: string
  quality?: string
}

export type ImageResult = { ok: true; image: GeneratedImage } | { ok: false; error: string }

export type CropFn = (src: string, targetAspect: number) => Promise<string>

export interface RunGenerationParams {
  provider: ImageProvider
  config: ImageGenerationConfig
  prompt: string
  count: number
  crop: CropFn
  // orçamento confirmado pela pessoa (provedores pagos)
  quoteId?: string
  // fotos de referência (vão em todas as chamadas do trabalho)
  references?: ReferenceImageInput[]
  inputFidelity?: InputFidelity
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

// Proporção final que a imagem vai ter (depois do recorte, se houver).
export function resolveAspect(config: ImageGenerationConfig): number {
  return getSizeOption(config.model, config.size)?.aspect ?? 1
}

export async function runGeneration(params: RunGenerationParams): Promise<ImageResult[]> {
  const { provider, config, prompt, count, crop, quoteId, references, inputFidelity } = params
  const sizeOption = getSizeOption(config.model, config.size)
  const batches = splitIntoBatches(count, MODEL_MAX_N[config.model])

  const settled = await Promise.allSettled(
    batches.map((n) =>
      provider.generateImages(
        {
          model: config.model,
          prompt,
          size: config.size,
          quality: config.quality,
          n,
          ...(references?.length ? { references, ...(inputFidelity ? { inputFidelity } : {}) } : {}),
        },
        quoteId ? { quoteId } : undefined,
      ),
    ),
  )

  const results: ImageResult[] = []
  settled.forEach((outcome, batchIndex) => {
    const expected = batches[batchIndex]
    if (outcome.status === 'rejected') {
      const error = errorMessage(outcome.reason, 'Falha ao gerar imagens')
      for (let i = 0; i < expected; i++) results.push({ ok: false, error })
      return
    }
    const images = outcome.value.slice(0, expected)
    for (const image of images) results.push({ ok: true, image })
    for (let i = images.length; i < expected; i++) results.push({ ok: false, error: 'Sem resposta' })
  })

  // tamanhos 9:16/16:9 vêm de um recorte no centro — a API não gera esses
  // dois formatos nativamente
  if (!sizeOption?.crop) return results

  return Promise.all(
    results.map(async (result): Promise<ImageResult> => {
      if (!result.ok) return result
      try {
        const src = await crop(result.image.src, sizeOption.aspect)
        return { ok: true, image: { src, mimeType: 'image/png' } }
      } catch (err) {
        return { ok: false, error: errorMessage(err, 'Falha ao recortar a imagem') }
      }
    }),
  )
}
