import { InterpretationError, parseRawInterpretation } from '../src/story/interpretation'
import { locateQuote, normalizeName, splitIntoChunks } from '../src/story/text'
import type { RawInterpretation } from '../src/story/types'
import { HttpError } from './http'
import type { ImageClient } from './openaiClient'

// Interpretação da copy no servidor: divide a copy em partes (por parágrafo),
// interpreta cada uma em sequência e junta o resultado. Cada parte é
// validada aqui (formato + trechos citados existem na parte); a validação
// completa contra a copy inteira acontece de novo no navegador.
//
// Nada da copy vai para o log.

export function storyChunks(copy: string, chunkChars: number): string[] {
  return splitIntoChunks(copy, chunkChars).map((c) => c.text)
}

export async function interpretStoryChunks(
  client: ImageClient,
  input: { copy: string; libraryNames: string[]; chunkChars: number },
): Promise<{ interpretation: RawInterpretation; warnings: string[] }> {
  const chunks = storyChunks(input.copy, input.chunkChars)
  const warnings: string[] = []
  const characters = new Map<string, { name: string; mentions: Set<string> }>()
  const scenes: RawInterpretation['scenes'] = []

  for (let i = 0; i < chunks.length; i++) {
    const part = { index: i + 1, total: chunks.length }
    const raw = await client.interpretStory({ chunk: chunks[i], part, libraryNames: input.libraryNames })
    let parsed: RawInterpretation
    try {
      parsed = parseRawInterpretation(raw)
    } catch (err) {
      if (err instanceof InterpretationError) {
        throw new HttpError(502, 'upstream_invalid', `Interpretação inválida na parte ${part.index} de ${part.total}: ${err.message}`)
      }
      throw err
    }

    let dropped = 0
    for (const scene of parsed.scenes) {
      if (!scene.quote.trim() || !locateQuote(chunks[i], scene.quote)) {
        dropped += 1
        continue
      }
      scenes.push(scene)
    }
    if (dropped) {
      warnings.push(`Parte ${part.index}: ${dropped} cena(s) descartada(s) porque o trecho citado não existe na copy.`)
    }
    for (const c of parsed.characters) {
      const key = normalizeName(c.name)
      if (!key) continue
      const entry = characters.get(key) ?? { name: c.name, mentions: new Set<string>() }
      for (const m of [c.name, ...c.mentions]) entry.mentions.add(m)
      characters.set(key, entry)
    }
  }

  if (scenes.length === 0) {
    throw new HttpError(502, 'upstream_invalid', 'A interpretação não trouxe nenhuma cena com trecho literal da copy.')
  }
  return {
    interpretation: {
      characters: [...characters.values()].map((c) => ({ name: c.name, mentions: [...c.mentions] })),
      scenes,
    },
    warnings,
  }
}
