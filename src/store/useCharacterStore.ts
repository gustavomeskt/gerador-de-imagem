import { create } from 'zustand'
import {
  emptySheet,
  LIBRARY_PROJECT_ID,
  MAX_CHARACTER_PHOTOS,
  normalizeSheet,
  sheetOf,
  type Character,
  type CharacterPhoto,
  type CharacterSheet,
} from '../generation/characters'
import { checkReferenceFile, type ReferenceMimeType } from '../generation/references'
import { bytesToDataUrl, sha256Hex, toArrayBuffer } from '../lib/binary'
import { getAssetUrl, releaseAssetUrl } from '../persistence/assetUrls'
import { toStorageError } from '../persistence/errors'
import { repository, type CharacterRecord } from '../persistence/repository'
import type { AssetRecord } from '../persistence/schema'

// Biblioteca de personagens: independente dos projetos. Os projetos guardam
// só o id do personagem; as fotos ficam uma vez só no banco (tabela de
// arquivos, "projeto" LIBRARY_PROJECT_ID) e são compartilhadas entre
// personagens duplicados.

let idCounter = 0
function nextId(prefix: string) {
  idCounter += 1
  return `${prefix}-${Date.now()}-${idCounter}`
}

export type DraftPhoto = { kind: 'existing'; photoId: string } | { kind: 'new'; name: string; bytes: Uint8Array }

export interface CharacterDraft {
  id?: string // ausente = personagem novo
  sheet: CharacterSheet
  photos: DraftPhoto[]
  primaryIndex: number // índice (em photos) da foto principal do rosto
}

export type SaveResult = { ok: true; id: string } | { ok: false; error: string }

// Dados de um personagem vindo de um backup, já validados.
export interface IncomingCharacter {
  id: string
  createdAt: number
  updatedAt: number
  version: number
  sheet: CharacterSheet
  primaryPhotoId: string
  photos: Array<{ id: string; name: string; mimeType: ReferenceMimeType; bytes: Uint8Array; width: number; height: number; sha256: string }>
}

export interface ImportReport {
  imported: string[]
  updated: string[]
  skipped: string[]
  errors: string[]
}

interface CharacterState {
  hydrated: boolean
  persistent: boolean
  characters: Character[]
  issue: string | null

  hydrate: () => Promise<void>
  saveCharacter: (draft: CharacterDraft) => Promise<SaveResult>
  duplicateCharacter: (id: string) => Promise<string | null>
  deleteCharacter: (id: string) => Promise<void>
  importCharacters: (incoming: IncomingCharacter[]) => Promise<ImportReport>
  dismissIssue: () => void
}

function toRecord(c: Character): CharacterRecord {
  return {
    id: c.id,
    projectId: null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    data: {
      sheet: { ...sheetOf(c) },
      photos: c.photos.flatMap((p) =>
        p.assetId
          ? [{ id: p.id, assetId: p.assetId, name: p.name, mimeType: p.mimeType, byteLength: p.byteLength, width: p.width, height: p.height, sha256: p.sha256 }]
          : [],
      ),
      primaryPhotoId: c.primaryPhotoId,
      version: c.version,
    },
  }
}

function sortCharacters(list: Character[]): Character[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.createdAt - b.createdAt)
}

let hydrating: Promise<void> | null = null

