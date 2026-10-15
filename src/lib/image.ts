import { containRect, reframeRect } from '../batch/format'

// Ajuste de proporção das imagens, feito no navegador (canvas).
//
// NUNCA recorta às cegas: para mudar a proporção (ex.: 2:3 → 9:16), a imagem
// inteira é colocada no quadro novo e as sobras são preenchidas com a
// própria imagem desfocada. O recorte só existe como "reenquadramento"
// explícito, com a posição escolhida e a perda informada.

export interface CropRect {
  sx: number
  sy: number
  width: number
  height: number
}

// Recorte centralizado (mantido só para cálculos/testes antigos; não é usado
// para gerar imagens).
export function computeCenterCrop(srcW: number, srcH: number, targetAspect: number): CropRect {
  const srcAspect = srcW / srcH
  let width = srcW
  let height = srcH
  if (srcAspect > targetAspect) {
    width = Math.round(srcH * targetAspect)
  } else if (srcAspect < targetAspect) {
    height = Math.round(srcW / targetAspect)
  }
  return {
    sx: Math.round((srcW - width) / 2),
    sy: Math.round((srcH - height) / 2),
    width,
    height,
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Falha ao carregar a imagem para ajustar o formato'))
    img.src = src
  })
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas indisponível para ajustar a imagem')
  return { canvas, ctx }
}

// Quadro na proporção pedida com a imagem INTEIRA (contain) sobre um fundo
// feito da própria imagem ampliada e desfocada.
async function drawExpanded(src: string, outW: number, outH: number): Promise<HTMLCanvasElement> {
  const img = await loadImage(src)
  const { canvas, ctx } = canvasOf(outW, outH)
  const cover = Math.max(outW / img.naturalWidth, outH / img.naturalHeight)
  const bw = img.naturalWidth * cover
  const bh = img.naturalHeight * cover
  ctx.filter = 'blur(40px) brightness(0.8)'
  ctx.drawImage(img, (outW - bw) / 2, (outH - bh) / 2, bw, bh)
  ctx.filter = 'none'
  const r = containRect(img.naturalWidth, img.naturalHeight, outW, outH)
  ctx.drawImage(img, r.dx, r.dy, r.drawW, r.drawH)
  return canvas
}

export async function expandToFrame(src: string, outW: number, outH: number): Promise<string> {
  return (await drawExpanded(src, outW, outH)).toDataURL('image/png')
}

export async function reframeToFrame(src: string, offset: number, outW: number, outH: number): Promise<string> {
  const img = await loadImage(src)
  const r = reframeRect(img.naturalWidth, img.naturalHeight, offset, outW, outH)
  const { canvas, ctx } = canvasOf(outW, outH)
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, outW, outH)
  return canvas.toDataURL('image/png')
}

// Usado pelos nós de imagem quando a proporção pedida não é nativa do modelo
// (nome mantido por compatibilidade): enquadra a imagem inteira, sem cortar.
export async function cropToAspect(src: string, targetAspect: number): Promise<string> {
  const img = await loadImage(src)
  let outW = img.naturalWidth
  let outH = img.naturalHeight
  if (outW / outH > targetAspect) outH = Math.round(outW / targetAspect)
  else outW = Math.round(outH * targetAspect)
  return (await drawExpanded(src, outW, outH)).toDataURL('image/png')
}
