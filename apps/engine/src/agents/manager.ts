import {
  type Agent,
  type AgentStatus,
  type CreateAgentInput,
  DEFAULT_MODEL_BY_ROLE,
  type EngineEvent,
  type ModelTier,
  type ResumeInput,
  type Run,
  type StartTaskInput,
} from '@cdm/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { EngineConfig } from '../config.ts'
import type { RunSpend, RunTotals, Store } from '../db/store.ts'
import { ConflictError, LimitError, NotFoundError, ValidationError } from '../errors/index.ts'
import type { EventHub } from '../events/hub.ts'
import { assertCwdInProject, revalidateProjectPath } from '../projects/paths.ts'
import {
  type AgentRunner,
  type RunHandle,
  RunnerError,
  type RunnerEvent,
  type UsageEvent,
} from './runner.ts'

/** Transiciones permitidas de la máquina de estados del agente. */
const TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  idle: ['thinking'],
  thinking: ['running_tool', 'paused', 'stopped', 'done', 'error'],
  running_tool: ['thinking', 'paused', 'stopped', 'done', 'error'],
  paused: ['thinking', 'stopped'],
  stopped: ['thinking'],
  done: ['thinking'],
  error: ['thinking'],
  interrupted: ['thinking'],
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export const GENERIC_RUN_ERROR = 'La ejecución del agente falló. Revisa el log local del motor.'
export const DEFAULT_RESUME_PROMPT = 'Continúa con la tarea donde la dejaste.'
export const LIMIT_MESSAGES = {
  turns: 'La tarea alcanzó el tope de turnos y se detuvo.',
  budget: 'La tarea alcanzó el tope de costo y se detuvo.',
} as const
export const BUDGET_EXHAUSTED_MESSAGE =
  'La sesión ya agotó el tope de costo por tarea; inicia una tarea nueva para continuar.'
/** Tiempo máximo que pausa/stop esperan a que el proceso del SDK termine; luego se fuerza el cierre. */
const DRAIN_TIMEOUT_MS = 5000
/** Tope por defecto de `idle()`: nunca se espera indefinidamente a los consumidores. */
const IDLE_TIMEOUT_MS = 10_000
/** Tope de `idle()` durante el apagado, tras forzar el cierre de todo (Ctrl+C no se cuelga). */
const SHUTDOWN_IDLE_TIMEOUT_MS = 3000
/**
 * Saldo mínimo para reanudar. El SDK revisa el tope al final de cada turno, así que con
 * un saldo de centavos la reanudación solo serviría para pasarse del tope un turno más.
 */
const MIN_RESUME_BUDGET_USD = 0.01

/**
 * Gasto (USD) de una sesión a partir de cada ejecución (orden cronológico, desde el
 * último inicio no reanudado). Cada entrada es el `costUsd` reportado (número o `null`)
 * o un `RunSpend` con el costo y el presupuesto concedido a esa ejecución.
 *
 * Decisión (ver `sdk.d.ts`, `total_cost_usd` y `maxBudgetUsd`): el SDK documenta que una
 * sesión reanudada "continúa desde el total que guardó su transcript, cuando lo tiene",
 * es decir, el `total_cost_usd` de una reanudación ya incluye lo gastado antes, mientras
 * que `maxBudgetUsd` cuenta solo lo gastado desde esa llamada a `query()`. Sumar los
 * costos tal cual contaría doble. Por eso cada costo se trata como acumulado de la
 * sesión: se suma solo lo que crece respecto al último reportado. Si un costo baja
 * (el transcript no tenía total y el contador empezó de cero), esa ejecución se suma
 * entera.
 *
 * Ejecuciones sin costo (`null`: cerradas antes de su `result`, p. ej. porque venció la
 * espera de drenado y se forzó el cierre): su gasto no es medible, así que se cuenta el
 * presupuesto completo que se les concedió (dirección segura: el SDK no las dejó gastar
 * más). No se toca `lastReported`: si el costo acumulado de la siguiente ejecución ya
 * incluye ese gasto, el incremento se cuenta además del presupuesto, lo que sobrestima
 * (nunca subestima) lo gastado. Un `null` sin presupuesto conocido (número suelto o fila
 * previa a la migración 4 sin que el llamador lo rellene) no aporta.
 */
