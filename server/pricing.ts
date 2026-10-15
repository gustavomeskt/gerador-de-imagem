import { readFileSync } from 'node:fs'
import { MODEL_MAX_N, type ImageModel } from '../src/generation/models'
import type { InputFidelity, ReferenceDescriptor } from '../src/generation/references'
import { ENHANCE_MAX_PROMPT_CHARS } from './validation'
import { STORY_INTERPRETER_SYSTEM, STORY_JSON_SCHEMA } from '../src/story/llmRequest'
import { PROMPT_ENHANCER_MAX_OUTPUT_TOKENS, PROMPT_ENHANCER_MODEL, PROMPT_ENHANCER_SYSTEM } from '../src/generation/openaiRequest'

// Estimativa de custo em dólares (USD). É uma ESTIMATIVA: os preços da OpenAI
// mudam, e a cobrança real vem da fatura da OpenAI. Os valores abaixo são de
// referência e podem ser corrigidos sem mexer no código, apontando
// PRICE_TABLE_FILE para um JSON com o mesmo formato de DEFAULT_PRICES.
//
// Pra errar pro lado seguro: qualidade "auto" (ou não informada) é cobrada
// como "high", e modelos sem preço confirmado usam o valor do modelo mais
// caro da mesma família.

export const PRICES_REFERENCE_DATE = '2026-10'
export const PRICES_SOURCE = 'https://openai.com/api/pricing'

export interface PriceTable {
  // preço por imagem: modelo → qualidade → tamanho → USD
  images: Record<string, Record<string, Record<string, number>>>
  // texto do prompt (modelos gpt-image): USD por 1 milhão de tokens de entrada
  imagePromptPerMTokens: Record<string, number>
  // imagens de referência (entrada da edição): USD por 1 milhão de tokens de imagem
  imageInputPerMTokens: Record<string, number>
  // tokens estimados por imagem de referência (limite superior): base, e o
  // adicional cobrado quando input_fidelity = "high"
  referenceTokens: { base: number; highFidelityExtra: number }
  // melhorador de prompt: USD por 1 milhão de tokens
  enhancer: { inputPerMTokens: number; outputPerMTokens: number }
  // interpretação de historinhas: USD por 1 milhão de tokens, por modelo
  // ("default" vale para modelos sem preço na tabela)
  story: Record<string, { inputPerMTokens: number; outputPerMTokens: number }>
}

