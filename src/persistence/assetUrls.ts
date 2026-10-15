import { bytesToDataUrl } from '../lib/binary'

// URLs temporárias (blob:) pra mostrar na tela as imagens salvas no banco.
// Ficam num mapa por assetId pra poderem ser liberadas quando a imagem sai
// da tela (apagada ou substituída) e não vazarem memória.

const urls = new Map<string, string>()

export function getAssetUrl(assetId: string, bytes: ArrayBuffer | Uint8Array, mimeType: string): string {
  const existing = urls.get(assetId)
  if (existing) return existing

  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const url =
    typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(new Blob([view as BlobPart], { type: mimeType }))
      : bytesToDataUrl(view, mimeType)
  urls.set(assetId, url)
  return url
}

export function releaseAssetUrl(assetId: string) {
  const url = urls.get(assetId)
  if (!url) return
  urls.delete(assetId)
  if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}