export function sessionSpentUsd(runs: ReadonlyArray<number | null | RunSpend>): number {
  let spent = 0
  let lastReported = 0
  for (const entry of runs) {
    const cost = typeof entry === 'object' && entry !== null ? entry.costUsd : entry
    if (cost === null) {
      const budget = typeof entry === 'object' && entry !== null ? entry.budgetUsd : null
      if (budget !== null && Number.isFinite(budget) && budget > 0) spent += budget
      continue
    }
    if (!Number.isFinite(cost) || cost < 0) continue
    spent += cost >= lastReported ? cost - lastReported : cost
    lastReported = cost
  }
  return spent
}

type EndReason = 'paused' | 'stopped'

interface LiveRun {
  workspaceId: string
  agentId: string
  run: Run
  handle: RunHandle
  abort: AbortController
  status: AgentStatus
  /** Si está puesto, la ejecución terminó por orden del usuario y se descartan eventos tardíos. */
  ended?: EndReason
  /** Tope de turnos o de costo alcanzado (checklist de seguridad, punto D). */
  limitHit?: 'turns' | 'budget'
  /** Se resuelve cuando el consumidor de eventos terminó y el proceso se cerró. */
  drained?: Promise<void>
}

export interface AgentManagerDeps {
  store: Store
  runner: AgentRunner
  hub: EventHub
  /** `dataDir` hace falta para revalidar el proyecto al lanzar (mismas reglas que al registrar). */
  config: Pick<EngineConfig, 'maxConcurrentAgents' | 'maxTurns' | 'maxCostUsdPerTask' | 'dataDir'>
  logger: FastifyBaseLogger
  /** Textos a ocultar si aparecen en mensajes que van al log (p. ej. el token local). */
  secrets?: readonly string[]
}