export const useCharacterStore = create<CharacterState>((set, get) => {
  function report(err: unknown) {
    set({ issue: toStorageError(err).message })
  }

  // arquivos usados por algum personagem (fora o que estiver sendo trocado)
  function photoAssetsInUse(except?: string): Set<string> {
    return new Set(
      get()
        .characters.filter((c) => c.id !== except)
        .flatMap((c) => c.photos.flatMap((p) => (p.assetId ? [p.assetId] : []))),
    )
  }

  // Grava uma foto nova na biblioteca; reaproveita o arquivo se a mesma foto
  // (mesmo hash) já estiver em algum personagem.
  async function storePhoto(
    name: string,
    bytes: Uint8Array,
    mimeType: ReferenceMimeType,
    width: number,
    height: number,
    sha256: string,
  ): Promise<CharacterPhoto> {
    const base = { id: nextId('cphoto'), name, mimeType, byteLength: bytes.byteLength, width, height, sha256 }
    const existing = get()
      .characters.flatMap((c) => c.photos)
      .find((p) => p.sha256 === sha256 && p.assetId && !p.missing)
    if (existing) return { ...base, assetId: existing.assetId, src: existing.src }
    if (!get().persistent) return { ...base, src: bytesToDataUrl(bytes, mimeType) }
    const asset: AssetRecord = {
      id: nextId('asset'),
      projectId: LIBRARY_PROJECT_ID,
      kind: 'character',
      mimeType,
      bytes: toArrayBuffer(bytes),
      byteLength: bytes.byteLength,
      width,
      height,
      createdAt: Date.now(),
      sha256,
    }
    await repository.putAsset(asset)
    return { ...base, assetId: asset.id, src: getAssetUrl(asset.id, asset.bytes, mimeType) }
  }

  async function discardPhotoAssets(candidates: string[]) {
    const inUse = photoAssetsInUse()
    const unused = [...new Set(candidates)].filter((id) => !inUse.has(id))
    for (const id of unused) releaseAssetUrl(id)
    if (!get().persistent || unused.length === 0) return
    try {
      await repository.deleteAssets(unused)
    } catch (err) {
      report(err)
    }
  }

  async function persist(c: Character) {
    if (get().persistent) await repository.saveCharacter(toRecord(c))
  }

  return {
    hydrated: false,
    persistent: false,
    characters: [],
    issue: null,

    hydrate: () => {
      hydrating ??= (async () => {
        try {
          await repository.open()
        } catch {
          // banco indisponível: a biblioteca funciona só nesta sessão
          set({ hydrated: true, persistent: false })
          return
        }
        try {
          const [records, assets] = await Promise.all([
            repository.listCharacters(),
            repository.listAssetsByProject(LIBRARY_PROJECT_ID),
          ])
          const byId = new Map(assets.map((a) => [a.id, a]))
          const characters = records.map((r): Character => {
            const parsed = normalizeSheet(r.data.sheet)
            const sheet: CharacterSheet = parsed.ok ? parsed.sheet : { ...emptySheet(), name: 'Personagem sem nome' }
            const photos = (r.data.photos ?? []).map((p): CharacterPhoto => {
              const asset = byId.get(p.assetId)
              return {
                id: p.id,
                assetId: p.assetId,
                name: p.name,
                mimeType: p.mimeType as ReferenceMimeType,
                byteLength: p.byteLength,
                width: p.width,
                height: p.height,
                sha256: p.sha256,
                ...(asset ? { src: getAssetUrl(asset.id, asset.bytes, asset.mimeType) } : { missing: true }),
              }
            })
            return { ...sheet, id: r.id, photos, primaryPhotoId: r.data.primaryPhotoId, version: r.data.version ?? 1, createdAt: r.createdAt, updatedAt: r.updatedAt }
          })
          set({ hydrated: true, persistent: true, characters: sortCharacters(characters) })

          // fotos gravadas sem ficha (o app fechou no meio do cadastro)
          const used = new Set(characters.flatMap((c) => c.photos.map((p) => p.assetId)))
          const orphans = assets.filter((a) => !used.has(a.id)).map((a) => a.id)
          if (orphans.length) await repository.deleteAssets(orphans)
        } catch (err) {
          set({ hydrated: true, persistent: false })
          report(err)
        }
      })()
      return hydrating
    },

    saveCharacter: async (draft) => {
      const normalized = normalizeSheet(draft.sheet)
      if (!normalized.ok) return { ok: false, error: normalized.error }
      if (draft.photos.length === 0) return { ok: false, error: 'adicione pelo menos uma foto do rosto' }
      if (draft.photos.length > MAX_CHARACTER_PHOTOS) return { ok: false, error: `no máximo ${MAX_CHARACTER_PHOTOS} fotos por personagem` }
      if (draft.primaryIndex < 0 || draft.primaryIndex >= draft.photos.length) return { ok: false, error: 'escolha a foto principal' }

      const existing = draft.id ? get().characters.find((c) => c.id === draft.id) : undefined
      if (draft.id && !existing) return { ok: false, error: 'personagem não encontrado' }

      // valida todas as fotos novas antes de gravar qualquer coisa
      const checked: Array<CharacterPhoto | { pending: true; name: string; bytes: Uint8Array; mimeType: ReferenceMimeType; width: number; height: number; sha256: string }> = []
      const seen = new Set<string>()
      for (const p of draft.photos) {
        if (p.kind === 'existing') {
          const photo = existing?.photos.find((x) => x.id === p.photoId)
          if (!photo) return { ok: false, error: 'foto existente não encontrada' }
          seen.add(photo.sha256)
          checked.push(photo)
          continue
        }
        const check = checkReferenceFile(p.bytes)
        if (!check.ok) return { ok: false, error: `${p.name}: ${check.error}` }
        const sha256 = await sha256Hex(p.bytes)
        if (seen.has(sha256)) return { ok: false, error: `${p.name}: essa foto já está neste personagem` }
        seen.add(sha256)
        checked.push({ pending: true, name: p.name, bytes: p.bytes, mimeType: check.mimeType, width: check.width, height: check.height, sha256 })
      }

      let photos: CharacterPhoto[]
      try {
        photos = []
        for (const c of checked) {
          photos.push('pending' in c ? await storePhoto(c.name, c.bytes, c.mimeType, c.width, c.height, c.sha256) : c)
        }
      } catch (err) {
        report(err)
        return { ok: false, error: toStorageError(err).message }
      }

      const now = Date.now()
      const character: Character = {
        ...normalized.sheet,
        id: existing?.id ?? nextId('char'),
        photos,
        primaryPhotoId: photos[draft.primaryIndex].id,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      try {
        await persist(character)
      } catch (err) {
        report(err)
        return { ok: false, error: toStorageError(err).message }
      }
      set((s) => ({ characters: sortCharacters([...s.characters.filter((c) => c.id !== character.id), character]) }))

      // fotos retiradas deste personagem (se nenhum outro usa)
      if (existing) {
        const keep = new Set(photos.map((p) => p.assetId))
        await discardPhotoAssets(existing.photos.flatMap((p) => (p.assetId && !keep.has(p.assetId) ? [p.assetId] : [])))
      }
      return { ok: true, id: character.id }
    },

    duplicateCharacter: async (id) => {
      const source = get().characters.find((c) => c.id === id)
      if (!source) return null
      const now = Date.now()
      const photos = source.photos.map((p) => ({ ...p, id: nextId('cphoto') }))
      const primaryIndex = Math.max(0, source.photos.findIndex((p) => p.id === source.primaryPhotoId))
      // mesmas fotos (mesmos arquivos), nova ficha independente
      const copy: Character = {
        ...sheetOf(source),
        name: `${source.name} (cópia)`.slice(0, 80),
        id: nextId('char'),
        photos,
        primaryPhotoId: photos[primaryIndex]?.id ?? '',
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      try {
        await persist(copy)
      } catch (err) {
        report(err)
        return null
      }
      set((s) => ({ characters: sortCharacters([...s.characters, copy]) }))
      return copy.id
    },

    deleteCharacter: async (id) => {
      const target = get().characters.find((c) => c.id === id)
      if (!target) return
      const inUse = photoAssetsInUse(id)
      const unused = [...new Set(target.photos.flatMap((p) => (p.assetId && !inUse.has(p.assetId) ? [p.assetId] : [])))]
      if (get().persistent) {
        try {
          await repository.deleteCharacter(id, unused)
        } catch (err) {
          report(err)
          return
        }
      }
      for (const assetId of unused) releaseAssetUrl(assetId)
      set((s) => ({ characters: s.characters.filter((c) => c.id !== id) }))
    },

    importCharacters: async (incoming) => {
      const report_: ImportReport = { imported: [], updated: [], skipped: [], errors: [] }
      for (const inc of incoming) {
        const existing = get().characters.find((c) => c.id === inc.id)
        if (existing && existing.updatedAt >= inc.updatedAt) {
          report_.skipped.push(`${inc.sheet.name}: a versão da biblioteca já é igual ou mais recente`)
          continue
        }
        try {
          const photos: CharacterPhoto[] = []
          for (const p of inc.photos) {
            const stored = await storePhoto(p.name, p.bytes, p.mimeType, p.width, p.height, p.sha256)
            photos.push({ ...stored, id: p.id })
          }
          const character: Character = {
            ...inc.sheet,
            id: inc.id,
            photos,
            primaryPhotoId: photos.some((p) => p.id === inc.primaryPhotoId) ? inc.primaryPhotoId : photos[0].id,
            version: Math.max(inc.version, existing?.version ?? 0),
            createdAt: inc.createdAt,
            updatedAt: inc.updatedAt,
          }
          await persist(character)
          set((s) => ({ characters: sortCharacters([...s.characters.filter((c) => c.id !== character.id), character]) }))
          if (existing) {
            const keep = new Set(photos.map((p) => p.assetId))
            await discardPhotoAssets(existing.photos.flatMap((p) => (p.assetId && !keep.has(p.assetId) ? [p.assetId] : [])))
            report_.updated.push(inc.sheet.name)
          } else {
            report_.imported.push(inc.sheet.name)
          }
        } catch (err) {
          report_.errors.push(`${inc.sheet.name}: ${toStorageError(err).message}`)
        }
      }
      return report_
    },

    dismissIssue: () => set({ issue: null }),
  }
})

