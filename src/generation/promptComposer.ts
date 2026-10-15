import type { CharacterSheet } from './characters'
import type { ReferenceGroup, ReferenceRole } from './references'
import type { StyleGuide } from './styleGuide'

// Monta as instruções finais de uma geração, numa ordem fixa:
//   1. o que é cada imagem de referência anexada (personagens da biblioteca
//      com a ficha permanente, depois as referências avulsas);
//   2. regras de separação quando há várias pessoas;
//   3. o guia de estilo do projeto;
//   4. a cena, exatamente como foi escrita.
// As fotos SEMPRE vão junto na chamada — este texto só diz ao modelo o papel
// de cada uma. Ele nunca acrescenta acontecimentos à cena.

export interface CastGroup {
  sheet: CharacterSheet
  sceneNote?: string // ajuste só desta cena (não muda a ficha)
  imageCount: number
}

// Imagem de uma cena anterior da mesma história, usada só para continuidade
// (roupa, cenário, objetos) — nunca como fonte de identidade.
export interface ContinuityGroup {
  label: string
  imageCount: number
}

export interface ComposeInput {
  scene: string
  cast?: CastGroup[]
  references?: ReferenceGroup[]
  continuity?: ContinuityGroup[]
  style?: StyleGuide | null
}

const ROLE_INSTRUCTIONS: Record<ReferenceRole, (g: ReferenceGroup) => string> = {
  character: (g) =>
    'the same real person. Keep their identity exactly: same face and facial features, same apparent age, ' +
    'same skin tone, same hair color, length and hairstyle, same body type. Facial expression, pose and camera ' +
    'angle may change naturally to fit the scene.' +
    (g.preserveClothing
      ? ' Keep the same clothing and accessories shown in the reference.'
      : ' Clothing may follow the scene description.'),
  clothing: () => 'clothing reference: dress the character in exactly this outfit (garments, colors, fabric and details).',
  object: () => 'object / setting reference: keep its shape, colors, proportions and details recognizable.',
  style: () => 'visual style reference: match its look (lighting, color palette, rendering). Do not copy its content.',
}

function imageRange(start: number, count: number): string {
  return count === 1 ? `Image ${start}` : `Images ${start}-${start + count - 1}`
}

function sheetLines(s: CharacterSheet): string[] {
  const parts: Array<[string, string]> = [
    ['apparent age', s.apparentAge],
    ['physical description', s.physicalDescription],
    ['face', s.faceFeatures],
    ['hair', s.hair],
    ['distinctive features', s.distinctiveMarks],
  ]
  const lines = parts.filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v.trim()}`)
  if (s.defaultOutfit.trim()) lines.push(`default outfit: ${s.defaultOutfit.trim()} (keep it unless the scene requires a change)`)
  if (s.preservationNotes.trim()) lines.push(`must never change: ${s.preservationNotes.trim()}`)
  return lines
}

function castLine(start: number, g: CastGroup): string {
  const head =
    `- ${imageRange(start, g.imageCount)}: "${g.sheet.name}" — the same real person in every photo. ` +
    'Preserve their identity exactly as in the photos: same face and facial features, same apparent age, ' +
    'same skin tone, same hair and same body type.'
  const sheet = sheetLines(g.sheet)
  const lines = [head]
  if (sheet.length) lines.push(`  Permanent character sheet (always applies): ${sheet.join('; ')}.`)
  if (g.sceneNote?.trim()) lines.push(`  In this scene only: ${g.sceneNote.trim()}`)
  lines.push('  Pose, facial expression and framing may change to fit the scene; identity may not.')
  return lines.join('\n')
}

function styleLines(style: StyleGuide): string[] {
  const lines: string[] = []
  if (style.visualStyle.trim()) lines.push(`- Visual style: ${style.visualStyle.trim()}`)
  if (style.photorealistic) lines.push('- Photorealistic, natural photograph — not an illustration, cartoon or 3D render.')
  if (style.lighting.trim()) lines.push(`- Lighting: ${style.lighting.trim()}`)
  if (style.quality.trim()) lines.push(`- Quality: ${style.quality.trim()}`)
  if (style.environment.trim()) lines.push(`- Recurring environment details: ${style.environment.trim()}`)
  if (style.continuity.trim()) lines.push(`- Continuity: ${style.continuity.trim()}`)
  if (style.aspect === '9:16') {
    lines.push('- Composition: vertical 9:16 frame; keep faces and important objects well inside the central area.')
  } else if (style.aspect === '16:9') {
    lines.push('- Composition: horizontal 16:9 frame.')
  } else {
    lines.push('- Composition: square 1:1 frame.')
  }
  return lines
}

export function composePrompt(input: ComposeInput): string {
  const cast = input.cast ?? []
  const refs = input.references ?? []
  const continuity = input.continuity ?? []
  const style = input.style?.enabled ? input.style : null
  if (cast.length === 0 && refs.length === 0 && continuity.length === 0 && !style) return input.scene

  const out: string[] = []
  let next = 1
  if (cast.length || refs.length || continuity.length) {
    out.push('Reference images are attached, in this order:')
    for (const g of cast) {
      out.push(castLine(next, g))
      next += g.imageCount
    }
    for (const g of refs) {
      out.push(`- ${imageRange(next, g.imageCount)}: "${g.label.trim() || 'sem nome'}" — ${ROLE_INSTRUCTIONS[g.role](g)}`)
      next += g.imageCount
    }
    for (const g of continuity) {
      out.push(
        `- ${imageRange(next, g.imageCount)}: ${g.label} — an earlier scene of this same story, for CONTINUITY ONLY: ` +
          'keep the same clothing, the same environment (layout, furniture, colors, lighting) and the same important objects. ' +
          'Do not copy its pose, framing or action, and never take anyone\'s identity from it — identities come only from the character photos.',
      )
      next += g.imageCount
    }
  }

  const people = cast.length + refs.filter((g) => g.role === 'character').length
  if (people > 1) {
    out.push(
      'Each person must keep their own identity; never mix or swap features between different people. ' +
        'Show each person once, as a distinct individual, unless the scene says otherwise.',
    )
  }

  if (style) {
    out.push('Project style guide:')
    out.push(...styleLines(style))
  }
  if (cast.length || refs.length || continuity.length || style?.noText) {
    out.push('Do not add any text, captions, logos or watermarks to the image.')
  }
  out.push('Depict only what the scene describes; do not invent events, people or objects that are not in it.')
  out.push('', `Scene: ${input.scene}`)
  return out.join('\n')
}

// Compatível com a Etapa 3: só referências avulsas, sem guia de estilo.
export function buildReferencePrompt(scene: string, groups: ReferenceGroup[]): string {
  return composePrompt({ scene, references: groups })
}
