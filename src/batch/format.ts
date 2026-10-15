// Formato vertical 9:16 para o Google Flow.
//
//   native     — o modelo gerou em 9:16 (ex.: gpt-image-2 em 1152×2048)
//   expanded   — a imagem original INTEIRA foi colocada num quadro 9:16 e as
//                sobras preenchidas com uma versão desfocada da própria
//                imagem (nada é cortado nem distorcido; as bordas não são
//                conteúdo novo gerado por IA)
//   reframed   — recorte para 9:16 com a posição escolhida pela pessoa; a
//                perda (%) é mostrada e precisa ser confirmada
//   unadjusted — ainda não está em 9:16 (ex.: 2:3 do gpt-image-1.5)
//
// Redimensionar sem manter a proporção (esticar) não existe aqui.

export type FormatMethod = 'native' | 'expanded' | 'reframed' | 'unadjusted'

export const FORMAT_LABELS: Record<FormatMethod, string> = {
  native: '9:16 nativo',
  expanded: '9:16 expandido (imagem inteira + bordas preenchidas)',
  reframed: '9:16 reenquadrado (com corte)',
  unadjusted: 'Ainda não está em 9:16',
}

export const TARGET_WIDTH = 1080
export const TARGET_HEIGHT = 1920
const NINE_SIXTEEN = 9 / 16

export function isNineSixteen(width: number | null | undefined, height: number | null | undefined, tolerance = 0.005): boolean {
  if (!width || !height) return false
  return Math.abs(width / height - NINE_SIXTEEN) <= tolerance
}

// Retângulo onde a imagem inteira cabe no quadro (sem corte).
export function containRect(srcW: number, srcH: number, outW = TARGET_WIDTH, outH = TARGET_HEIGHT) {
  const scale = Math.min(outW / srcW, outH / srcH)
  const drawW = Math.round(srcW * scale)
  const drawH = Math.round(srcH * scale)
  return { scale, drawW, drawH, dx: Math.round((outW - drawW) / 2), dy: Math.round((outH - drawH) / 2), outW, outH }
}

// Recorte 9:16 com posição escolhida: offset 0 = encostado à esquerda/topo,
// 0.5 = centro, 1 = direita/base. Devolve quanto da imagem se perde.
export function reframeRect(srcW: number, srcH: number, offset = 0.5, outW = TARGET_WIDTH, outH = TARGET_HEIGHT) {
  const target = outW / outH
  const o = Math.max(0, Math.min(1, offset))
  let sw = srcW
  let sh = srcH
  if (srcW / srcH > target) sw = Math.round(srcH * target)
  else sh = Math.round(srcW / target)
  const sx = Math.round((srcW - sw) * o)
  const sy = Math.round((srcH - sh) * o)
  const lossPercent = Math.round((1 - (sw * sh) / (srcW * srcH)) * 1000) / 10
  return {
    sx,
    sy,
    sw,
    sh,
    outW,
    outH,
    lossPercent,
    lost: { left: sx, right: srcW - sx - sw, top: sy, bottom: srcH - sy - sh },
  }
}

// Acima disto o reenquadramento é desaconselhado (corta demais).
export const MAX_REFRAME_LOSS = 20

export function describeFormat(method: FormatMethod, details: { lossPercent?: number; nativeWidth?: number | null; nativeHeight?: number | null } = {}): string {
  const native = details.nativeWidth && details.nativeHeight ? ` Original: ${details.nativeWidth}×${details.nativeHeight}.` : ''
  switch (method) {
    case 'native':
      return `Gerada em 9:16 pelo próprio modelo.${native}`
    case 'expanded':
      return `Imagem original inteira dentro do quadro 9:16, sem corte nem distorção; as faixas acima/abaixo são a própria imagem desfocada (não são conteúdo gerado).${native}`
    case 'reframed':
      return `Recortada para 9:16 na posição escolhida — ${details.lossPercent ?? '?'}% da imagem ficou de fora. Confira rostos, mãos e objetos nas bordas.${native}`
    default:
      return `Formato do modelo, ainda não ajustado para 9:16 (não recortado).${native}`
  }
}

// Uma região importante (rosto, mão, produto…) continua inteira na imagem
// final? Usado nos testes de "sem corte" e para avisos futuros.
export function regionSurvivesReframe(
  region: { x: number; y: number; w: number; h: number },
  rect: { sx: number; sy: number; sw: number; sh: number },
): boolean {
  return region.x >= rect.sx && region.y >= rect.sy && region.x + region.w <= rect.sx + rect.sw && region.y + region.h <= rect.sy + rect.sh
}
