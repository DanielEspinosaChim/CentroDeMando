import { RateLimiter } from '../security/rate-limit.ts'

/** Mensajes que un agente puede enviar por minuto (criterio C002-6, checklist punto 7). */
export const MAX_MESSAGES_PER_MINUTE = 20
/** Despertares automáticos encadenados permitidos por hilo (criterio C002-7, punto D). */
export const MAX_WAKE_DEPTH = 10

export interface BusLimitsOptions {
  messagesPerMinute?: number
  maxWakeDepth?: number
  /** Reloj inyectable (ms) para los tests. */
  now?: () => number
}

/** Contexto de hilo heredado: de qué hilo viene la ejecución y cuántos despertares lleva. */
export interface ThreadContext {
  threadId: string
  depth: number
}

/**
 * Profundidad de un mensaje nuevo: la mayor entre el mensaje al que responde y el contexto
 * de la ejecución desde la que se envía (así responder a un mensaje viejo no reinicia la
 * cuenta), más uno si pide despertar. Un mensaje sin antecedentes y sin `wake` queda en 0.
 */
export function nextDepth(parents: ReadonlyArray<{ depth: number } | undefined>, wake: boolean) {
  const base = Math.max(0, ...parents.map((p) => p?.depth ?? 0))
  return base + (wake ? 1 : 0)
}

/** Frenos del bus: ventana deslizante de 60 s por remitente y profundidad máxima por hilo. */
export class BusLimits {
  readonly maxWakeDepth: number
  private readonly limiter: RateLimiter

  constructor(opts: BusLimitsOptions = {}) {
    this.maxWakeDepth = opts.maxWakeDepth ?? MAX_WAKE_DEPTH
    this.limiter = new RateLimiter({
      limit: opts.messagesPerMinute ?? MAX_MESSAGES_PER_MINUTE,
      ...(opts.now ? { now: opts.now } : {}),
    })
  }

  /** Consume un envío del cupo del agente; `false` si ya alcanzó el límite del minuto. */
  tryConsume(workspaceId: string, agentId: string): boolean {
    return this.limiter.hit(`${workspaceId}:${agentId}`).allowed
  }

  /** Un mensaje con esta profundidad todavía puede despertar a su destinatario. */
  canWake(depth: number): boolean {
    return depth >= 1 && depth <= this.maxWakeDepth
  }
}
