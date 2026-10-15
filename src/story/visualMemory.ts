import { normalizeForSearch } from './text'
import type { Storyboard } from './types'

// Memória visual da história: o que já foi mostrado em cenas anteriores e
// deve continuar igual (roupa de cada personagem, cenários recorrentes,
// objetos importantes). Vira instrução de continuidade no prompt de cada
// cena — só aparência, nunca acontecimento novo.

const cache = new WeakMap<Storyboard, Map<string, string[]>>()

// Trecho do campo "figurino" que fala de um personagem ("Dona Maria: avental
// azul; Seu João: camisa"); com um personagem só na cena, vale o texto todo.
function wardrobeFor(wardrobe: string, name: string, alone: boolean): string {
  const text = wardrobe.trim()
  if (!text) return ''
  const target = normalizeForSearch(name)
  const parts = text.split(/\s*;\s*/)
  const own = parts.find((p) => normalizeForSearch(p).startsWith(`${target}:`) || normalizeForSearch(p).includes(target))
  if (own) return own.replace(/^[^:]+:\s*/, '').replace(/\s*\(desde a cena \d+\)\s*$/, '').trim()
  return alone && parts.length === 1 && !text.includes(':') ? text : ''
}

export function buildVisualMemory(board: Storyboard): Map<string, string[]> {
  const cached = cache.get(board)
  if (cached) return cached

  const nameOf = new Map(board.characters.map((c) => [c.key, c.name]))
  const outfits = new Map<string, { text: string; scene: number }>()
  const settings = new Map<string, number>()
  const objects = new Map<string, number>()
  const memory = new Map<string, string[]>()

  board.scenes.forEach((scene, index) => {
    const n = index + 1
    const lines: string[] = []
    const alone = scene.characterKeys.length === 1

    for (const key of scene.characterKeys) {
      const name = nameOf.get(key)
      if (!name) continue
      const own = wardrobeFor(scene.wardrobe, name, alone)
      const previous = outfits.get(key)
      if (own && (!previous || normalizeForSearch(previous.text) !== normalizeForSearch(own))) {
        // roupa nova descrita nesta cena: passa a valer daqui pra frente
        outfits.set(key, { text: own, scene: n })
      } else if (previous) {
        lines.push(`${name} wears the same outfit as in scene ${previous.scene} (${previous.text}).`)
      }
    }

    const env = scene.environment.trim()
    if (env) {
      const key = normalizeForSearch(env)
      const first = settings.get(key)
      if (first !== undefined && first !== n) {
        lines.push(`Setting "${env}" already appeared in scene ${first}: keep the same layout, furniture, colors and lighting.`)
      } else if (first === undefined) settings.set(key, n)
    }

    for (const o of scene.objects) {
      const key = normalizeForSearch(o)
      const first = objects.get(key)
      if (first !== undefined) lines.push(`The ${o} already appeared in scene ${first}: keep the same appearance.`)
      else objects.set(key, n)
    }

    memory.set(scene.id, lines)
  })

  cache.set(board, memory)
  return memory
}
