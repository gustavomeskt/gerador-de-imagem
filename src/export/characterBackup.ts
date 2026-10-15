import JSZip from 'jszip'
import { MAX_CHARACTER_PHOTOS, normalizeSheet, sheetOf, type Character, type CharacterPhoto } from '../generation/characters'
import { checkReferenceFile } from '../generation/references'
import { extensionFor, sha256Hex } from '../lib/binary'
import type { IncomingCharacter } from '../store/useCharacterStore'
import { zipFileName } from './projectZip'

// Backup da biblioteca de personagens: um ZIP com as fichas, os metadados e
// as FOTOS ORIGINAIS, pra recuperar os personagens em outro navegador ou
// computador. A importação valida tudo (estrutura, tipos, tamanhos, hash de
// cada foto) antes de gravar.

export const BACKUP_FORMAT = 'image-flow-studio/biblioteca-de-personagens'
export const BACKUP_VERSION = 1
const MAX_ZIP_ENTRIES = 2000
const MAX_BACKUP_JSON_BYTES = 5 * 1024 * 1024

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

interface BackupPhoto {
  id: string
  file: string
  name: string
  mimeType: string
  byteLength: number
  width: number
  height: number
  sha256: string
}

export interface BackupCharacter {
  id: string
  createdAt: number
  updatedAt: number
  version: number
  sheet: Record<string, string>
  primaryPhotoId: string
  photos: BackupPhoto[]
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  exportedAt: string
  characterCount: number
  photoCount: number
  characters: BackupCharacter[]
  missingPhotos: Array<{ character: string; photo: string }>
}

