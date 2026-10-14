import {
  type AgentRunner,
  type RunHandle,
  RunnerError,
  type RunnerEvent,
  type RunOptions,
} from './runner.ts'

/**
 * Paso de un guion de `FakeAgentRunner`:
 * - un `RunnerEvent` se emite tal cual;
 * - `wait` espera `ms` milisegundos;
 * - `hold` se queda esperando hasta `release()`, `interrupt()` o `close()`;
 * - `fail` hace fallar la ejecución con ese mensaje interno.
 */
export type FakeStep =
  | RunnerEvent
  | { type: 'wait'; ms: number }
  | { type: 'hold' }
  | { type: 'fail'; message: string }

export type FakeScript = FakeStep[] | ((options: RunOptions, callIndex: number) => FakeStep[])

export const DEFAULT_FAKE_SCRIPT: FakeStep[] = [
  { type: 'session', sessionId: 'fake-session-1' },
  { type: 'output', text: 'Hola desde FakeAgentRunner' },
  { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.001, contextUsedPct: 1 },
]

interface FakeRun {
  options: RunOptions
  interrupted: boolean
  closed: boolean
  /** Eventos que el runner llegó a entregar. */
  emitted: RunnerEvent[]
  release(): void
}

/** Runner programable para tests: nunca llama al SDK ni gasta tokens. */
export class FakeAgentRunner implements AgentRunner {
  readonly calls: RunOptions[] = []
  readonly runs: FakeRun[] = []
  private readonly queue: FakeStep[][] = []

  constructor(private script: FakeScript = DEFAULT_FAKE_SCRIPT) {}

  /** Guion para la próxima llamada a `run()` (tiene prioridad sobre el guion general). */
  enqueue(steps: FakeStep[]): this {
    this.queue.push(steps)
    return this
  }

  setScript(script: FakeScript): this {
    this.script = script
    return this
  }

  /** Libera el `hold` de la ejecución más reciente (o de la indicada). */
  release(index = this.runs.length - 1): void {
    this.runs[index]?.release()
  }

  run(options: RunOptions): RunHandle {
    const callIndex = this.calls.length
    this.calls.push(options)
    const steps =
      this.queue.shift() ??
      (typeof this.script === 'function' ? this.script(options, callIndex) : this.script)

    let wake: (() => void) | undefined
    const state: FakeRun = {
      options,
      interrupted: false,
      closed: false,
      emitted: [],
      release: () => wake?.(),
    }
    this.runs.push(state)
    const stopped = () => state.interrupted || state.closed || options.signal.aborted
    const sleep = (ms: number | null) =>
      new Promise<void>((resolve) => {
        const timer = ms === null ? undefined : setTimeout(resolve, ms)
        wake = () => {
          if (timer) clearTimeout(timer)
          wake = undefined
          resolve()
        }
      })
    options.signal.addEventListener('abort', () => wake?.(), { once: true })

    async function* events(): AsyncGenerator<RunnerEvent> {
      for (const step of steps) {
        if (stopped()) return
        if (step.type === 'wait') {
          await sleep(step.ms)
          continue
        }
        if (step.type === 'hold') {
          await sleep(null)
          continue
        }
        if (step.type === 'fail') throw new RunnerError(step.message)
        state.emitted.push(step)
        yield step
        // Cede el turno como haría un proceso real entre mensajes.
        await new Promise((r) => setImmediate(r))
      }
    }

    return {
      events: events(),
      interrupt: async () => {
        state.interrupted = true
        wake?.()
      },
      close: () => {
        state.closed = true
        wake?.()
      },
    }
  }
}
