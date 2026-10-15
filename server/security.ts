import type { IncomingMessage } from 'node:http'
import type { ServerConfig } from './config'
import { HttpError } from './http'

// Proteções de acesso para um servidor local sem login:
//
// 1. Host: só aceita requisições endereçadas a localhost/127.0.0.1/[::1].
//    Bloqueia "DNS rebinding" (um site malicioso apontando um domínio pra
//    127.0.0.1 pra falar com este servidor).
// 2. Origin: se o navegador informar a origem, ela precisa ser o próprio app
//    (ALLOWED_ORIGINS). Bloqueia outros sites abertos no navegador de
//    dispararem gerações pagas.
// 3. Content-Type JSON obrigatório (em http.ts): força o navegador a fazer
//    preflight CORS — e este servidor não responde CORS, então requisições
//    de outras origens nem chegam a ser enviadas.

function hostWithoutPort(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']'))
  return hostHeader.split(':')[0]
}

export function checkRequestOrigin(req: IncomingMessage, config: ServerConfig) {
  const hostHeader = req.headers.host
  if (!hostHeader) throw new HttpError(400, 'missing_host', 'Cabeçalho Host ausente.')
  const host = hostWithoutPort(hostHeader).toLowerCase()
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new HttpError(403, 'forbidden_host', 'Este servidor só atende requisições locais.')
  }

  const origin = req.headers.origin
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'forbidden_origin', 'Origem não autorizada.')
  }

  // navegadores modernos informam se a requisição veio de outro site
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') {
    throw new HttpError(403, 'forbidden_origin', 'Requisições de outros sites não são aceitas.')
  }
}
