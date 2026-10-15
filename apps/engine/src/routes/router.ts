import { RouterConfig } from '@cdm/shared'
import type { FastifyInstance } from 'fastify'
import type { Store } from '../db/store.ts'
import { parseInput } from '../errors/index.ts'
import type { RouterConfigStore } from '../router/config-store.ts'
import { aggregateRouterStats } from '../router/stats.ts'
import type { RateLimits } from '../security/rate-limit.ts'

/**
 * Configuración y estadísticas del enrutador de modelos (feature 003). Pasan por las
 * guardas globales (token, `Origin`, `Host`); el PUT usa el límite de escrituras y los GET
 * no se limitan. La configuración es una sola por motor (Fase 1: un workspace local); las
 * estadísticas se filtran por `workspaceId`.
 */
export function routerRoutes(
  app: FastifyInstance,
  deps: { store: Store; routerConfig: RouterConfigStore },
  limits: RateLimits,
): void {
  app.get('/router/config', async () => {
    return { config: deps.routerConfig.get() }
  })

  app.put('/router/config', { onRequest: limits.writes }, async (request) => {
    const input = parseInput(RouterConfig, request.body)
    return { config: deps.routerConfig.set(input) }
  })

  app.get('/router/stats', async (request) => {
    return { stats: aggregateRouterStats(deps.store.routerStatsRows(request.workspaceId)) }
  })
}
