import type { FastifyReply, FastifyRequest } from 'fastify'
import { RateLimitedError } from '../errors/index.ts'

export const RATE_LIMIT_WINDOW_MS = 60_000
/** Tope de claves vivas; si se supera tras limpiar, se descartan las más antiguas. */
export const DEFAULT_MAX_KEYS = 10_000

export interface RateLimiterOptions {
  /** Peticiones permitidas por clave dentro de la ventana. */
  limit: number
  windowMs?: number
  /** Reloj inyectable (ms) para los tests. */
  now?: () => number
  maxKeys?: number
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/**
 * Ventana deslizante con registro de marcas de tiempo por clave.
 * Se elige deslizante (y no fija) porque la fija deja pasar hasta el doble del límite
 * en el borde entre dos ventanas, y aquí cada `start` lanza un proceso. El costo en
 * memoria está acotado: como mucho `limit` marcas por clave y `maxKeys` claves.
 * Sin temporizadores: la limpieza de claves viejas se hace al consultar, así el motor
 * no deja handles abiertos al cerrar.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly maxKeys: number
  private lastSweep: number

  constructor(opts: RateLimiterOptions) {
    this.limit = opts.limit
    this.windowMs = opts.windowMs ?? RATE_LIMIT_WINDOW_MS
    this.now = opts.now ?? Date.now
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS
    this.lastSweep = this.now()
  }

  /** Consume una unidad de cupo para `key` si queda; si no, dice cuánto esperar. */
  hit(key: string): RateLimitResult {
    const now = this.now()
    this.maybeSweep(now)
    const cutoff = now - this.windowMs
    const stamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    if (stamps.length >= this.limit) {
      this.hits.set(key, stamps)
      const oldest = stamps[0] ?? now
      const waitMs = oldest + this.windowMs - now
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
    }
    stamps.push(now)
    // Reinsertar mueve la clave al final: el orden del Map queda por uso reciente.
    this.hits.delete(key)
    this.hits.set(key, stamps)
    this.enforceMaxKeys(now)
    return { allowed: true }
  }

  /** Número de claves vivas (diagnóstico y tests). */
  get size(): number {
    return this.hits.size
  }

  /** Elimina las claves cuyas marcas ya salieron todas de la ventana. */
  sweep(now = this.now()): void {
    const cutoff = now - this.windowMs
    for (const [key, stamps] of this.hits) {
      const last = stamps[stamps.length - 1]
      if (last === undefined || last <= cutoff) this.hits.delete(key)
    }
    this.lastSweep = now
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep >= this.windowMs) this.sweep(now)
  }

  private enforceMaxKeys(now: number): void {
    if (this.hits.size <= this.maxKeys) return
    this.sweep(now)
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break
      this.hits.delete(key)
    }
  }
}

/**
 * Hook `onRequest` por ruta. Corre después de las guardas globales (token/Origin),
 * así que una petición rechazada con 401/403 no consume cupo, y antes de parsear
 * el cuerpo y validar la acción.
 */
export function rateLimitHook(
  limiter: RateLimiter,
  keyOf: (request: FastifyRequest) => string,
  message = 'Demasiadas peticiones; espera antes de reintentar',
) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const result = limiter.hit(keyOf(request))
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds, message)
  }
}

export interface RateLimits {
  /** Escrituras generales (proyectos, alta y baja de agentes) por workspace. */
  writes: ReturnType<typeof rateLimitHook>
  /** Acciones que lanzan o controlan un proceso, por workspace + agente. */
  agentActions: ReturnType<typeof rateLimitHook>
}

export function createRateLimits(opts: {
  writesPerWindow: number
  agentActionsPerWindow: number
  now?: () => number
}): RateLimits {
  const writes = new RateLimiter({ limit: opts.writesPerWindow, now: opts.now })
  const agentActions = new RateLimiter({ limit: opts.agentActionsPerWindow, now: opts.now })
  return {
    writes: rateLimitHook(writes, (request) => request.workspaceId),
    agentActions: rateLimitHook(
      agentActions,
      (request) => {
        const { id } = (request.params ?? {}) as { id?: unknown }
        // Se acota la longitud: el id aún no está validado en este punto.
        const agentId = typeof id === 'string' ? id.slice(0, 64) : ''
        return `${request.workspaceId}:${agentId}`
      },
      'Demasiadas acciones sobre este agente; espera antes de reintentar',
    ),
  }
}
