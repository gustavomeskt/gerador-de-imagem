// Recorta uma imagem base64 (PNG) no centro pra bater exatamente com a
// proporção pedida. Usado pros tamanhos 9:16/16:9, que a API não gera nativo
// (ela só tem quadrado/retrato/paisagem) — geramos no tamanho mais próximo e
// recortamos aqui.
export function cropBase64ToAspect(b64: string, targetAspect: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => {
      const srcW = img.naturalWidth
      const srcH = img.naturalHeight
      const srcAspect = srcW / srcH

      let cropW = srcW
      let cropH = srcH
      if (srcAspect > targetAspect) {
        cropW = Math.round(srcH * targetAspect)
      } else if (srcAspect < targetAspect) {
        cropH = Math.round(srcW / targetAspect)
      }

      const sx = Math.round((srcW - cropW) / 2)
      const sy = Math.round((srcH - cropH) / 2)

      const canvas = document.createElement('canvas')
      canvas.width = cropW
      canvas.height = cropH
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas indisponível para recortar a imagem'))
        return
      }

      ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, cropW, cropH)
      resolve(canvas.toDataURL('image/png').split(',')[1])
    }

    img.onerror = () => reject(new Error('Falha ao carregar imagem para recortar'))
    img.src = `data:image/png;base64,${b64}`
  })
}
