// Converte uma imagem que não pode ir como referência (SVG das imagens
// simuladas) em PNG, desenhando-a num canvas. Só funciona no navegador.

export function rasterizeToPng(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  return new Promise((resolve0, reject0) => {
    let resolve = resolve0
    let reject = reject0
    if (typeof document === 'undefined' || typeof Image === 'undefined' || /jsdom/i.test(navigator.userAgent)) {
      reject(new Error('conversão de imagem indisponível neste ambiente'))
      return
    }
    // imagem que nunca carrega (nem dá erro) não pode travar a fila
    const timer = setTimeout(() => reject(new Error('tempo esgotado ao carregar a imagem')), 8000)
    const done = <T,>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(timer)
      fn(v)
    }
    resolve = done(resolve)
    reject = done(reject)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 512
        canvas.height = img.naturalHeight || 768
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas indisponível')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url)
          if (!blob) return reject(new Error('falha ao converter a imagem'))
          void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
        }, 'image/png')
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('falha ao carregar a imagem para converter'))
    }
    img.src = url
  })
}
