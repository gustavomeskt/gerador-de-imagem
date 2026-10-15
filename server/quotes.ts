import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from './http'

// Orçamentos (quotes). A interface pede um orçamento, mostra o custo e só
// depois de a pessoa confirmar envia as chamadas pagas com o quoteId.
// O servidor confere que o pedido é exatamente o orçado, que não venceu e
// que não passou da quantidade de imagens confirmada. Sem quoteId válido,
// nenhuma chamada paga acontece.

export interface QuoteRecord {
  id: string
  kind: 'images' | 'enhance' | 'story' | 'batch'
  fingerprint: string
  // lote: cada item (prompt + referências) pode ser usado uma vez
  items?: Map<string, { count: number; usd: number }>
  images: number
  remainingImages: number
  remainingCalls: number
  usd: number
  usdPerImage: number
  expiresAt: number
}

export function fingerprint(parts: Record<string, unknown>): string {
  const ordered = Object.keys(parts)
    .sort()
    .map((k) => [k, parts[k] ?? null])
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export class QuoteStore {
  private readonly quotes = new Map<string, QuoteRecord>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.now = now
  }

  private sweep() {
    const t = this.now()
    for (const [id, q] of this.quotes) if (q.expiresAt <= t) this.quotes.delete(id)
  }

  create(input: {
    kind: QuoteRecord['kind']
    fingerprint: string
    images: number
    calls: number
    usd: number
    items?: Array<{ fingerprint: string; usd: number }>
    ttlMs?: number
  }): QuoteRecord {
    this.sweep()
    let items: QuoteRecord['items']
    if (input.items) {
      items = new Map()
      for (const it of input.items) {
        const entry = items.get(it.fingerprint) ?? { count: 0, usd: it.usd }
        entry.count += 1
        items.set(it.fingerprint, entry)
      }
    }
    const record: QuoteRecord = {
      ...(items ? { items } : {}),
      id: randomUUID(),
      kind: input.kind,
      fingerprint: input.fingerprint,
      images: input.images,
      remainingImages: input.images,
      remainingCalls: input.calls,
      usd: input.usd,
      usdPerImage: input.images > 0 ? input.usd / input.images : input.usd,
      expiresAt: this.now() + (input.ttlMs ?? this.ttlMs),
    }
    this.quotes.set(record.id, record)
    return record
  }

  // Valida e desconta do orçamento. Devolve o valor estimado desta chamada.
  consume(id: string | undefined, expected: { kind: QuoteRecord['kind']; fingerprint: string; images: number }): number {
    if (!id) {
      throw new HttpError(
        428,
        'confirmation_required',
        'Chamada paga sem confirmação. Peça um orçamento e confirme o custo antes de gerar.',
      )
    }
    this.sweep()
    const q = this.quotes.get(id)
    if (!q) throw new HttpError(409, 'quote_invalid', 'Orçamento inexistente, vencido ou já usado. Peça um novo orçamento.')
    if (q.kind === 'batch' && expected.kind === 'images') {
      // cada chamada do lote = 1 imagem de um item orçado, exatamente igual
      const item = q.items?.get(expected.fingerprint)
      if (!item || expected.images !== 1) {
        throw new HttpError(409, 'quote_mismatch', 'Esta imagem não corresponde a nenhuma cena do lote confirmado (cena, modelo ou referências mudaram).')
      }
      if (item.count < 1) throw new HttpError(409, 'quote_exhausted', 'Esta cena do lote já foi gerada com este orçamento. Peça um novo orçamento.')
      item.count -= 1
      q.remainingImages -= 1
      return item.usd
    }
    if (q.kind !== expected.kind || q.fingerprint !== expected.fingerprint) {
      throw new HttpError(409, 'quote_mismatch', 'O pedido não corresponde ao orçamento confirmado.')
    }
    if (q.remainingCalls < 1 || expected.images > q.remainingImages) {
      throw new HttpError(409, 'quote_exhausted', 'Este orçamento já foi usado. Peça um novo orçamento.')
    }
    q.remainingImages -= expected.images
    q.remainingCalls -= 1
    if (q.remainingCalls === 0 || (q.kind === 'images' && q.remainingImages === 0)) this.quotes.delete(id)
    return q.kind === 'images' ? q.usdPerImage * expected.images : q.usd
  }

  // Devolve ao lote um item cuja chamada a OpenAI RECUSOU (nada foi cobrado),
  // pra que uma nova tentativa possa usá-lo. Em timeout não devolve.
  release(id: string | undefined, fingerprint: string) {
    if (!id) return
    const q = this.quotes.get(id)
    const item = q?.kind === 'batch' ? q.items?.get(fingerprint) : undefined
    if (!q || !item) return
    item.count += 1
    q.remainingImages += 1
  }
}
