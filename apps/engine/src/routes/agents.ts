import { CreateAgentInput, Id, ResumeInput, RetryInput, StartTaskInput } from '@cdm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AgentManager } from '../agents/manager.ts'
import { parseInput } from '../errors/index.ts'
import type { RateLimits } from '../security/rate-limit.ts'

const Params = z.object({ id: Id })
const RunParams = z.object({ id: Id, runId: Id })

export function agentRoutes(app: FastifyInstance, manager: AgentManager, limits: RateLimits): void {
  // El rate limit va en `onRequest` de cada ruta: corre tras las guardas de token/Origin
  // y antes de parsear el cuerpo y validar. Los GET no se limitan.
  // Solo `tasks`, `resume` y `retry` comparten el cupo por agente porque son las únicas
  // acciones que lanzan un proceso del SDK. `pause` y `stop` quedan fuera a propósito: no lanzan
  // nada y detener un agente que sigue gastando debe estar siempre disponible (un 429
  // ahí dejaría al usuario sin freno hasta 60 s).
  const writes = { onRequest: limits.writes }
  const agentAction = { onRequest: limits.agentActions }

  app.post('/agents', writes, async (request, reply) => {
    const input = parseInput(CreateAgentInput, request.body)
    const agent = manager.createAgent(request.workspaceId, input)
    return reply.status(201).send({ agent })
  })

  app.get('/agents', async (request) => {
    return { agents: manager.listAgents(request.workspaceId) }
  })

  app.get('/agents/:id', async (request) => {
    const { id } = parseInput(Params, request.params)
    return manager.getAgent(request.workspaceId, id)
  })

  app.delete('/agents/:id', writes, async (request, reply) => {
    const { id } = parseInput(Params, request.params)
    manager.deleteAgent(request.workspaceId, id)
    return reply.status(204).send()
  })

  app.post('/agents/:id/tasks', agentAction, async (request, reply) => {
    const { id } = parseInput(Params, request.params)
    const input = parseInput(StartTaskInput, request.body)
    const run = manager.startTask(request.workspaceId, id, input)
    return reply.status(202).send({ runId: run.id })
  })

  app.post('/agents/:id/tasks/:runId/retry', agentAction, async (request, reply) => {
    const { id, runId } = parseInput(RunParams, request.params)
    const input = parseInput(RetryInput, request.body ?? {})
    const run = manager.retry(request.workspaceId, id, runId, input)
    return reply.status(202).send({ runId: run.id })
  })

  app.post('/agents/:id/pause', async (request) => {
    const { id } = parseInput(Params, request.params)
    return { agent: await manager.pause(request.workspaceId, id) }
  })

  app.post('/agents/:id/resume', agentAction, async (request, reply) => {
    const { id } = parseInput(Params, request.params)
    const input = parseInput(ResumeInput, request.body ?? {})
    const run = manager.resume(request.workspaceId, id, input)
    return reply.status(202).send({ runId: run.id })
  })

  app.post('/agents/:id/stop', async (request) => {
    const { id } = parseInput(Params, request.params)
    return { agent: await manager.stop(request.workspaceId, id) }
  })
}
