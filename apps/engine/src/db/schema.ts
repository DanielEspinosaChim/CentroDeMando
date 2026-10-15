import type {
  AgentRole,
  AgentStatus,
  ModelTier,
  RiskLevel,
  RoutingSource,
  TaskSize,
} from '@cdm/shared'
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** Motivo de fin que se guarda en `runs.end_reason` (solo los topes). */
export type RunEndReason = 'limit_turns' | 'limit_budget'

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().default('local'),
    name: text('name').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('projects_workspace_idx').on(t.workspaceId),
    uniqueIndex('projects_workspace_path_uq').on(t.workspaceId, t.path),
  ],
)

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    role: text('role').$type<AgentRole>().notNull(),
    defaultModel: text('default_model').$type<ModelTier>().notNull(),
    status: text('status').$type<AgentStatus>().notNull(),
    sdkSessionId: text('sdk_session_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('agents_workspace_idx').on(t.workspaceId)],
)

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().default('local'),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    model: text('model').$type<ModelTier>().notNull(),
    status: text('status').$type<AgentStatus>().notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    contextUsedPct: real('context_used_pct'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    /** Interno (no sale en la API): la ejecución reanudó la sesión de la anterior. */
    resumed: integer('resumed', { mode: 'boolean' }).notNull().default(false),
    /** Interno (no sale en la API): `maxBudgetUsd` concedido a la ejecución; NULL en filas previas. */
    budgetUsd: real('budget_usd'),
    /** Decisión del enrutador (migración 5); NULL en filas previas. */
    taskSize: text('task_size').$type<TaskSize>(),
    risk: text('risk').$type<RiskLevel>(),
    routingSource: text('routing_source').$type<RoutingSource>(),
    /** JSON: arreglo de razones legibles. */
    routingReasons: text('routing_reasons'),
    retryOfRunId: text('retry_of_run_id').references((): AnySQLiteColumn => runs.id, {
      onDelete: 'set null',
    }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * Interno (no sale en la API, migración 6): la ejecución terminó por tope de turnos o de
     * costo. NULL si terminó de otra forma o en filas previas.
     */
    endReason: text('end_reason').$type<RunEndReason>(),
  },
  (t) => [index('runs_agent_idx').on(t.agentId), index('runs_workspace_idx').on(t.workspaceId)],
)

export type ProjectRow = typeof projects.$inferSelect
export type AgentRow = typeof agents.$inferSelect
export type RunRow = typeof runs.$inferSelect
