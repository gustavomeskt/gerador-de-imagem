// Pedido de interpretação para o modelo de linguagem (usado SÓ pelo
// backend). Saída estruturada com esquema JSON estrito — o resultado ainda
// passa pela validação contra a copy antes de virar storyboard.

export const STORY_MODEL_DEFAULT = 'gpt-5-mini'

export const STORY_INTERPRETER_SYSTEM = `Você transforma a copy de uma historinha publicitária em um storyboard de imagens.

REGRAS DE FIDELIDADE (obrigatórias):
1. Nunca invente acontecimentos, personagens, diálogos, objetos relevantes ou mudanças de cenário que não estejam no texto.
2. Nunca resuma, reescreva ou corrija a copy.
3. Em cada cena, "quote" deve ser um trecho COPIADO LITERALMENTE da copy (mesmas palavras e pontuação), na ordem em que aparece.
4. Se uma passagem precisar de mais de uma imagem, crie várias cenas consecutivas com o MESMO "quote" e descreva em "action" a parte da passagem mostrada em cada uma.
5. Crie quantas cenas a narrativa exigir (pode ser 5, 30 ou 60): uma nova imagem para cada novo momento visual, fala importante, mudança de ambiente, de tempo ou de roupa.
6. Quando algo for ambíguo (quem fala, quem aparece, onde estão), NÃO adivinhe: deixe o campo vazio e explique em "ambiguities".
7. "visualDescription", "framing" e "camera" podem conter só detalhes de composição necessários para a imagem — nunca um acontecimento novo.
8. "motion" descreve apenas o movimento da ação já descrita, para animação curta; não acrescente eventos.
9. "objects" lista só objetos citados na copy.
10. Escreva os campos descritivos em português do Brasil.`

const str = { type: 'string' }
const strArr = { type: 'array', items: { type: 'string' } }
const nullableStr = { type: ['string', 'null'] }

export const STORY_JSON_SCHEMA = {
  name: 'storyboard',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['characters', 'scenes'],
    properties: {
      characters: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'mentions'],
          properties: { name: str, mentions: strArr },
        },
      },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'quote', 'characters', 'speaker', 'dialogue', 'environment', 'action', 'emotions', 'wardrobe', 'objects',
            'timeShift', 'continuity', 'framing', 'camera', 'visualDescription', 'motion', 'ambiguities',
          ],
          properties: {
            quote: str,
            characters: strArr,
            speaker: nullableStr,
            dialogue: nullableStr,
            environment: str,
            action: str,
            emotions: str,
            wardrobe: str,
            objects: strArr,
            timeShift: str,
            continuity: str,
            framing: str,
            camera: str,
            visualDescription: str,
            motion: str,
            ambiguities: strArr,
          },
        },
      },
    },
  },
} as const

export function buildStoryInterpretBody(params: {
  model: string
  chunk: string
  part: { index: number; total: number }
  libraryNames: string[]
  maxOutputTokens: number
}): Record<string, unknown> {
  const context = [
    params.part.total > 1 ? `Esta é a parte ${params.part.index} de ${params.part.total} da copy (as partes são interpretadas em sequência).` : null,
    params.libraryNames.length
      ? `Personagens cadastrados na biblioteca (use o nome exatamente como aparece na COPY; não associe por semelhança): ${params.libraryNames.join(', ')}.`
      : null,
    'COPY (não altere):',
    params.chunk,
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: params.model,
    max_completion_tokens: params.maxOutputTokens,
    response_format: { type: 'json_schema', json_schema: STORY_JSON_SCHEMA },
    messages: [
      { role: 'system', content: STORY_INTERPRETER_SYSTEM },
      { role: 'user', content: context },
    ],
  }
}