export class AgentManager {
  private readonly live = new Map<string, LiveRun>()
  /** Ejecuciones pausadas/detenidas cuyo proceso aún no terminó: siguen ocupando hueco. */
  private readonly draining = new Map<string, LiveRun>()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly deps: AgentManagerDeps) {}

  // --- CRUD -----------------------------------------------------------------

  createAgent(workspaceId: string, input: CreateAgentInput): Agent {
    const project = this.deps.store.getProject(workspaceId, input.projectId)
    if (!project) throw new ValidationError('projectId: el proyecto no existe')
    return this.deps.store.createAgent(workspaceId, {
      projectId: project.id,
      name: input.name,
      role: input.role,
      defaultModel: input.defaultModel ?? DEFAULT_MODEL_BY_ROLE[input.role],
    })
  }

  listAgents(workspaceId: string): Agent[] {
    return this.deps.store.listAgents(workspaceId)
  }

  getAgent(workspaceId: string, agentId: string): { agent: Agent; lastRun: Run | null } {
    const agent = this.requireAgent(workspaceId, agentId)
    return { agent, lastRun: this.deps.store.lastRun(workspaceId, agent.id) ?? null }
  }

  deleteAgent(workspaceId: string, agentId: string): void {
    const agent = this.requireAgent(workspaceId, agentId)
    if (this.live.has(agent.id) || this.draining.has(agent.id)) {
      throw new ConflictError('El agente está ejecutando una tarea')
    }
    this.deps.store.deleteAgent(workspaceId, agent.id)
  }

  // --- Ciclo de vida ----------------------------------------------------------

  startTask(workspaceId: string, agentId: string, input: StartTaskInput): Run {
    const agent = this.requireAgent(workspaceId, agentId)
    this.assertCanLaunch(agent)
    return this.launch(
      workspaceId,
      agent,
      input.prompt,
      input.model ?? agent.defaultModel,
      this.deps.config.maxCostUsdPerTask,
    )
  }

  async pause(workspaceId: string, agentId: string): Promise<Agent> {
    const agent = this.requireAgent(workspaceId, agentId)
    const live = this.live.get(agent.id)
    if (!live || live.ended) throw new ConflictError('El agente no está ejecutando una tarea')
    live.ended = 'paused'
    this.finish(live, 'paused')
    try {
      await live.handle.interrupt()
    } catch (err) {
      this.logError(live, 'fallo al interrumpir', err)
    }
    await this.waitDrained(live)
    return this.requireAgent(workspaceId, agentId)
  }

  resume(workspaceId: string, agentId: string, input: ResumeInput): Run {
    const agent = this.requireAgent(workspaceId, agentId)
    if (agent.status !== 'paused') throw new ConflictError('El agente no está en pausa')
    if (!agent.sdkSessionId) throw new ConflictError('No hay sesión guardada para reanudar')
    // Tras `assertCanLaunch` no queda nada drenando: los costos de la sesión ya son finales.
    this.assertCanLaunch(agent)
    // El tope de costo es por tarea (toda la sesión), no por `query()`: pausar/reanudar
    // N veces no puede dar N topes. Sin saldo se responde 409 (ConflictError) y no 429
    // (LimitError): no es un límite temporal que se libere esperando, sino el estado de
    // esta sesión; reintentar no sirve y la salida es iniciar una tarea nueva.
    // Una ejecución sin presupuesto guardado (fila previa a la migración 4) se acota con el
    // tope por tarea: nunca se le concedió más que eso.
    const runs = this.deps.store
      .sessionRunSpend(workspaceId, agent.id)
      .map((r) => ({ ...r, budgetUsd: r.budgetUsd ?? this.deps.config.maxCostUsdPerTask }))
    const spent = sessionSpentUsd(runs)
    const remaining = this.deps.config.maxCostUsdPerTask - spent
    if (remaining < MIN_RESUME_BUDGET_USD) throw new ConflictError(BUDGET_EXHAUSTED_MESSAGE)
    const model = this.deps.store.lastRun(workspaceId, agent.id)?.model ?? agent.defaultModel
    return this.launch(
      workspaceId,
      agent,
      input.prompt ?? DEFAULT_RESUME_PROMPT,
      model,
      remaining,
      agent.sdkSessionId,
    )
  }

  async stop(workspaceId: string, agentId: string): Promise<Agent> {
    const agent = this.requireAgent(workspaceId, agentId)
    const live = this.live.get(agent.id)
    if (live && !live.ended) {
      live.ended = 'stopped'
      this.finish(live, 'stopped')
      live.abort.abort()
      try {
        await live.handle.interrupt()
      } catch (err) {
        this.logError(live, 'fallo al interrumpir', err)
      }
      live.handle.close()
      await this.waitDrained(live)
    } else if (agent.status === 'paused') {
      // La ejecución pausada puede seguir drenando (el proceso no terminó tras interrumpir):
      // detener debe cerrarla de verdad, no solo cambiar el estado.
      const draining = this.draining.get(agent.id)
      if (draining) {
        draining.ended = 'stopped'
        draining.status = 'stopped'
        this.forceClose(draining)
      }
      this.deps.store.setAgentStatus(workspaceId, agent.id, 'stopped')
      const lastRun = this.deps.store.lastRun(workspaceId, agent.id)
      // La ejecución pausada pasa a `stopped` igual que el agente (filtrando por workspace).
      // Si aún drenaba, termina ahora (nuevo `endedAt`); si ya había drenado, conserva el
      // `endedAt` de la pausa.
      if (lastRun?.status === 'paused') {
        this.deps.store.setRunStatus(workspaceId, lastRun.id, 'stopped', Boolean(draining))
      }
      if (lastRun) this.emit(workspaceId, statusEvent(agent.id, lastRun.id, 'stopped'))
      if (draining) await this.waitDrained(draining)
    } else {
      throw new ConflictError('El agente no está ejecutando ni en pausa')
    }
    return this.requireAgent(workspaceId, agentId)
  }

  /** Ejecuciones que ocupan hueco de concurrencia (vivas + terminando). */
  activeCount(): number {
    return this.live.size + this.draining.size
  }

  /**
   * Espera a que terminen los consumidores de eventos (tests y apagado), como mucho
   * `timeoutMs`. Devuelve `false` si venció el tope con consumidores pendientes.
   */
  async idle(timeoutMs = IDLE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.pending.size > 0) {
      const left = deadline - Date.now()
      if (left <= 0) return false
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left)
        }),
      ])
      clearTimeout(timer)
    }
    return true
  }

  /**
   * Apagado: detiene en paralelo lo que esté corriendo, fuerza el cierre de lo que siga
   * drenando (pausas incluidas) y espera con tope para que Ctrl+C no se cuelgue.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.live.values()]
        .filter((live) => !live.ended)
        .map((live) => this.stop(live.workspaceId, live.agentId)),
    )
    for (const live of [...this.draining.values()]) this.forceClose(live)
    if (!(await this.idle(SHUTDOWN_IDLE_TIMEOUT_MS))) {
      this.deps.logger.warn(
        { pending: this.pending.size },
        'apagado: quedaron ejecuciones sin terminar tras forzar su cierre',
      )
    }
  }

  // --- Interno ----------------------------------------------------------------

  private requireAgent(workspaceId: string, agentId: string): Agent {
    const agent = this.deps.store.getAgent(workspaceId, agentId)
    if (!agent) throw new NotFoundError('Agente no encontrado')
    return agent
  }

  private assertCanLaunch(agent: Agent): void {
    if (this.live.has(agent.id)) throw new ConflictError('El agente ya está ejecutando una tarea')
    if (this.draining.has(agent.id)) {
      throw new ConflictError('La ejecución anterior aún se está cerrando; reintenta en un momento')
    }
    if (this.activeCount() >= this.deps.config.maxConcurrentAgents) {
      throw new LimitError(
        `Límite de ${this.deps.config.maxConcurrentAgents} agentes simultáneos alcanzado`,
      )
    }
  }

  private launch(
    workspaceId: string,
    agent: Agent,
    prompt: string,
    model: ModelTier,
    maxBudgetUsd: number,
    resume?: string,
  ): Run {
    const project = this.deps.store.getProject(workspaceId, agent.projectId)
    if (!project) throw new ValidationError('projectId: el proyecto no existe')
    // Un proyecto guardado antes de endurecer las reglas no se usa sin revalidarlo.
    const projectPath = revalidateProjectPath(project.path, { dataDir: this.deps.config.dataDir })
    const cwd = assertCwdInProject(projectPath)

    // Se guarda el presupuesto concedido: si la ejecución termina sin `result` (costo nulo),
    // al reanudar se descuenta entero (ver `sessionSpentUsd`).
    const run = this.deps.store.createRun(
      workspaceId,
      agent.id,
      prompt,
      model,
      Boolean(resume),
      maxBudgetUsd,
    )
    if (!resume) this.deps.store.setAgentSession(workspaceId, agent.id, null)
    this.deps.store.setAgentStatus(workspaceId, agent.id, 'thinking')

    const abort = new AbortController()
    const handle = this.deps.runner.run({
      prompt,
      model,
      role: agent.role,
      cwd,
      maxTurns: this.deps.config.maxTurns,
      maxBudgetUsd,
      signal: abort.signal,
      ...(resume ? { resume } : {}),
    })
    const live: LiveRun = { workspaceId, agentId: agent.id, run, handle, abort, status: 'thinking' }
    this.live.set(agent.id, live)
    this.emit(workspaceId, statusEvent(agent.id, run.id, 'thinking'))

    const p = this.consume(live).finally(() => this.pending.delete(p))
    live.drained = p
    this.pending.add(p)
    return run
  }

  private async consume(live: LiveRun): Promise<void> {
    try {
      for await (const ev of live.handle.events) {
        if (live.ended) {
          // Tras pausa/stop se descartan los eventos tardíos, salvo el costo: se guarda
          // (sin emitir) para que el tope de la sesión cuente lo gastado al reanudar.
          if (ev.type === 'usage') this.saveTotals(live, ev)
          continue
        }
        this.onRunnerEvent(live, ev)
      }
      if (live.ended) return
      if (live.limitHit) {
        this.finish(live, 'error')
        this.emitError(live, LIMIT_MESSAGES[live.limitHit])
      } else {
        this.finish(live, 'done')
      }
    } catch (err) {
      // El `result` de error (p. ej. tras interrumpir) también trae costo.
      if (err instanceof RunnerError && err.usage) {
        if (live.ended) this.saveTotals(live, err.usage)
        else this.onRunnerEvent(live, err.usage)
      }
      if (live.ended) return
      this.logError(live, 'la ejecución falló', err)
      this.finish(live, 'error')
      this.emitError(live, GENERIC_RUN_ERROR)
    } finally {
      if (this.live.get(live.agentId) === live) this.live.delete(live.agentId)
      if (this.draining.get(live.agentId) === live) this.draining.delete(live.agentId)
      // La sesión del SDK queda en disco: cerrar el proceso no impide reanudarla.
      live.handle.close()
    }
  }

  private onRunnerEvent(live: LiveRun, ev: RunnerEvent): void {
    const base = { agentId: live.agentId, runId: live.run.id, at: Date.now() }
    switch (ev.type) {
      case 'session':
        this.deps.store.setAgentSession(live.workspaceId, live.agentId, ev.sessionId)
        return
      case 'output':
        if (live.status === 'running_tool') this.setLiveStatus(live, 'thinking')
        this.emit(live.workspaceId, { type: 'agent.output', ...base, text: ev.text })
        return
      case 'tool':
        this.setLiveStatus(live, 'running_tool')
        this.emit(live.workspaceId, {
          type: 'agent.tool',
          ...base,
          tool: ev.tool,
          toolUseId: ev.toolUseId,
        })
        return
      case 'tool_result':
        this.setLiveStatus(live, 'thinking')
        return
      case 'limit':
        live.limitHit = ev.limit
        return
      case 'usage': {
        const totals = this.saveTotals(live, ev)
        this.emit(live.workspaceId, { type: 'agent.usage', ...base, ...totals })
        return
      }
    }
  }

  private saveTotals(live: LiveRun, ev: UsageEvent): RunTotals {
    const totals = {
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      costUsd: ev.costUsd,
      contextUsedPct: Math.min(100, Math.max(0, ev.contextUsedPct)),
    }
    this.deps.store.setRunTotals(live.workspaceId, live.run.id, totals)
    return totals
  }

  private setLiveStatus(live: LiveRun, status: AgentStatus): void {
    if (live.status === status || !canTransition(live.status, status)) return
    live.status = status
    this.deps.store.setAgentStatus(live.workspaceId, live.agentId, status)
    this.deps.store.setRunStatus(live.workspaceId, live.run.id, status, false)
    this.emit(live.workspaceId, statusEvent(live.agentId, live.run.id, status))
  }

  /** Estado final de la ejecución: persiste y emite `agent.status`. */
  private finish(live: LiveRun, status: AgentStatus): void {
    if (!canTransition(live.status, status)) return
    live.status = status
    this.deps.store.setAgentStatus(live.workspaceId, live.agentId, status)
    this.deps.store.setRunStatus(live.workspaceId, live.run.id, status, true)
    if ((status === 'paused' || status === 'stopped') && this.live.get(live.agentId) === live) {
      this.live.delete(live.agentId)
      this.draining.set(live.agentId, live)
    }
    this.emit(live.workspaceId, statusEvent(live.agentId, live.run.id, status))
  }

  /** Espera a que la ejecución drene; si vence el tope, aborta y cierra el proceso. */
  private async waitDrained(live: LiveRun): Promise<void> {
    if (!live.drained) return
    let timer: NodeJS.Timeout | undefined
    const timedOut = await Promise.race([
      live.drained.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), DRAIN_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    if (timedOut) this.forceClose(live)
  }

  /** Aborta y cierra el proceso del SDK. La sesión queda en disco: se puede reanudar. */
  private forceClose(live: LiveRun): void {
    live.abort.abort()
    try {
      live.handle.close()
    } catch (err) {
      this.logError(live, 'fallo al cerrar el proceso', err)
    }
  }

  private emitError(live: LiveRun, message: string): void {
    this.emit(live.workspaceId, {
      type: 'agent.error',
      agentId: live.agentId,
      runId: live.run.id,
      at: Date.now(),
      message,
    })
  }

  private emit(workspaceId: string, event: EngineEvent): void {
    this.deps.hub.publish(workspaceId, event)
  }

  private logError(live: LiveRun, msg: string, err: unknown): void {
    let detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    for (const secret of this.deps.secrets ?? []) {
      if (secret) detail = detail.split(secret).join('[oculto]')
    }
    this.deps.logger.error({ agentId: live.agentId, runId: live.run.id, detail }, msg)
  }
}

function statusEvent(agentId: string, runId: string, status: AgentStatus): EngineEvent {
  return { type: 'agent.status', agentId, runId, at: Date.now(), status }
}
