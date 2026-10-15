import { Star, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  emptySheet,
  MAX_CHARACTER_PHOTOS,
  sheetOf,
  SHEET_FIELDS,
  type Character,
  type CharacterSheet,
} from '../generation/characters'
import { checkReferenceFile, DEFAULT_MAX_REFERENCE_BYTES, REFERENCE_MIME_TYPES } from '../generation/references'
import { useCharacterStore, type DraftPhoto } from '../store/useCharacterStore'

type EditorPhoto =
  | { key: string; kind: 'existing'; photoId: string; src?: string; name: string; missing?: boolean }
  | { key: string; kind: 'new'; name: string; bytes: Uint8Array; src: string }

let keyCounter = 0
const nextKey = () => `k${++keyCounter}`

function formatDate(ts: number) {
  return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

// Cadastro / edição / visualização da ficha de um personagem.
// initialName: pré-preenche o nome (cadastro a partir da historinha);
// onSaved: recebe o id do personagem salvo.
export default function CharacterEditor({
  character,
  onClose,
  initialName,
  onSaved,
}: {
  character?: Character
  onClose: () => void
  initialName?: string
  onSaved?: (id: string) => void
}) {
  const saveCharacter = useCharacterStore((s) => s.saveCharacter)
  const [sheet, setSheet] = useState<CharacterSheet>(() =>
    character ? sheetOf(character) : { ...emptySheet(), ...(initialName ? { name: initialName } : {}) },
  )
  const [photos, setPhotos] = useState<EditorPhoto[]>(() =>
    (character?.photos ?? []).map((p) => ({ key: nextKey(), kind: 'existing', photoId: p.id, src: p.src, name: p.name, missing: p.missing })),
  )
  // foto escolhida como principal nesta edição (null = mantém a atual)
  const [primaryKey, setPrimaryKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // foto principal: a marcada, ou a que era principal, ou a primeira
  const primary = useMemo(() => {
    if (primaryKey && photos.some((p) => p.key === primaryKey)) return primaryKey
    const original = photos.find((p) => p.kind === 'existing' && p.photoId === character?.primaryPhotoId)
    return original?.key ?? photos[0]?.key ?? null
  }, [primaryKey, photos, character])

  // libera as URLs temporárias das fotos novas ao fechar
  const created = useRef<string[]>([])
  useEffect(() => () => created.current.forEach((url) => URL.revokeObjectURL(url)), [])

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    const problems: string[] = []
    const added: EditorPhoto[] = []
    for (const file of files) {
      if (photos.length + added.length >= MAX_CHARACTER_PHOTOS) {
        problems.push(`${file.name}: limite de ${MAX_CHARACTER_PHOTOS} fotos por personagem`)
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await file.arrayBuffer())
      } catch {
        problems.push(`${file.name}: não foi possível ler o arquivo`)
        continue
      }
      const check = checkReferenceFile(bytes)
      if (!check.ok) {
        problems.push(`${file.name}: ${check.error}`)
        continue
      }
      const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: check.mimeType }))
      created.current.push(src)
      added.push({ key: nextKey(), kind: 'new', name: file.name, bytes, src })
    }
    setPhotos((list) => [...list, ...added])
    setErrors(problems)
  }

  async function handleSave() {
    setSaving(true)
    const draftPhotos: DraftPhoto[] = photos.map((p) =>
      p.kind === 'existing' ? { kind: 'existing', photoId: p.photoId } : { kind: 'new', name: p.name, bytes: p.bytes },
    )
    const result = await saveCharacter({
      id: character?.id,
      sheet,
      photos: draftPhotos,
      primaryIndex: Math.max(0, photos.findIndex((p) => p.key === primary)),
    })
    setSaving(false)
    if (result.ok) {
      onSaved?.(result.id)
      onClose()
    } else setErrors([result.error])
  }

  return (
    <div className="ifs-dialog-backdrop" onClick={onClose}>
      <div className="ifs-dialog ifs-dialog--wide" role="dialog" aria-modal="true" aria-label="Personagem" onClick={(e) => e.stopPropagation()}>
        <div className="ifs-dialog__header">
          <h2>{character ? `Personagem: ${character.name}` : 'Novo personagem'}</h2>
          <button type="button" className="ifs-dialog__close" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </div>
        {character && (
          <p className="ifs-character-editor__meta">
            Criado em {formatDate(character.createdAt)} · atualizado em {formatDate(character.updatedAt)} · versão{' '}
            {character.version}
          </p>
        )}

        <div className="ifs-character-editor">
          <section>
            <h3>Fotografias</h3>
            <p className="ifs-character-editor__hint">
              A foto marcada com estrela é a <strong>principal do rosto</strong> (vai primeiro em toda geração). PNG, JPG
              ou WebP, até {DEFAULT_MAX_REFERENCE_BYTES / 1024 / 1024} MB, até {MAX_CHARACTER_PHOTOS} fotos.
            </p>
            <div className="ifs-character-editor__photos">
              {photos.map((p) => (
                <div key={p.key} className={p.key === primary ? 'ifs-character-photo ifs-character-photo--primary' : 'ifs-character-photo'}>
                  {p.src && !(p.kind === 'existing' && p.missing) ? <img src={p.src} alt={p.name} /> : <span>arquivo ausente</span>}
                  <div className="ifs-character-photo__actions">
                    <button type="button" title="Usar como foto principal do rosto" onClick={() => setPrimaryKey(p.key)}>
                      <Star size={13} fill={p.key === primary ? 'currentColor' : 'none'} />
                    </button>
                    <button type="button" title="Remover foto" onClick={() => setPhotos((list) => list.filter((x) => x.key !== p.key))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="ifs-dialog__cancel"
              onClick={() => input.current?.click()}
              disabled={photos.length >= MAX_CHARACTER_PHOTOS}
            >
              Adicionar fotos ({photos.length}/{MAX_CHARACTER_PHOTOS})
            </button>
            <input ref={input} type="file" accept={REFERENCE_MIME_TYPES.join(',')} multiple hidden onChange={handleFiles} />
          </section>

          <section className="ifs-character-editor__fields">
            <h3>Ficha visual permanente</h3>
            {SHEET_FIELDS.map((f) => (
              <label key={f.key}>
                {f.label}
                {f.multiline ? (
                  <textarea
                    rows={2}
                    value={sheet[f.key]}
                    placeholder={f.placeholder}
                    onChange={(e) => setSheet({ ...sheet, [f.key]: e.target.value })}
                  />
                ) : (
                  <input
                    type="text"
                    value={sheet[f.key]}
                    placeholder={f.placeholder}
                    maxLength={f.key === 'name' ? 80 : 2000}
                    onChange={(e) => setSheet({ ...sheet, [f.key]: e.target.value })}
                  />
                )}
              </label>
            ))}
          </section>
        </div>

        {errors.length > 0 && (
          <ul className="ifs-character-editor__errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="ifs-dialog__actions">
          <button type="button" className="ifs-dialog__cancel" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="ifs-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar personagem'}
          </button>
        </div>
      </div>
    </div>
  )
}
