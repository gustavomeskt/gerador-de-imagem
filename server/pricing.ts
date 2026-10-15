import { readFileSync } from 'node:fs'
import { MODEL_MAX_N, type ImageModel } from '../src/generation/models'
import { ENHANCE_MAX_PROMPT_CHARS } from './validation'
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
  // melhorador de prompt: USD por 1 milhão de tokens
  enhancer: { inputPerMTokens: number; outputPerMTokens: number }
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
  enhancer: { inputPerMTokens: 0.25, outputPerMTokens: 2 },
}

export function loadPriceTable(file: string | undefined): PriceTable {
  if (!file) return DEFAULT_PRICES
  const custom = JSON.parse(readFileSync(file, 'utf8')) as Partial<PriceTable>
  return {
    images: { ...DEFAULT_PRICES.images, ...custom.images },
    imagePromptPerMTokens: { ...DEFAULT_PRICES.imagePromptPerMTokens, ...custom.imagePromptPerMTokens },
    enhancer: { ...DEFAULT_PRICES.enhancer, ...custom.enhancer },
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
  job: { model: ImageModel; prompt: string; size: string; quality?: string; totalImages: number },
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
