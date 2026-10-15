import { z } from 'zod'
import { AgentStatus, Id } from './agent.ts'
import { RoutingDecision } from './router.ts'

const base = { agentId: Id, runId: Id, at: z.number().int() }

export const AgentStatusEvent = z.object({
  type: z.literal('agent.status'),
  ...base,
  status: AgentStatus,
})

export const AgentOutputEvent = z.object({
  type: z.literal('agent.output'),
  ...base,
  text: z.string(),
})

export const AgentToolEvent = z.object({
  type: z.literal('agent.tool'),
  ...base,
  tool: z.string(),
  toolUseId: z.string(),
})

export const AgentUsageEvent = z.object({
  type: z.literal('agent.usage'),
  ...base,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  contextUsedPct: z.number().min(0).max(100),
})

export const AgentErrorEvent = z.object({
  type: z.literal('agent.error'),
  ...base,
  message: z.string(),
})

/** Decisión del enrutador para una ejecución nueva o un reintento (no en reanudaciones). */
export const RouterDecisionEvent = z.object({
  type: z.literal('router.decision'),
  ...base,
  decision: RoutingDecision,
  retryOfRunId: Id.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
})

/** Aviso del enrutador (p. ej. un modelo explícito por debajo del piso de riesgo). */
export const RouterWarningEvent = z.object({
  type: z.literal('router.warning'),
  ...base,
  message: z.string(),
})

export const EngineEvent = z.discriminatedUnion('type', [
  AgentStatusEvent,
  AgentOutputEvent,
  AgentToolEvent,
  AgentUsageEvent,
  AgentErrorEvent,
  RouterDecisionEvent,
  RouterWarningEvent,
])
export type EngineEvent = z.infer<typeof EngineEvent>
export type EngineEventType = EngineEvent['type']
