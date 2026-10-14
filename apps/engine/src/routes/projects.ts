import { CreateProjectInput } from '@cdm/shared'
import type { FastifyInstance } from 'fastify'
import type { Store } from '../db/store.ts'
import { ConflictError, parseInput } from '../errors/index.ts'
import { resolveProjectPath } from '../projects/paths.ts'

export function projectRoutes(app: FastifyInstance, store: Store, dataDir: string): void {
  app.post('/projects', async (request, reply) => {
    const input = parseInput(CreateProjectInput, request.body)
    const realPath = resolveProjectPath(input.path, { dataDir })
    if (store.findProjectByPath(request.workspaceId, realPath)) {
      throw new ConflictError('Ese proyecto ya está registrado')
    }
    const project = store.createProject(request.workspaceId, input.name, realPath)
    return reply.status(201).send({ project })
  })

  app.get('/projects', async (request) => {
    return { projects: store.listProjects(request.workspaceId) }
  })
}
