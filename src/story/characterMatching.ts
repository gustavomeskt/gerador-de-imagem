import { normalizeName } from './text'
import type { MatchStatus } from './types'

// Liga os personagens encontrados na copy à biblioteca — de forma
// CONSERVADORA: só associa sozinho quando o nome é o mesmo (ignorando
// acentos e tratamentos como "Dona", "Seu"). Nomes parecidos ("Mariana" x
// "Maria") nunca são associados; só o primeiro nome ("Maria" x "Maria
// Clara") vira caso ambíguo para a pessoa confirmar.

export interface LibraryEntry {
  id: string
  name: string
}

export interface MatchResult {
  libraryId: string | null
  matchStatus: MatchStatus
  candidates: string[]
}

export function matchCharacter(storyName: string, library: LibraryEntry[]): MatchResult {
  const target = normalizeName(storyName)
  if (!target) return { libraryId: null, matchStatus: 'unregistered', candidates: [] }

  const exact = library.filter((c) => normalizeName(c.name) === target)
  if (exact.length === 1) return { libraryId: exact[0].id, matchStatus: 'auto', candidates: [] }
  if (exact.length > 1) return { libraryId: null, matchStatus: 'ambiguous', candidates: exact.map((c) => c.id) }

  // mesmo primeiro nome (ou nome contido como palavra inteira) — pode ser a
  // mesma pessoa, mas não é certeza: pede confirmação
  const targetTokens = target.split(' ')
  const partial = library.filter((c) => {
    const tokens = normalizeName(c.name).split(' ')
    return targetTokens.length === 1 ? tokens.includes(targetTokens[0]) : targetTokens.every((t) => tokens.includes(t)) || tokens.every((t) => targetTokens.includes(t))
  })
  if (partial.length > 0) return { libraryId: null, matchStatus: 'ambiguous', candidates: partial.map((c) => c.id) }

  return { libraryId: null, matchStatus: 'unregistered', candidates: [] }
}
