import type { Agent, AgentStatus, ModelTier, Project, Run } from '@cdm/shared'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Db } from './client.ts'
import { agents, projects, runs } from './schema.ts'

const LIVE_STATUSES: AgentStatus[] = ['thinking', 'running_tool']

export interface RunTotals {
  inputTokens: number
  outputTokens: number
  costUsd: number
  contextUsedPct: number
}

/**
 * Acceso a datos. Toda lectura/escritura de proyectos y agentes filtra por
 * `workspaceId` (checklist de seguridad, punto 3). Solo consultas Drizzle parametrizadas.
 */
export function createStore(db: Db, now: () => number = Date.now) {
  return {
    createProject(workspaceId: string, name: string, path: string): Project {
      const row = { id: ulid(), workspaceId, name, path, createdAt: now() }
      db.insert(projects).values(row).run()
      return row
    },

    findProjectByPath(workspaceId: string, path: string): Project | undefined {
      return db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.path, path)))
        .get()
    },

    getProject(workspaceId: string, id: string): Project | undefined {
      return db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
        .get()
    },

    listProjects(workspaceId: string): Project[] {
      return db
        .select()
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId))
        .orderBy(projects.createdAt)
        .all()
    },

    createAgent(
      workspaceId: string,
      input: { projectId: string; name: string; role: Agent['role']; defaultModel: ModelTier },
    ): Agent {
      const t = now()
      const row: Agent = {
        id: ulid(),
        workspaceId,
        ...input,
        status: 'idle',
        sdkSessionId: null,
        createdAt: t,
        updatedAt: t,
      }
      db.insert(agents).values(row).run()
      return row
    },

    getAgent(workspaceId: string, id: string): Agent | undefined {
      return db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)))
        .get()
    },

    listAgents(workspaceId: string): Agent[] {
      return db
        .select()
        .from(agents)
        .where(eq(agents.workspaceId, workspaceId))
        .orderBy(agents.createdAt)
        .all()
    },

    deleteAgent(workspaceId: string, id: string): void {
      db.delete(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)))
        .run()
    },

    setAgentStatus(agentId: string, status: AgentStatus): void {
      db.update(agents).set({ status, updatedAt: now() }).where(eq(agents.id, agentId)).run()
    },

    setAgentSession(agentId: string, sdkSessionId: string | null): void {
      db.update(agents).set({ sdkSessionId, updatedAt: now() }).where(eq(agents.id, agentId)).run()
    },

    createRun(workspaceId: string, agentId: string, prompt: string, model: ModelTier): Run {
      const row: Run = {
        id: ulid(),
        agentId,
        prompt,
        model,
        status: 'thinking',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        contextUsedPct: null,
        startedAt: now(),
        endedAt: null,
      }
      db.insert(runs)
        .values({ ...row, workspaceId })
        .run()
      return row
    },

    setRunStatus(runId: string, status: AgentStatus, ended: boolean): void {
      db.update(runs)
        .set(ended ? { status, endedAt: now() } : { status })
        .where(eq(runs.id, runId))
        .run()
    },

    setRunTotals(runId: string, totals: RunTotals): void {
      db.update(runs).set(totals).where(eq(runs.id, runId)).run()
    },

    lastRun(workspaceId: string, agentId: string): Run | undefined {
      const row = db
        .select()
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.agentId, agentId)))
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(1)
        .get()
      if (!row) return undefined
      const { workspaceId: _ws, ...run } = row
      return run
    },

    /** Al arrancar: lo que estaba en curso cuando se cayó el motor queda `interrupted`. */
    markInterrupted(): { agents: number; runs: number } {
      return db.transaction((tx) => {
        const t = now()
        const r = tx
          .update(runs)
          .set({ status: 'interrupted', endedAt: t })
          .where(inArray(runs.status, LIVE_STATUSES))
          .run()
        const a = tx
          .update(agents)
          .set({ status: 'interrupted', updatedAt: t })
          .where(inArray(agents.status, LIVE_STATUSES))
          .run()
        return { agents: a.changes, runs: r.changes }
      })
    },
  }
}

export type Store = ReturnType<typeof createStore>
