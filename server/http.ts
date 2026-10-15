import type { IncomingMessage, ServerResponse } from 'node:http'

// Utilitários HTTP: erros com status, leitura do corpo com limite de tamanho
// e respostas JSON padronizadas no formato { error: { message, code } }.

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, err: HttpError) {
  sendJson(res, err.status, { error: { message: err.message, code: err.code } }, err.headers)
}

// Lê o corpo inteiro, recusando acima do limite (sem ler o resto) e
// exigindo JSON.
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Envie o corpo como application/json.')
  }

  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'payload_too_large', `Requisição grande demais (limite de ${maxBytes} bytes).`)
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > maxBytes) {
      throw new HttpError(413, 'payload_too_large', `Requisição grande demais (limite de ${maxBytes} bytes).`)
    }
    chunks.push(buf)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) throw new HttpError(400, 'invalid_json', 'Corpo da requisição vazio.')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json', 'Corpo da requisição não é um JSON válido.')
  }
}
