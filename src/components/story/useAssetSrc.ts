import { useEffect, useRef, useState, type RefObject } from 'react'
import { getAssetUrl, peekAssetUrl } from '../../persistence/assetUrls'
import { repository } from '../../persistence/repository'

// URL de uma imagem salva no banco, carregada só quando o elemento aparece na
// tela (storyboards com 50+ cenas não carregam tudo de uma vez).
export function useAssetSrc(assetId: string | undefined, fallback?: string): { ref: RefObject<HTMLDivElement | null>; src?: string; missing: boolean } {
  const ref = useRef<HTMLDivElement | null>(null)
  const [loaded, setLoaded] = useState<{ id: string; src?: string; missing: boolean } | null>(null)
  const cached = assetId ? peekAssetUrl(assetId) : undefined

  useEffect(() => {
    if (!assetId || cached) return
    let cancelled = false
    const load = () => {
      repository
        .getAsset(assetId)
        .then((asset) => {
          if (cancelled) return
          setLoaded(asset ? { id: assetId, src: getAssetUrl(asset.id, asset.bytes, asset.mimeType), missing: false } : { id: assetId, missing: true })
        })
        .catch(() => !cancelled && setLoaded({ id: assetId, missing: true }))
    }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        cancelled = true
      }
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect()
        load()
      }
    }, { rootMargin: '300px' })
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [assetId, cached])

  const current = loaded && loaded.id === assetId ? loaded : null
  return { ref, src: cached ?? current?.src ?? fallback, missing: !cached && !fallback && !!current?.missing }
}
