import { CreateAgentInput, Id, ResumeInput, StartTaskInput } from '@cdm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AgentManager } from '../agents/manager.ts'
import { parseInput } from '../errors/index.ts'

const Params = z.object({ id: Id })

export function agentRoutes(app: FastifyInstance, manager: AgentManager): void {
  app.post('/agents', async (request, reply) => {
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

  app.delete('/agents/:id', async (request, reply) => {
    const { id } = parseInput(Params, request.params)
    manager.deleteAgent(request.workspaceId, id)
    return reply.status(204).send()
  })

  app.post('/agents/:id/tasks', async (request, reply) => {
    const { id } = parseInput(Params, request.params)
    const input = parseInput(StartTaskInput, request.body)
    const run = manager.startTask(request.workspaceId, id, input)
    return reply.status(202).send({ runId: run.id })
  })

  app.post('/agents/:id/pause', async (request) => {
    const { id } = parseInput(Params, request.params)
    return { agent: await manager.pause(request.workspaceId, id) }
  })

  app.post('/agents/:id/resume', async (request, reply) => {
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
