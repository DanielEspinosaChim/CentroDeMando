import type { AgentRole, AgentStatus, ModelTier } from '@cdm/shared'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
  },
  (t) => [index('runs_agent_idx').on(t.agentId), index('runs_workspace_idx').on(t.workspaceId)],
)

export type ProjectRow = typeof projects.$inferSelect
export type AgentRow = typeof agents.$inferSelect
export type RunRow = typeof runs.$inferSelect
