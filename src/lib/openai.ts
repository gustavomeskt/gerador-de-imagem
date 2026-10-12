export type ImageModel = 'gpt-image-1.5' | 'gpt-image-1' | 'gpt-image-1-mini' | 'dall-e-3' | 'dall-e-2'

export const MODEL_LABELS: Record<ImageModel, string> = {
  'gpt-image-1.5': 'GPT Image 1.5 (recomendado)',
  'gpt-image-1': 'GPT Image 1',
  'gpt-image-1-mini': 'GPT Image 1 Mini (rápido e barato)',
  'dall-e-3': 'DALL-E 3',
  'dall-e-2': 'DALL-E 2',
}

export interface SizeOption {
  value: string // tamanho enviado pra API, ex. "1024x1536"
  label: string
  aspect: number // proporção final (largura / altura) mostrada/baixada
  crop?: boolean // se true, a API não gera nesse formato exato — recortamos no centro depois
}

// gpt-image-1, 1.5 e mini têm a mesma grade de tamanhos/qualidade.
const GPT_IMAGE_SIZES: SizeOption[] = [
  { value: '1024x1024', label: 'Quadrada (1:1)', aspect: 1 },
  { value: '1024x1536', label: 'Vertical (9:16)', aspect: 9 / 16, crop: true },
  { value: '1536x1024', label: 'Horizontal (16:9)', aspect: 16 / 9, crop: true },
]

const GPT_IMAGE_QUALITIES = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Baixa' },
  { value: 'medium', label: 'Média' },
  { value: 'high', label: 'Alta' },
]

export const MODEL_SIZES: Record<ImageModel, SizeOption[]> = {
  'gpt-image-1.5': GPT_IMAGE_SIZES,
  'gpt-image-1': GPT_IMAGE_SIZES,
  'gpt-image-1-mini': GPT_IMAGE_SIZES,
  'dall-e-3': [
    { value: '1024x1024', label: 'Quadrada (1:1)', aspect: 1 },
    { value: '1024x1792', label: 'Vertical (9:16)', aspect: 9 / 16, crop: true },
    { value: '1792x1024', label: 'Horizontal (16:9)', aspect: 16 / 9, crop: true },
  ],
  'dall-e-2': [
    { value: '256x256', label: 'Quadrada pequena', aspect: 1 },
    { value: '512x512', label: 'Quadrada média', aspect: 1 },
    { value: '1024x1024', label: 'Quadrada grande', aspect: 1 },
  ],
}

export const MODEL_QUALITIES: Record<ImageModel, { value: string; label: string }[] | null> = {
  'gpt-image-1.5': GPT_IMAGE_QUALITIES,
  'gpt-image-1': GPT_IMAGE_QUALITIES,
  'gpt-image-1-mini': GPT_IMAGE_QUALITIES,
  'dall-e-3': [
    { value: 'standard', label: 'Padrão' },
    { value: 'hd', label: 'HD' },
  ],
  'dall-e-2': null,
}

// Quantas imagens cada modelo aceita gerar numa única chamada da API.
const MODEL_MAX_N: Record<ImageModel, number> = {
  'gpt-image-1.5': 10,
  'gpt-image-1': 10,
  'gpt-image-1-mini': 10,
  'dall-e-2': 10,
  'dall-e-3': 1,
}

function isGptImageModel(model: ImageModel) {
  return model.startsWith('gpt-image')
}

export class OpenAIApiError extends Error {}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const errJson = await res.json()
    return errJson?.error?.message ?? fallback
  } catch {
    return fallback
  }
}

interface GenerateParams {
  apiKey: string
  model: ImageModel
  prompt: string
  size: string
  quality?: string
  n: number
}

async function callOnce(params: Omit<GenerateParams, 'n'> & { n: number }): Promise<string[]> {
  const { apiKey, model, prompt, size, quality, n } = params

  const body: Record<string, unknown> = { model, prompt, size, n }

  if (isGptImageModel(model)) {
    if (quality) body.quality = quality
  } else {
    // dall-e-2 / dall-e-3: pedimos base64 direto, sem depender de URL temporária
    body.response_format = 'b64_json'
    if (model === 'dall-e-3' && quality) body.quality = quality
  }

  const res = await fetch('/openai-api/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new OpenAIApiError(await extractErrorMessage(res, `Erro ${res.status} na API da OpenAI`))
  }

  const data = await res.json()
  return (data.data as Array<{ b64_json: string }>).map((d) => d.b64_json)
}

export async function generateImages(params: GenerateParams): Promise<string[]> {
  const maxPerCall = MODEL_MAX_N[params.model]
  const batches: number[] = []
  let remaining = params.n
  while (remaining > 0) {
    const batch = Math.min(remaining, maxPerCall)
    batches.push(batch)
    remaining -= batch
  }

  const results = await Promise.all(
    batches.map((batchN) => callOnce({ ...params, n: batchN })),
  )

  return results.flat()
}

// Modelo de texto usado só pra reescrever/detalhar o prompt antes de gerar a
// imagem — imita o que o ChatGPT faz por trás dos panos (ele expande o
// pedido curto do usuário num prompt bem mais descritivo antes de mandar pro
// gerador de imagem; a API de imagens pura não faz isso sozinha).
const PROMPT_ENHANCER_MODEL = 'gpt-5-mini'

const PROMPT_ENHANCER_SYSTEM = `Você reescreve prompts curtos de geração de imagem em prompts detalhados e fotográficos, no mesmo estilo que o ChatGPT usa internamente antes de gerar uma imagem. Adicione especificações de iluminação, ângulo de câmera, composição, textura de material/pele, humor e estilo fotográfico, mantendo fielmente a ideia original do usuário — não troque o assunto nem invente elementos que mudem o pedido. Responda só com o prompt reescrito, em inglês, sem aspas, sem explicações, sem prefixos como "Prompt:".`

export async function enhancePromptText(params: { apiKey: string; prompt: string }): Promise<string> {
  const { apiKey, prompt } = params

  const res = await fetch('/openai-api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: PROMPT_ENHANCER_MODEL,
      messages: [
        { role: 'system', content: PROMPT_ENHANCER_SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  })

  if (!res.ok) {
    throw new OpenAIApiError(await extractErrorMessage(res, `Erro ${res.status} ao melhorar o prompt`))
  }

  const data = await res.json()
  const text = data.choices?.[0]?.message?.content as string | undefined
  if (!text || !text.trim()) {
    throw new OpenAIApiError('A resposta veio vazia ao tentar melhorar o prompt.')
  }

  return text.trim()
}
