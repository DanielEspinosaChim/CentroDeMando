import type { FastifyError, FastifyInstance } from 'fastify'
import type { z } from 'zod'

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Datos inválidos') {
    super(400, 'VALIDATION_ERROR', message)
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'Token local inválido o ausente')
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Origen no permitido') {
    super(403, 'FORBIDDEN', message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'No encontrado') {
    super(404, 'NOT_FOUND', message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message)
  }
}

export class LimitError extends AppError {
  constructor(message: string) {
    super(429, 'LIMIT_EXCEEDED', message)
  }
}

/** Rate limit de rutas de escritura (distinto del tope de concurrencia `LimitError`). */
export class RateLimitedError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    message = 'Demasiadas peticiones; espera antes de reintentar',
  ) {
    super(429, 'RATE_LIMITED', message)
  }
}

/** Valida con Zod y convierte el fallo en `ValidationError` sin filtrar internos. */
export function parseInput<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  const detail = result.error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
  throw new ValidationError(detail || 'Datos inválidos')
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

/** Respuesta uniforme `{ error: { code, message } }`, sin stack traces ni rutas internas. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof RateLimitedError) {
      reply.header('retry-after', String(err.retryAfterSeconds))
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message))
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500
    if (status === 413) {
      return reply.status(413).send(errorBody('PAYLOAD_TOO_LARGE', 'Cuerpo demasiado grande'))
    }
    if (status >= 400 && status < 500) {
      // Errores de Fastify (JSON mal formado, content-type no soportado, etc.).
      return reply.status(400).send(errorBody('VALIDATION_ERROR', 'Petición inválida'))
    }
    request.log.error({ err: { name: err.name, message: err.message } }, 'error no controlado')
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Error interno'))
  })
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(errorBody('NOT_FOUND', 'Ruta no encontrada'))
  })
}
