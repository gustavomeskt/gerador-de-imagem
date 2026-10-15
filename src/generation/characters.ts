import type { ReferenceMimeType } from './references'

// Ficha permanente de um personagem da biblioteca. É independente dos
// projetos: os projetos guardam só o id do personagem.

export const LIBRARY_PROJECT_ID = '__biblioteca__' // "projeto" dono das fotos da biblioteca
export const MAX_CHARACTER_PHOTOS = 6

export interface CharacterSheet {
  name: string
  apparentAge: string
  physicalDescription: string
  faceFeatures: string
  hair: string // cabelo e características marcantes
  distinctiveMarks: string
  defaultOutfit: string // opcional
  preservationNotes: string // instruções de preservação visual
}

export interface CharacterPhoto {
  id: string
  assetId?: string // arquivo no banco (compartilhável entre personagens duplicados)
  src?: string // URL pra exibir
  name: string
  mimeType: ReferenceMimeType
  byteLength: number
  width: number
  height: number
  sha256: string
  missing?: boolean // o arquivo sumiu do armazenamento
}

export interface Character extends CharacterSheet {
  id: string
  photos: CharacterPhoto[]
  primaryPhotoId: string // fotografia principal do rosto
  version: number // aumenta a cada edição
  createdAt: number
  updatedAt: number
}

export const SHEET_FIELDS: Array<{ key: keyof CharacterSheet; label: string; placeholder: string; multiline?: boolean }> = [
  { key: 'name', label: 'Nome', placeholder: 'Ex.: Dona Maria' },
  { key: 'apparentAge', label: 'Idade aparente', placeholder: 'Ex.: cerca de 60 anos' },
  { key: 'physicalDescription', label: 'Descrição física permanente', placeholder: 'Altura, tipo físico, tom de pele…', multiline: true },
  { key: 'faceFeatures', label: 'Características do rosto', placeholder: 'Formato do rosto, olhos, sobrancelhas, sorriso…', multiline: true },
  { key: 'hair', label: 'Cabelo', placeholder: 'Cor, comprimento, corte, textura…' },
  { key: 'distinctiveMarks', label: 'Características marcantes', placeholder: 'Pintas, óculos, rugas, cicatrizes…' },
  { key: 'defaultOutfit', label: 'Roupa padrão (opcional)', placeholder: 'Ex.: blusa florida azul e avental branco', multiline: true },
  { key: 'preservationNotes', label: 'Instruções de preservação visual', placeholder: 'O que nunca pode mudar nesta pessoa…', multiline: true },
]

export function emptySheet(): CharacterSheet {
  return {
    name: '',
    apparentAge: '',
    physicalDescription: '',
    faceFeatures: '',
    hair: '',
    distinctiveMarks: '',
    defaultOutfit: '',
    preservationNotes: '',
  }
}

export function sheetOf(c: CharacterSheet): CharacterSheet {
  return {
    name: c.name,
    apparentAge: c.apparentAge,
    physicalDescription: c.physicalDescription,
    faceFeatures: c.faceFeatures,
    hair: c.hair,
    distinctiveMarks: c.distinctiveMarks,
    defaultOutfit: c.defaultOutfit,
    preservationNotes: c.preservationNotes,
  }
}

// Valida e limpa os textos de uma ficha (lidos da tela ou de um backup).
export function normalizeSheet(raw: unknown): { ok: true; sheet: CharacterSheet } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'ficha inválida' }
  const r = raw as Record<string, unknown>
  const sheet = emptySheet()
  for (const key of Object.keys(sheet) as Array<keyof CharacterSheet>) {
    const v = r[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string') return { ok: false, error: `campo "${key}" precisa ser texto` }
    if (v.length > 2000) return { ok: false, error: `campo "${key}" passa de 2000 caracteres` }
    sheet[key] = v.trim()
  }
  if (!sheet.name) return { ok: false, error: 'o personagem precisa de um nome' }
  if (sheet.name.length > 80) return { ok: false, error: 'nome com mais de 80 caracteres' }
  return { ok: true, sheet }
}

// Fotos na ordem de envio: a principal (rosto) primeiro.
export function orderedPhotos(c: Pick<Character, 'photos' | 'primaryPhotoId'>): CharacterPhoto[] {
  const primary = c.photos.find((p) => p.id === c.primaryPhotoId)
  return primary ? [primary, ...c.photos.filter((p) => p.id !== primary.id)] : c.photos
}
