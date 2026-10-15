// Recorta uma imagem (data URL) no centro pra bater exatamente com a
// proporção pedida e devolve um data URL PNG. Usado pros tamanhos 9:16/16:9,
// que a API não gera nativo (ela só tem quadrado/retrato/paisagem) — geramos
// no tamanho mais próximo e recortamos aqui.

export interface CropRect {
  sx: number
  sy: number
  width: number
  height: number
}

// Cálculo puro do retângulo de recorte centralizado (testável sem canvas).
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

export function cropToAspect(src: string, targetAspect: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => {
      const rect = computeCenterCrop(img.naturalWidth, img.naturalHeight, targetAspect)

      const canvas = document.createElement('canvas')
      canvas.width = rect.width
      canvas.height = rect.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas indisponível para recortar a imagem'))
        return
      }

      ctx.drawImage(img, rect.sx, rect.sy, rect.width, rect.height, 0, 0, rect.width, rect.height)
      resolve(canvas.toDataURL('image/png'))
    }

    img.onerror = () => reject(new Error('Falha ao carregar imagem para recortar'))
    img.src = src
  })
}
