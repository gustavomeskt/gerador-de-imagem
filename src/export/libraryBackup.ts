import type { CharacterPhoto } from '../generation/characters'
import { dataUrlToBytes } from '../lib/binary'
import { repository } from '../persistence/repository'
import { useCharacterStore, type ImportReport } from '../store/useCharacterStore'
import { buildCharacterBackup, parseCharacterBackup, type BackupManifest } from './characterBackup'

// Liga o backup à tela: exporta a biblioteca atual e importa um ZIP escolhido.

async function loadPhotoBytes(photo: CharacterPhoto): Promise<Uint8Array | undefined> {
  if (photo.src?.startsWith('data:')) return dataUrlToBytes(photo.src).bytes
  if (photo.assetId && useCharacterStore.getState().persistent) {
    const asset = await repository.getAsset(photo.assetId)
    return asset ? new Uint8Array(asset.bytes) : undefined
  }
  return undefined
}

export async function exportLibraryBackup(): Promise<BackupManifest> {
  const { data, manifest, fileName } = await buildCharacterBackup({
    characters: useCharacterStore.getState().characters,
    loadBytes: loadPhotoBytes,
  })
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return manifest
}

export async function importLibraryBackup(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<ImportReport> {
  const { characters, errors } = await parseCharacterBackup(await file.arrayBuffer())
  const report = await useCharacterStore.getState().importCharacters(characters)
  return { ...report, errors: [...errors, ...report.errors] }
}

export { loadPhotoBytes }
