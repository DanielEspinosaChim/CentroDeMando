import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { AgentManager } from './agents/manager.ts'
import type { AgentRunner } from './agents/runner.ts'
import type { EngineConfig } from './config.ts'
import type { Store } from './db/store.ts'
import { registerErrorHandler } from './errors/index.ts'
import { EventHub } from './events/hub.ts'
import { agentRoutes } from './routes/agents.ts'
import { projectRoutes } from './routes/projects.ts'
import { wsRoutes } from './routes/ws.ts'
import { registerGuards } from './security/guards.ts'
import { createRateLimits } from './security/rate-limit.ts'

export interface BuildServerOptions {
  config: EngineConfig
  store: Store
  runner: AgentRunner
  token: string
  /** Destino del log (tests). Por defecto, stdout. */
  logStream?: NodeJS.WritableStream
  logLevel?: string
  /** Reloj del rate limit en ms (tests). Por defecto, `Date.now`. */
  now?: () => number
}

export interface Engine {
  app: FastifyInstance
  manager: AgentManager
  hub: EventHub
}

export const BODY_LIMIT_BYTES = 128 * 1024

/** Arma la app con el runner inyectado (SDK real en producción, `FakeAgentRunner` en tests). */
export async function buildServer(opts: BuildServerOptions): Promise<Engine> {
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: {
      level: opts.logLevel ?? 'info',
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      redact: {
        paths: ['req.headers.authorization', 'req.headers["sec-websocket-protocol"]'],
        censor: '[oculto]',
      },
    },
  })
  const hub = new EventHub()
  const manager = new AgentManager({
    store: opts.store,
    runner: opts.runner,
    hub,
    config: opts.config,
    logger: app.log,
    secrets: [opts.token],
  })

  registerErrorHandler(app)
  registerGuards(app, {
    token: opts.token,
    allowedOrigins: opts.config.allowedOrigins,
    workspaceId: opts.config.workspaceId,
  })
  await app.register(websocket, {
    options: {
      maxPayload: 4096,
      // Se devuelve el subprotocolo pedido para que el cierre 4401 llegue al cliente.
      handleProtocols: (protocols) => protocols.values().next().value ?? false,
    },
  })

  const limits = createRateLimits({
    writesPerWindow: opts.config.rateLimitWritesPerMin,
    agentActionsPerWindow: opts.config.rateLimitAgentActionsPerMin,
    now: opts.now,
  })

  app.get('/health', async () => ({ ok: true }))
  projectRoutes(app, opts.store, opts.config.dataDir, limits)
  agentRoutes(app, manager, limits)
  wsRoutes(app, hub, opts.token)

  app.addHook('onClose', async () => {
    await manager.shutdown()
  })

  return { app, manager, hub }
}
