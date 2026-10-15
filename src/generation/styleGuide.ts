import { MODEL_SIZES, type ImageModel } from './models'

// Guia de estilo do projeto: regras visuais permanentes que entram em todas
// as gerações daquele projeto. Ele só descreve COMO a imagem deve parecer —
// nunca acrescenta acontecimentos à cena.

export type PreferredAspect = '9:16' | '1:1' | '16:9'

export interface StyleGuide {
  enabled: boolean
  visualStyle: string
  photorealistic: boolean // força fotografia realista e natural
  lighting: string
  quality: string
  aspect: PreferredAspect
  environment: string // características permanentes dos ambientes
  continuity: string // regras de continuidade de roupas e objetos
  noText: boolean // sem textos, legendas, logos ou marcas-d'água
}

export const ASPECT_LABELS: Record<PreferredAspect, string> = {
  '9:16': 'Vertical 9:16 (Reels, Stories, TikTok)',
  '1:1': 'Quadrada 1:1',
  '16:9': 'Horizontal 16:9',
}

// Padrão dos nossos projetos: fotorrealista, vertical 9:16, sem textos.
export function defaultStyleGuide(): StyleGuide {
  return {
    enabled: true,
    visualStyle: 'Fotografia publicitária realista e natural, como uma foto feita com celular de boa qualidade.',
    photorealistic: true,
    lighting: 'Luz natural, suave e realista, sem aparência de estúdio exagerado.',
    quality: 'Alta nitidez, pele com textura natural, cores fiéis, sem distorções.',
    aspect: '9:16',
    environment: '',
    continuity: 'Manter as mesmas roupas, acessórios e objetos entre as cenas, a menos que a cena peça mudança.',
    noText: true,
  }
}

// Projetos criados antes do guia existir: guia padrão DESLIGADO, para não
// mudar o que eles já geravam.
export function legacyStyleGuide(): StyleGuide {
  return { ...defaultStyleGuide(), enabled: false }
}

const ASPECT_RATIO: Record<PreferredAspect, number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 }

// Tamanho do modelo mais próximo da proporção preferida.
export function sizeForAspect(model: ImageModel, aspect: PreferredAspect): string {
  const target = ASPECT_RATIO[aspect]
  const sizes = MODEL_SIZES[model]
  return sizes.reduce((best, s) => (Math.abs(s.aspect - target) < Math.abs(best.aspect - target) ? s : best), sizes[0]).value
}

export function aspectMatches(aspect: PreferredAspect, value: number): boolean {
  return Math.abs(ASPECT_RATIO[aspect] - value) < 0.01
}

// Normaliza um guia lido do banco/backup (campos ausentes ganham o padrão).
export function normalizeStyleGuide(raw: unknown, fallback: StyleGuide = legacyStyleGuide()): StyleGuide {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Partial<StyleGuide>
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    enabled: bool(r.enabled, fallback.enabled),
    visualStyle: str(r.visualStyle, fallback.visualStyle),
    photorealistic: bool(r.photorealistic, fallback.photorealistic),
    lighting: str(r.lighting, fallback.lighting),
    quality: str(r.quality, fallback.quality),
    aspect: r.aspect === '1:1' || r.aspect === '16:9' || r.aspect === '9:16' ? r.aspect : fallback.aspect,
    environment: str(r.environment, fallback.environment),
    continuity: str(r.continuity, fallback.continuity),
    noText: bool(r.noText, fallback.noText),
  }
}
