import { Id, MessageHistoryQuery } from '@cdm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MessageBus } from '../bus/bus.ts'
import { parseInput } from '../errors/index.ts'
import type { RateLimits } from '../security/rate-limit.ts'

const Params = z.object({ id: Id })

/**
 * Bus de mensajes desde la app (feature 002). Pasan por las guardas globales (token,
 * `Origin`, `Host`); el POST usa el límite de escrituras y el GET no se limita. El remitente
 * de `POST /messages` es siempre el usuario: el cuerpo no puede elegirlo (esquema estricto).
 */
export function messageRoutes(app: FastifyInstance, bus: MessageBus, limits: RateLimits): void {
  app.post('/messages', { onRequest: limits.writes }, async (request, reply) => {
    // `bus.send` valida el cuerpo con `PostMessageInput` antes de usarlo.
    const messages = bus.send(request.workspaceId, { kind: 'user' }, request.body)
    return reply.status(201).send({ messages })
  })

  app.get('/agents/:id/messages', async (request) => {
    const { id } = parseInput(Params, request.params)
    const query = parseInput(MessageHistoryQuery, request.query ?? {})
    return bus.history(request.workspaceId, id, query.limit, query.cursor)
  })
}
