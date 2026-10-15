import type {
  Agent,
  AgentStatus,
  ModelTier,
  Project,
  RiskLevel,
  RoutingSource,
  Run,
  TaskSize,
} from '@cdm/shared'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { StatsRunRow } from '../router/stats.ts'
import type { Db } from './client.ts'
import { agents, projects, type RunEndReason, type RunRow, runs } from './schema.ts'

const LIVE_STATUSES: AgentStatus[] = ['thinking', 'running_tool']

export interface RunTotals {
  inputTokens: number
  outputTokens: number
  costUsd: number
  contextUsedPct: number
}

/** Gasto de una ejecución de la sesión: costo reportado y presupuesto concedido (internos). */
export interface RunSpend {
  /** `null` si la ejecución no llegó a reportar costo (p. ej. cerrada a la fuerza). */
  costUsd: number | null
  /** `maxBudgetUsd` concedido; `null` en filas anteriores a la migración 4. */
  budgetUsd: number | null
}

/** Decisión del enrutador y cadena de reintentos que se guardan con cada ejecución. */
export interface RunRouting {
  taskSize: TaskSize | null
  risk: RiskLevel | null
  routingSource: RoutingSource | null
  routingReasons: string[]
  retryOfRunId: string | null
  consecutiveFailures: number
}

/** Sin decisión (filas creadas fuera del enrutador). */
export const NO_ROUTING: RunRouting = {
  taskSize: null,
  risk: null,
  routingSource: null,
  routingReasons: [],
  retryOfRunId: null,
  consecutiveFailures: 0,
}

function parseReasons(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string') : []
  } catch {
    return []
  }
}

/**
 * Fila → `Run` de la API (sin los campos internos `workspaceId`, `resumed`, `budgetUsd`,
 * `endReason`).
 */
function toRun(row: RunRow): Run {
  const {
    workspaceId: _ws,
    resumed: _resumed,
    budgetUsd: _budget,
    endReason: _endReason,
    routingReasons,
    ...run
  } = row
  return { ...run, routingReasons: parseReasons(routingReasons) }
}

/**
 * Acceso a datos. Toda lectura/escritura de proyectos y agentes filtra por
 * `workspaceId` (checklist de seguridad, punto 3). Solo consultas Drizzle parametrizadas.
 */
export function createStore(db: Db, now: () => number = Date.now) {
  /**
   * Costo y presupuesto (en orden cronológico) de las ejecuciones de la sesión actual
   * del agente: desde su último inicio no reanudado (incluido) hasta la más reciente.
   */
  function sessionRunSpend(workspaceId: string, agentId: string): RunSpend[] {
    const rows = db
      .select({ costUsd: runs.costUsd, budgetUsd: runs.budgetUsd, resumed: runs.resumed })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.agentId, agentId)))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .all()
    const spend: RunSpend[] = []
    for (const row of rows) {
      spend.push({ costUsd: row.costUsd, budgetUsd: row.budgetUsd })
      if (!row.resumed) break
    }
    return spend.reverse()
  }

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

    setAgentStatus(workspaceId: string, agentId: string, status: AgentStatus): void {
      db.update(agents)
        .set({ status, updatedAt: now() })
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
        .run()
    },

    setAgentSession(workspaceId: string, agentId: string, sdkSessionId: string | null): void {
      db.update(agents)
        .set({ sdkSessionId, updatedAt: now() })
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
        .run()
    },

    createRun(
      workspaceId: string,
      agentId: string,
      prompt: string,
      model: ModelTier,
      resumed = false,
      budgetUsd: number | null = null,
      routing: RunRouting = NO_ROUTING,
    ): Run {
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
        ...routing,
        routingReasons: [...routing.routingReasons],
      }
      db.insert(runs)
        .values({
          ...row,
          workspaceId,
          resumed,
          budgetUsd,
          routingReasons: JSON.stringify(row.routingReasons),
        })
        .run()
      return row
    },

    setRunStatus(workspaceId: string, runId: string, status: AgentStatus, ended: boolean): void {
      db.update(runs)
        .set(ended ? { status, endedAt: now() } : { status })
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
        .run()
    },

    setRunTotals(workspaceId: string, runId: string, totals: RunTotals): void {
      db.update(runs)
        .set(totals)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
        .run()
    },

    /** Marca que la ejecución terminó por tope de turnos o de costo (interno). */
    setRunEndReason(workspaceId: string, runId: string, endReason: RunEndReason): void {
      db.update(runs)
        .set({ endReason })
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
        .run()
    },

    /** Motivo de fin por tope de la ejecución, o `null` (también si no existe en el workspace). */
    runEndReason(workspaceId: string, runId: string): RunEndReason | null {
      const row = db
        .select({ endReason: runs.endReason })
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
        .get()
      return row?.endReason ?? null
    },

    sessionRunSpend,

    /** Solo los `costUsd` de `sessionRunSpend` (`null` si la ejecución no reportó costo). */
    sessionRunCosts(workspaceId: string, agentId: string): Array<number | null> {
      return sessionRunSpend(workspaceId, agentId).map((r) => r.costUsd)
    },

    lastRun(workspaceId: string, agentId: string): Run | undefined {
      const row = db
        .select()
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.agentId, agentId)))
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(1)
        .get()
      return row ? toRun(row) : undefined
    },

    getRun(workspaceId: string, runId: string): Run | undefined {
      const row = db
        .select()
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
        .get()
      return row ? toRun(row) : undefined
    },

    /**
     * Primera ejecución de la sesión actual del agente (su último inicio no reanudado):
     * tiene el prompt original de la tarea, que es el que se reintenta.
     */
    sessionStartRun(workspaceId: string, agentId: string): Run | undefined {
      const row = db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, workspaceId),
            eq(runs.agentId, agentId),
            eq(runs.resumed, false),
          ),
        )
        .orderBy(desc(runs.startedAt), desc(runs.id))
        .limit(1)
        .get()
      return row ? toRun(row) : undefined
    },

    /** Filas para `GET /router/stats`, solo del workspace, por agente y en orden cronológico. */
    routerStatsRows(workspaceId: string): StatsRunRow[] {
      return db
        .select({
          agentId: runs.agentId,
          model: runs.model,
          costUsd: runs.costUsd,
          resumed: runs.resumed,
        })
        .from(runs)
        .where(eq(runs.workspaceId, workspaceId))
        .orderBy(asc(runs.agentId), asc(runs.startedAt), asc(runs.id))
        .all()
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
