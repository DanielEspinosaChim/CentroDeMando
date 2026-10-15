import { z } from 'zod'
import { RiskLevel, RoutingSource, TaskSize } from './routing.ts'

export const AgentRole = z.enum([
  'coordinador',
  'planeador',
  'implementador',
  'qa',
  'seguridad',
  'disenador',
  'documentador',
])
export type AgentRole = z.infer<typeof AgentRole>

export const ModelTier = z.enum(['haiku', 'sonnet', 'opus'])
export type ModelTier = z.infer<typeof ModelTier>

export const AgentStatus = z.enum([
  'idle',
  'thinking',
  'running_tool',
  'paused',
  'stopped',
  'done',
  'error',
  'interrupted',
])
export type AgentStatus = z.infer<typeof AgentStatus>

/** Estados en los que el agente tiene una ejecución viva. */
export const ACTIVE_STATUSES: readonly AgentStatus[] = ['thinking', 'running_tool']

/** Modelo por defecto según el rol (CLAUDE.md: arquitectura → opus, normal → sonnet, trivial → haiku). */
export const DEFAULT_MODEL_BY_ROLE: Record<AgentRole, ModelTier> = {
  coordinador: 'opus',
  planeador: 'opus',
  implementador: 'sonnet',
  qa: 'sonnet',
  seguridad: 'opus',
  disenador: 'sonnet',
  documentador: 'haiku',
}

export const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'id inválido')

export const CreateAgentInput = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: AgentRole,
  projectId: Id,
  defaultModel: ModelTier.optional(),
})
export type CreateAgentInput = z.infer<typeof CreateAgentInput>

export const MAX_PROMPT_LENGTH = 20_000

export const StartTaskInput = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  model: ModelTier.optional(),
})
export type StartTaskInput = z.infer<typeof StartTaskInput>

export const ResumeInput = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).optional(),
})
export type ResumeInput = z.infer<typeof ResumeInput>

export const Agent = z.object({
  id: Id,
  workspaceId: z.string(),
  projectId: Id,
  name: z.string(),
  role: AgentRole,
  defaultModel: ModelTier,
  status: AgentStatus,
  sdkSessionId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Agent = z.infer<typeof Agent>

export const Run = z.object({
  id: Id,
  agentId: Id,
  prompt: z.string(),
  model: ModelTier,
  status: AgentStatus,
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costUsd: z.number().nullable(),
  contextUsedPct: z.number().min(0).max(100).nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  /** Decisión del enrutador (feature 003); `null` en ejecuciones previas a la migración 5. */
  taskSize: TaskSize.nullable(),
  risk: RiskLevel.nullable(),
  routingSource: RoutingSource.nullable(),
  routingReasons: z.array(z.string()),
  /** Ejecución fallida de la que esta es reintento (`null` si no es un reintento). */
  retryOfRunId: Id.nullable(),
  /** Fallos seguidos de la cadena de reintentos antes de esta ejecución (0 en una tarea nueva). */
  consecutiveFailures: z.number().int().nonnegative(),
})
export type Run = z.infer<typeof Run>
