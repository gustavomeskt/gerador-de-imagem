import { normalizeForSearch } from '../story/text'
import type { Storyboard, StoryScene } from '../story/types'
import { buildVisualMemory } from '../story/visualMemory'
import { isNineSixteen, FORMAT_LABELS, type FormatMethod } from './format'
import type { ImageReview, SceneImageVersion } from './types'

// Revisão de cada imagem.
//
// O que o app consegue conferir sozinho, olhando a IMAGEM (dimensões reais,
// formato, imagem em branco, quase-duplicata, diferença em relação à cena
// anterior) vira "verificação automática". Todo o resto — quem aparece,
// rosto, roupa, cenário, objetos, ação, cortes — só uma pessoa pode
// confirmar: vira item de checklist "revisão humana". O prompt e os
// metadados NUNCA contam como prova de que a imagem está certa.

export interface ChecklistItem {
  id: string
  label: string
  detail?: string
  kind: 'human'
}

export interface AutoCheck {
  id: string
  label: string
  result: 'ok' | 'warning' | 'unverified'
  detail: string
}

export function emptyReview(): ImageReview {
  return { status: 'pending', problems: [], checklist: {}, note: '', reviewedAt: null }
}

export function reviewOf(version: SceneImageVersion | undefined): ImageReview {
  return version?.review ?? emptyReview()
}

function formatMethod(v: SceneImageVersion): FormatMethod {
  return v.format.method ?? (isNineSixteen(v.width, v.height) ? 'native' : 'unadjusted')
}

export function buildChecklist(scene: StoryScene, board: Storyboard): ChecklistItem[] {
  const names = scene.characterKeys.map((k) => board.characters.find((c) => c.key === k)?.name ?? '?')
  const items: ChecklistItem[] = []
  items.push({
    id: 'people',
    label: names.length ? `Exatamente ${names.length} pessoa(s) principal(is): ${names.join(', ')}` : 'Nenhum personagem principal deveria aparecer em destaque',
    detail: scene.positions ? `Posições previstas: ${scene.positions}` : undefined,
    kind: 'human',
  })
  for (const key of scene.characterKeys) {
    const c = board.characters.find((x) => x.key === key)
    if (!c) continue
    items.push({
      id: `face:${key}`,
      label: `Rosto de ${c.name} confere com a foto original`,
      detail: c.libraryId ? 'Compare com a selfie ao lado (botão "Comparar com").' : 'Sem cadastro: não há foto para comparar.',
      kind: 'human',
    })
  }
  const memory = buildVisualMemory(board).get(scene.id) ?? []
  const outfit = [scene.wardrobe, ...memory.filter((l) => /wears the same outfit/.test(l))].filter(Boolean).join(' · ')
  if (outfit) items.push({ id: 'clothing', label: 'Roupas corretas', detail: outfit, kind: 'human' })
  if (scene.environment) {
    const first = memory.find((l) => l.startsWith(`Setting "${scene.environment}"`))
    items.push({ id: 'setting', label: `Ambiente: ${scene.environment}`, detail: first ? 'Igual ao já mostrado antes (compare com a cena anterior).' : undefined, kind: 'human' })
  }
  for (const o of scene.objects) items.push({ id: `object:${normalizeForSearch(o)}`, label: `Objeto presente: ${o}`, kind: 'human' })
  items.push({ id: 'action', label: 'A imagem mostra a ação do trecho (e nada além)', detail: `"${scene.excerpt}"`, kind: 'human' })
  items.push({ id: 'cuts', label: 'Sem cortes em rostos, mãos, pés, produtos ou objetos importantes', kind: 'human' })
  items.push({ id: 'text', label: 'Sem texto, legenda ou marca-d’água', kind: 'human' })
  return items
}

export function autoChecks(version: SceneImageVersion): AutoCheck[] {
  const checks: AutoCheck[] = []
  const method = formatMethod(version)
  checks.push({
    id: 'format',
    label: 'Formato 9:16',
    result: method === 'unadjusted' ? 'warning' : 'ok',
    detail: `${FORMAT_LABELS[method]} — ${version.width ?? '?'}×${version.height ?? '?'} px (medido no arquivo).`,
  })
  if (method === 'reframed') {
    checks.push({ id: 'reframe', label: 'Reenquadramento', result: 'warning', detail: `${version.format.lossPercent ?? '?'}% da imagem original foi cortada — confira as bordas.` })
  }
  const a = version.analysis
  if (!a || a.unavailable) {
    checks.push({
      id: 'pixels',
      label: 'Análise dos pixels',
      result: 'unverified',
      detail: a?.unavailable ? `Não feita: ${a.unavailable}.` : 'Ainda não feita.',
    })
    return checks
  }
  checks.push({
    id: 'integrity',
    label: 'Dimensões da imagem',
    result: a.width === version.width && a.height === version.height ? 'ok' : 'warning',
    detail: `Imagem decodificada: ${a.width}×${a.height} px.`,
  })
  checks.push({
    id: 'blank',
    label: 'Imagem com conteúdo',
    result: a.blank ? 'warning' : 'ok',
    detail: a.blank ? 'A imagem parece praticamente uniforme (possível falha de geração).' : `Brilho médio ${a.meanLuma}.`,
  })
  if (a.duplicateOf) {
    checks.push({ id: 'duplicate', label: 'Imagem repetida', result: 'warning', detail: `Quase idêntica à imagem da cena ${a.duplicateOf} — cada cena deveria mostrar a sua ação.` })
  }
  if (a.similarToPrevious) {
    const far = a.similarToPrevious.distance >= 40
    checks.push({
      id: 'previous',
      label: `Comparação com a cena ${a.similarToPrevious.sceneNumber} (aprovada, mesmo personagem)`,
      result: far ? 'warning' : 'ok',
      detail: far
        ? `Composição muito diferente (distância ${a.similarToPrevious.distance}/64). Pode ser normal (outro enquadramento) — confira rosto, roupa e cenário.`
        : `Distância visual ${a.similarToPrevious.distance}/64. Indicador técnico, não confirma identidade.`,
    })
  }
  return checks
}
