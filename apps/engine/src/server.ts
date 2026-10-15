import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { AgentManager } from './agents/manager.ts'
import type { AgentRunner } from './agents/runner.ts'
import { MessageBus } from './bus/bus.ts'
import type { EngineConfig } from './config.ts'
import type { Store } from './db/store.ts'
import { registerErrorHandler } from './errors/index.ts'
import { EventHub } from './events/hub.ts'
import { createRouterConfigStore, type RouterConfigStore } from './router/config-store.ts'
import { agentRoutes } from './routes/agents.ts'
import { messageRoutes } from './routes/messages.ts'
import { projectRoutes } from './routes/projects.ts'
import { routerRoutes } from './routes/router.ts'
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
  /** Configuración del enrutador. Por defecto, `router-config.json` en `config.dataDir`. */
  routerConfig?: RouterConfigStore
}

export interface Engine {
  app: FastifyInstance
  manager: AgentManager
  hub: EventHub
  routerConfig: RouterConfigStore
  bus: MessageBus
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
  const routerConfig =
    opts.routerConfig ??
    createRouterConfigStore(opts.config.dataDir, { onWarning: (message) => app.log.warn(message) })
  const bus = new MessageBus({ store: opts.store, hub })
  const manager = new AgentManager({
    store: opts.store,
    runner: opts.runner,
    hub,
    config: opts.config,
    logger: app.log,
    secrets: [opts.token],
    routerConfig,
    bus,
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
  routerRoutes(app, { store: opts.store, routerConfig }, limits)
  messageRoutes(app, bus, limits)
  wsRoutes(app, hub, opts.token)

  app.addHook('onClose', async () => {
    await manager.shutdown()
  })

  return { app, manager, hub, routerConfig, bus }
}
