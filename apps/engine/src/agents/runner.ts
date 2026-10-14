import type { AgentRole, ModelTier } from '@cdm/shared'

/**
 * Eventos que emite un runner, ya independientes del SDK. El `AgentManager`
 * los convierte en `EngineEvent` y en cambios de estado.
 */
export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'output'; text: string }
  | { type: 'tool'; tool: string; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string }
  /** La ejecución terminó por tope de turnos o de costo (llega tras `usage`). */
  | { type: 'limit'; limit: 'turns' | 'budget' }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      costUsd: number
      contextUsedPct: number
    }

export interface RunOptions {
  prompt: string
  model: ModelTier
  role: AgentRole
  /** Ya validado dentro de un proyecto registrado. */
  cwd: string
  /** `sdkSessionId` a continuar, si es una reanudación. */
  resume?: string
  maxTurns: number
  /** Tope de costo estimado por tarea, en USD. */
  maxBudgetUsd: number
  signal: AbortSignal
}

export interface RunHandle {
  /** Termina normalmente al acabar la tarea; lanza si la ejecución falla. */
  events: AsyncIterable<RunnerEvent>
  /** Detiene el turno en curso conservando la sesión (pausa). */
  interrupt(): Promise<void>
  /** Libera el proceso subyacente. */
  close(): void
}

/** Único punto de contacto con el Claude Agent SDK (ver CLAUDE.md). */
export interface AgentRunner {
  run(options: RunOptions): RunHandle
}

export type UsageEvent = Extract<RunnerEvent, { type: 'usage' }>

/**
 * Fallo de una ejecución. `message` es interno: va al log, nunca al cliente.
 * `usage` trae el costo que el SDK reportó en el `result` de error (p. ej. tras una
 * pausa), para que cuente en el tope de costo de la sesión.
 */
export class RunnerError extends Error {
  override name = 'RunnerError'

  constructor(
    message: string,
    readonly usage?: UsageEvent,
  ) {
    super(message)
  }
}