export async function buildCharacterBackup(params: {
  characters: Character[]
  loadBytes: (photo: CharacterPhoto) => Promise<Uint8Array | undefined>
  now?: Date
}): Promise<{ data: Uint8Array; manifest: BackupManifest; fileName: string }> {
  const now = params.now ?? new Date()
  const zip = new JSZip()
  const entries: BackupCharacter[] = []
  const missing: BackupManifest['missingPhotos'] = []
  let photoCount = 0

  for (const c of params.characters) {
    const photos: BackupPhoto[] = []
    for (const p of c.photos) {
      const bytes = await params.loadBytes(p)
      if (!bytes) {
        missing.push({ character: c.name, photo: p.name })
        continue
      }
      const file = `fotos/${c.id}/${p.id}.${extensionFor(p.mimeType)}`
      zip.file(file, bytes, { binary: true })
      photos.push({ id: p.id, file, name: p.name, mimeType: p.mimeType, byteLength: bytes.byteLength, width: p.width, height: p.height, sha256: await sha256Hex(bytes) })
      photoCount += 1
    }
    entries.push({
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      version: c.version,
      sheet: { ...sheetOf(c) },
      primaryPhotoId: c.primaryPhotoId,
      photos,
    })
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    characterCount: entries.length,
    photoCount,
    characters: entries,
    missingPhotos: missing,
  }
  zip.file('backup.json', JSON.stringify(manifest, null, 2))
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { data, manifest, fileName: zipFileName('biblioteca-personagens', now) }
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/

function uncompressedSize(file: JSZip.JSZipObject): number | undefined {
  // JSZip guarda o tamanho descompactado declarado no ZIP (não é API pública)
  const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
  return typeof size === 'number' ? size : undefined
}

// Lê e valida um backup. Erros de estrutura (não é um backup válido)
// lançam BackupError; problemas num personagem só pulam aquele personagem.
export async function parseCharacterBackup(
  input: Uint8Array | ArrayBuffer,
  maxPhotoBytes?: number,
): Promise<{ characters: IncomingCharacter[]; errors: string[] }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(input)
  } catch {
    throw new BackupError('O arquivo não é um ZIP válido.')
  }
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) throw new BackupError('O ZIP tem arquivos demais para ser um backup.')

  const jsonFile = zip.file('backup.json')
  if (!jsonFile) throw new BackupError('backup.json não encontrado — este ZIP não é um backup da biblioteca de personagens.')
  if ((uncompressedSize(jsonFile) ?? 0) > MAX_BACKUP_JSON_BYTES) throw new BackupError('backup.json grande demais.')

  let manifest: Partial<BackupManifest>
  try {
    manifest = JSON.parse(await jsonFile.async('string'))
  } catch {
    throw new BackupError('backup.json não é um JSON válido.')
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError('Este ZIP não é um backup da biblioteca de personagens.')
  if (manifest.formatVersion !== BACKUP_VERSION) {
    throw new BackupError(`Versão de backup não suportada (${String(manifest.formatVersion)}).`)
  }
  if (!Array.isArray(manifest.characters)) throw new BackupError('backup.json sem a lista de personagens.')

  const characters: IncomingCharacter[] = []
  const errors: string[] = []
  const seenIds = new Set<string>()

  for (const raw of manifest.characters as unknown[]) {
    const c = raw as Partial<BackupCharacter>
    const label = typeof c?.sheet?.name === 'string' && c.sheet.name ? c.sheet.name : String(c?.id ?? 'personagem')
    const fail = (msg: string) => errors.push(`${label}: ${msg}`)

    if (typeof c?.id !== 'string' || !ID_RE.test(c.id)) { fail('identificador inválido'); continue }
    if (seenIds.has(c.id)) { fail('identificador repetido no backup'); continue }
    if (typeof c.createdAt !== 'number' || typeof c.updatedAt !== 'number') { fail('datas inválidas'); continue }
    const version = Number.isInteger(c.version) && (c.version as number) >= 1 ? (c.version as number) : 1
    const sheet = normalizeSheet(c.sheet)
    if (!sheet.ok) { fail(sheet.error); continue }
    if (!Array.isArray(c.photos) || c.photos.length === 0) { fail('sem fotos'); continue }
    if (c.photos.length > MAX_CHARACTER_PHOTOS) { fail(`mais de ${MAX_CHARACTER_PHOTOS} fotos`); continue }

    const photos: IncomingCharacter['photos'] = []
    let bad = false
    for (const p of c.photos as Partial<BackupPhoto>[]) {
      const name = typeof p?.name === 'string' ? p.name.slice(0, 200) : 'foto'
      if (typeof p?.id !== 'string' || !ID_RE.test(p.id) || typeof p.file !== 'string') { fail(`foto "${name}" com dados inválidos`); bad = true; break }
      if (!p.file.startsWith('fotos/') || p.file.includes('..')) { fail(`caminho de foto inválido (${p.file})`); bad = true; break }
      const entry = zip.file(p.file)
      if (!entry) { fail(`foto "${name}" não está no ZIP`); bad = true; break }
      const declared = uncompressedSize(entry)
      if (declared !== undefined && declared > (maxPhotoBytes ?? 8 * 1024 * 1024)) { fail(`foto "${name}" grande demais`); bad = true; break }
      const bytes = await entry.async('uint8array')
      const check = checkReferenceFile(bytes, maxPhotoBytes)
      if (!check.ok) { fail(`foto "${name}": ${check.error}`); bad = true; break }
      const sha = await sha256Hex(bytes)
      if (typeof p.sha256 !== 'string' || p.sha256 !== sha) { fail(`foto "${name}" corrompida (hash não confere)`); bad = true; break }
      if (p.byteLength !== bytes.byteLength) { fail(`foto "${name}" com tamanho diferente do registrado`); bad = true; break }
      photos.push({ id: p.id, name, mimeType: check.mimeType, bytes, width: check.width, height: check.height, sha256: sha })
    }
    if (bad) continue

    seenIds.add(c.id)
    characters.push({
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      version,
      sheet: sheet.sheet,
      primaryPhotoId: typeof c.primaryPhotoId === 'string' ? c.primaryPhotoId : photos[0].id,
      photos,
    })
  }
  return { characters, errors }
}
