// Distribui o limite de fotos de referência de uma geração: a foto
// principal de cada personagem e todas as fotos obrigatórias (nós de
// referência) entram sempre; o que sobrar vai para as fotos extras dos
// personagens, uma de cada vez (rodízio). Usado pela geração dos nós e pelo
// storyboard — a mesma regra nos dois lugares.

export type PhotoAllocation<T> = { ok: true; chosen: T[][]; omitted: T[][] } | { ok: false; required: number }

export function allocateCharacterPhotos<T>(castPhotos: T[][], otherRequired: number, limit: number): PhotoAllocation<T> {
  const required = castPhotos.filter((p) => p.length > 0).length + otherRequired
  if (required > limit) return { ok: false, required }
  const chosen = castPhotos.map((photos) => photos.slice(0, 1))
  let budget = limit - required
  for (let round = 1; budget > 0; round++) {
    let added = false
    for (let i = 0; i < castPhotos.length && budget > 0; i++) {
      if (castPhotos[i][round]) {
        chosen[i].push(castPhotos[i][round])
        budget -= 1
        added = true
      }
    }
    if (!added) break
  }
  return { ok: true, chosen, omitted: castPhotos.map((photos, i) => photos.slice(chosen[i].length)) }
}