const GPT_IMAGE_1: Record<string, Record<string, number>> = {
  low: { '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 },
  medium: { '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 },
  high: { '1024x1024': 0.167, '1024x1536': 0.25, '1536x1024': 0.25 },
}

export const DEFAULT_PRICES: PriceTable = {
  images: {
    // gpt-image-1.5: estimado com os valores do gpt-image-1 (limite superior)
    'gpt-image-1.5': GPT_IMAGE_1,
    'gpt-image-1': GPT_IMAGE_1,
    'gpt-image-1-mini': {
      low: { '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 },
      medium: { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 },
      high: { '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 },
    },
    'dall-e-3': {
      standard: { '1024x1024': 0.04, '1024x1792': 0.08, '1792x1024': 0.08 },
      hd: { '1024x1024': 0.08, '1024x1792': 0.12, '1792x1024': 0.12 },
    },
    'dall-e-2': {
      standard: { '256x256': 0.016, '512x512': 0.018, '1024x1024': 0.02 },
    },
  },
  imagePromptPerMTokens: { 'gpt-image-1.5': 5, 'gpt-image-1': 5, 'gpt-image-1-mini': 2 },
  // gpt-image-1.5 orçado com o valor do gpt-image-1 (limite superior)
  imageInputPerMTokens: { 'gpt-image-1.5': 10, 'gpt-image-1': 10, 'gpt-image-1-mini': 2.5 },
  referenceTokens: { base: 1000, highFidelityExtra: 6240 },
  enhancer: { inputPerMTokens: 0.25, outputPerMTokens: 2 },
  story: {
    'gpt-5-mini': { inputPerMTokens: 0.25, outputPerMTokens: 2 },
    'gpt-5': { inputPerMTokens: 1.25, outputPerMTokens: 10 },
    // modelo desconhecido: orçado com um valor alto (lado seguro)
    default: { inputPerMTokens: 2.5, outputPerMTokens: 15 },
  },
}

export function loadPriceTable(file: string | undefined): PriceTable {
  if (!file) return DEFAULT_PRICES
  const custom = JSON.parse(readFileSync(file, 'utf8')) as Partial<PriceTable>
  return {
    images: { ...DEFAULT_PRICES.images, ...custom.images },
    imagePromptPerMTokens: { ...DEFAULT_PRICES.imagePromptPerMTokens, ...custom.imagePromptPerMTokens },
    imageInputPerMTokens: { ...DEFAULT_PRICES.imageInputPerMTokens, ...custom.imageInputPerMTokens },
    referenceTokens: { ...DEFAULT_PRICES.referenceTokens, ...custom.referenceTokens },
    enhancer: { ...DEFAULT_PRICES.enhancer, ...custom.enhancer },
    story: { ...DEFAULT_PRICES.story, ...custom.story },
  }
}

// ~4 caracteres por token; arredonda pra cima
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function pricingQuality(model: ImageModel, quality: string | undefined): string {
  if (model === 'dall-e-2') return 'standard'
  if (model === 'dall-e-3') return quality ?? 'standard'
  return !quality || quality === 'auto' ? 'high' : quality
}

export interface Estimate {
  usd: number
  breakdown: string[]
  notes: string[]
}

const usd = (v: number) => `US$ ${v.toFixed(4)}`

export function estimateImageJob(
  job: {
    model: ImageModel
    prompt: string
    size: string
    quality?: string
    totalImages: number
    references?: ReferenceDescriptor[]
    inputFidelity?: InputFidelity
  },
  prices: PriceTable,
): Estimate {
  const quality = pricingQuality(job.model, job.quality)
  const unit = prices.images[job.model]?.[quality]?.[job.size]
  if (unit === undefined) {
    throw new Error(`Sem preço de referência para ${job.model} / ${quality} / ${job.size}.`)
  }

  const breakdown = [`${job.totalImages} × ${usd(unit)} (${job.model}, ${quality}, ${job.size})`]
  const notes = [`Estimativa com preços de referência (${PRICES_REFERENCE_DATE}); a cobrança real é a da fatura da OpenAI.`]
  let total = unit * job.totalImages

  const promptRate = prices.imagePromptPerMTokens[job.model]
  if (promptRate) {
    const calls = Math.ceil(job.totalImages / MODEL_MAX_N[job.model])
    const promptCost = (estimateTokens(job.prompt) * calls * promptRate) / 1_000_000
    total += promptCost
    breakdown.push(`texto do prompt: ~${estimateTokens(job.prompt)} tokens × ${calls} chamada(s) = ${usd(promptCost)}`)
  }
  // referências: as fotos são reenviadas em cada chamada e cobradas como
  // tokens de imagem de entrada (bem mais com fidelidade alta)
  const refs = job.references ?? []
  if (refs.length > 0) {
    const calls = Math.ceil(job.totalImages / MODEL_MAX_N[job.model])
    const perImage = prices.referenceTokens.base + (job.inputFidelity === 'high' ? prices.referenceTokens.highFidelityExtra : 0)
    const rate = prices.imageInputPerMTokens[job.model] ?? 0
    const refCost = (refs.length * perImage * calls * rate) / 1_000_000
    total += refCost
    breakdown.push(
      `${refs.length} referência(s) × ~${perImage} tokens × ${calls} chamada(s)` +
        `${job.inputFidelity === 'high' ? ' (fidelidade alta)' : ''} = ${usd(refCost)}`,
    )
    notes.push('Referências orçadas pelo limite superior de tokens por imagem; o valor real tende a ser menor.')
  }
  if (!job.quality || job.quality === 'auto') notes.push('Qualidade "auto" foi orçada como "high" (pior caso).')
  if (job.model === 'gpt-image-1.5') notes.push('gpt-image-1.5 orçado com a tabela do gpt-image-1 (limite superior).')

  return { usd: total, breakdown, notes }
}

// Pior caso do melhorador: prompt máximo de entrada + teto de saída.
export function estimateEnhance(prompt: string, prices: PriceTable): Estimate {
  const inputTokens = estimateTokens(PROMPT_ENHANCER_SYSTEM) + estimateTokens(prompt.slice(0, ENHANCE_MAX_PROMPT_CHARS))
  const inputCost = (inputTokens * prices.enhancer.inputPerMTokens) / 1_000_000
  const outputCost = (PROMPT_ENHANCER_MAX_OUTPUT_TOKENS * prices.enhancer.outputPerMTokens) / 1_000_000
  return {
    usd: inputCost + outputCost,
    breakdown: [
      `entrada: ~${inputTokens} tokens = ${usd(inputCost)}`,
      `saída (teto de ${PROMPT_ENHANCER_MAX_OUTPUT_TOKENS} tokens) = ${usd(outputCost)}`,
    ],
    notes: [`Modelo ${PROMPT_ENHANCER_MODEL}; valor máximo — o real costuma ser menor.`],
  }
}

// Pior caso da interpretação: cada parte da copy é uma chamada, com o texto
// das instruções + esquema + a parte + os nomes da biblioteca, e o teto de
// saída inteiro cobrado em cada chamada (modelos de raciocínio contam os
// tokens de raciocínio como saída).
export function estimateStory(
  input: { chunks: string[]; libraryNames: string[]; model: string; maxOutputTokens: number },
  prices: PriceTable,
): Estimate {
  const rate = prices.story[input.model] ?? prices.story.default
  const fixed =
    estimateTokens(STORY_INTERPRETER_SYSTEM) + estimateTokens(JSON.stringify(STORY_JSON_SCHEMA)) + estimateTokens(input.libraryNames.join(', ')) + 100
  const inputTokens = input.chunks.reduce((sum, chunk) => sum + fixed + estimateTokens(chunk), 0)
  const outputTokens = input.chunks.length * input.maxOutputTokens
  const inputCost = (inputTokens * rate.inputPerMTokens) / 1_000_000
  const outputCost = (outputTokens * rate.outputPerMTokens) / 1_000_000
  const notes = [
    `Modelo ${input.model}; valor máximo (teto de saída em cada chamada) — o real costuma ser bem menor.`,
    `Estimativa com preços de referência (${PRICES_REFERENCE_DATE}); a cobrança real é a da fatura da OpenAI.`,
  ]
  if (!prices.story[input.model]) notes.push(`Sem preço de referência para ${input.model}: orçado com um valor alto.`)
  return {
    usd: inputCost + outputCost,
    breakdown: [
      `${input.chunks.length} chamada(s) (a copy é dividida em partes)`,
      `entrada: ~${inputTokens} tokens = ${usd(inputCost)}`,
      `saída (teto de ${input.maxOutputTokens} tokens × ${input.chunks.length}) = ${usd(outputCost)}`,
    ],
    notes,
  }
}

// Lote do storyboard: soma das estimativas de cada cena (1 imagem cada, com
// as referências daquela cena — inclusive as de cenas anteriores).
export function estimateBatch(
  job: {
    model: ImageModel
    size: string
    quality?: string
    inputFidelity?: InputFidelity
    items: Array<{ prompt: string; references?: ReferenceDescriptor[]; deferredReferences?: number }>
  },
  prices: PriceTable,
): Estimate & { perItem: number[] } {
  const perItem = job.items.map((item) => {
    const refs = [
      ...(item.references ?? []),
      ...Array.from({ length: item.deferredReferences ?? 0 }, () => item.references![0]),
    ]
    const hasRefs = refs.length > 0
    return estimateImageJob(
      {
        model: job.model,
        prompt: item.prompt,
        size: job.size,
        quality: job.quality,
        totalImages: 1,
        ...(hasRefs ? { references: refs, inputFidelity: job.inputFidelity } : {}),
      },
      prices,
    ).usd
  })
  const total = perItem.reduce((a, b) => a + b, 0)
  const refsTotal = job.items.reduce((sum, it) => sum + (it.references?.length ?? 0) + (it.deferredReferences ?? 0), 0)
  const deferred = job.items.reduce((sum, it) => sum + (it.deferredReferences ?? 0), 0)
  const quality = pricingQuality(job.model, job.quality)
  const breakdown = [
    `${job.items.length} imagem(ns), uma por cena (${job.model}, ${quality}, ${job.size})`,
    `por cena: de ${usd(Math.min(...perItem))} a ${usd(Math.max(...perItem))} (prompt e referências de cada cena)`,
    `${refsTotal} foto(s) de referência no total${deferred ? `, ${deferred} delas de cenas anteriores do lote` : ''}`,
  ]
  const notes = [`Estimativa com preços de referência (${PRICES_REFERENCE_DATE}); a cobrança real é a da fatura da OpenAI.`]
  if (!job.quality || job.quality === 'auto') notes.push('Qualidade "auto" foi orçada como "high" (pior caso).')
  if (refsTotal) notes.push('Referências orçadas pelo limite superior de tokens por imagem; o valor real tende a ser menor.')
  return { usd: total, breakdown, notes, perItem }
}
