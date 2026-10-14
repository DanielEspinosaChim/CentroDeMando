import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenError, UnauthorizedError } from '../errors/index.ts'
import { tokensMatch } from './local-token.ts'

export const WS_PROTOCOL_PREFIX = 'cdm.'
export const WS_UNAUTHORIZED_CLOSE_CODE = 4401
export const WS_PATH = '/ws'

const PUBLIC_PATHS = new Set(['/health'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost'])

/** `true` si la cabecera Host apunta a esta máquina (frena DNS rebinding). */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return LOCAL_HOSTNAMES.has((hostname ?? '').toLowerCase())
}

export interface GuardOptions {
  token: string
  allowedOrigins: readonly string[]
  workspaceId: string
}

declare module 'fastify' {
  interface FastifyRequest {
    workspaceId: string
  }
}

function pathOf(request: FastifyRequest): string {
  const url = request.raw.url ?? '/'
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  return /^Bearer (\S+)$/.exec(header)?.[1]
}

/** Extrae el token del subprotocolo WebSocket `cdm.<token>`. */
export function wsProtocolToken(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (!raw) return undefined
  for (const part of raw.split(',')) {
    const value = part.trim()
    if (value.startsWith(WS_PROTOCOL_PREFIX)) return value.slice(WS_PROTOCOL_PREFIX.length)
  }
  return undefined
}

export function isWsTokenValid(request: FastifyRequest, token: string): boolean {
  return tokensMatch(token, wsProtocolToken(request.headers['sec-websocket-protocol']))
}

/**
 * - `Origin` presente y distinto de la interfaz → 403 (protege contra páginas web
 *   que llamen a localhost). Sin `Origin` (clientes que no son navegador) se permite.
 * - Token local en `Authorization: Bearer` → si falta o no coincide, 401.
 * - En `/ws` el token se valida en el handler para poder cerrar con 4401.
 */
export function registerGuards(app: FastifyInstance, opts: GuardOptions): void {
  app.decorateRequest('workspaceId', '')
  app.addHook('onRequest', async (request, reply) => {
    if (!isLocalHost(request.headers.host)) {
      if (request.headers.upgrade) {
        reply.hijack()
        request.raw.socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        )
        return
      }
      throw new ForbiddenError('Host no permitido')
    }
    const origin = request.headers.origin
    if (origin !== undefined && !opts.allowedOrigins.includes(origin)) {
      if (request.headers.upgrade) {
        // En un upgrade WebSocket la respuesta normal deja el socket colgado: se cierra a mano.
        reply.hijack()
        request.raw.socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        )
        return
      }
      throw new ForbiddenError()
    }
    const p = pathOf(request)
    if (PUBLIC_PATHS.has(p)) return
    // Fase 1: el token local identifica al único workspace.
    request.workspaceId = opts.workspaceId
    if (p === WS_PATH) return
    if (!tokensMatch(opts.token, bearerToken(request.headers.authorization))) {
      throw new UnauthorizedError()
    }
  })
}
