import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client.ts'
import { createStore, type Store } from '../db/store.ts'
import { ConflictError, ValidationError } from '../errors/index.ts'
import { EventHub } from '../events/hub.ts'
import { FakeAgentRunner } from './fake-runner.ts'
import { AgentManager, BUDGET_EXHAUSTED_MESSAGE, sessionSpentUsd } from './manager.ts'
import type { AgentRunner, RunHandle, RunnerEvent, RunOptions } from './runner.ts'

const noop = () => {}
const silentLogger = {
  level: 'silent',
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  silent: noop,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger

interface Rig {
  store: Store
  runner: FakeAgentRunner
  manager: AgentManager
  dataDir: string
  projectDir: string
  agentId: string
}

function realTmp(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function makeRig(opts: { maxCost?: number; runner?: AgentRunner } = {}): Rig {
  const store = createStore(openDb(':memory:').db)
  const runner = new FakeAgentRunner()
  const dataDir = realTmp('cdm-rig-data-')
  const projectDir = realTmp('cdm-rig-proj-')
  const manager = new AgentManager({
    store,
    runner: opts.runner ?? runner,
    hub: new EventHub(),
    config: {
      maxConcurrentAgents: 5,
      maxTurns: 7,
      maxCostUsdPerTask: opts.maxCost ?? 1.5,
      dataDir,
    },
    logger: silentLogger,
  })
  const project = store.createProject('local', 'P', projectDir)
  const agent = manager.createAgent('local', {
    name: 'A',
    role: 'documentador',
    projectId: project.id,
  })
  return { store, runner, manager, dataDir, projectDir, agentId: agent.id }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

const usage = (costUsd: number): RunnerEvent => ({
  type: 'usage',
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  contextUsedPct: 1,
})

/** Arranca una tarea que reporta `cost`, se queda en `hold` y la pausa. */
async function startAndPause(rig: Rig, cost: number, sessionId = 's1'): Promise<void> {
  rig.runner.enqueue([{ type: 'session', sessionId }, usage(cost), { type: 'hold' }])
  rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
  await settle()
  await rig.manager.pause('local', rig.agentId)
}

describe('Revalidación del proyecto al lanzar', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Registra en el store (sin pasar por la API) un proyecto y un agente sobre `projectPath`. */
  function rawAgent(rig: Rig, projectPath: string): string {
    const project = rig.store.createProject('local', 'Peligroso', projectPath)
    return rig.manager.createAgent('local', {
      name: 'B',
      role: 'documentador',
      projectId: project.id,
    }).id
  }

  it('un proyecto legítimo lanza con su ruta real como cwd', async () => {
    const rig = makeRig()
    rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
    await rig.manager.idle()
    expect(rig.runner.calls[0]?.cwd).toBe(rig.projectDir)
  })

  it('una carpeta que contiene dataDir no lanza tareas y el runner no se llama', () => {
    const rig = makeRig()
    const parent = realTmp('cdm-parent-')
    const dataDir = path.join(parent, 'datos')
    fs.mkdirSync(dataDir)
    const manager = new AgentManager({
      store: rig.store,
      runner: rig.runner,
      hub: new EventHub(),
      config: { maxConcurrentAgents: 5, maxTurns: 7, maxCostUsdPerTask: 1, dataDir },
      logger: silentLogger,
    })
    const project = rig.store.createProject('local', 'Padre', parent)
    const agent = manager.createAgent('local', {
      name: 'P',
      role: 'documentador',
      projectId: project.id,
    })
    expect(() => manager.startTask('local', agent.id, { prompt: 'x' })).toThrow(ValidationError)
    expect(rig.runner.calls).toHaveLength(0)
    expect(rig.store.getAgent('local', agent.id)?.status).toBe('idle')
    expect(rig.store.lastRun('local', agent.id)).toBeUndefined()
  })

  it('la carpeta de usuario (simulada) no lanza tareas y el runner no se llama', () => {
    const rig = makeRig()
    // `paths.ts` toma la carpeta de usuario de `os.homedir()` (el manager no tiene opción).
    vi.spyOn(os, 'homedir').mockReturnValue(rig.projectDir)
    expect(() => rig.manager.startTask('local', rig.agentId, { prompt: 'x' })).toThrow(/usuario/)
    expect(rig.runner.calls).toHaveLength(0)
  })

  it('la raíz de la unidad guardada en el store no lanza tareas', () => {
    const rig = makeRig()
    const id = rawAgent(rig, path.parse(rig.projectDir).root)
    expect(() => rig.manager.startTask('local', id, { prompt: 'x' })).toThrow(ValidationError)
    expect(rig.runner.calls).toHaveLength(0)
  })

  it('una ruta UNC guardada en el store no lanza tareas', () => {
    const rig = makeRig()
    const id = rawAgent(rig, '\\\\localhost\\C$\\Users')
    expect(() => rig.manager.startTask('local', id, { prompt: 'x' })).toThrow(/UNC/)
    expect(rig.runner.calls).toHaveLength(0)
  })

  it('una carpeta sustituida por un enlace/junction a otro sitio no lanza tareas', () => {
    const rig = makeRig()
    const target = realTmp('cdm-target-')
    const original = realTmp('cdm-swap-')
    const id = rawAgent(rig, original)
    // Tras registrarlo, la carpeta se reemplaza por un junction hacia otro lugar.
    fs.rmSync(original, { recursive: true })
    fs.symlinkSync(target, original, 'junction')
    expect(() => rig.manager.startTask('local', id, { prompt: 'x' })).toThrow(/cambió/)
    expect(rig.runner.calls).toHaveLength(0)
  })

  it('una carpeta borrada tras registrarla no lanza tareas', () => {
    const rig = makeRig()
    const gone = realTmp('cdm-gone-')
    const id = rawAgent(rig, gone)
    fs.rmSync(gone, { recursive: true })
    expect(() => rig.manager.startTask('local', id, { prompt: 'x' })).toThrow(ValidationError)
    expect(rig.runner.calls).toHaveLength(0)
  })

  it('reanudar también revalida el proyecto', async () => {
    const rig = makeRig()
    await startAndPause(rig, 0.1)
    vi.spyOn(os, 'homedir').mockReturnValue(rig.projectDir)
    expect(() => rig.manager.resume('local', rig.agentId, {})).toThrow(/usuario/)
    expect(rig.runner.calls).toHaveLength(1)
  })
})

describe('sessionSpentUsd', () => {
  it('trata los costos como acumulados de la sesión (no suma doble)', () => {
    expect(sessionSpentUsd([0.5, 0.8, 1.3])).toBeCloseTo(1.3)
  })
  it('si el costo baja, esa ejecución se suma entera', () => {
    expect(sessionSpentUsd([0.5, 0.2])).toBeCloseTo(0.7)
  })
  it('ignora costos nulos, negativos y no finitos', () => {
    expect(sessionSpentUsd([null, 0.4, null, -1, Number.NaN, 0.6])).toBeCloseTo(0.6)
    expect(sessionSpentUsd([])).toBe(0)
  })
})

describe('Tope de costo al reanudar', () => {
  it('reanuda con maxBudgetUsd = tope − gastado', async () => {
    const rig = makeRig({ maxCost: 1.5 })
    await startAndPause(rig, 0.5)
    expect(rig.runner.calls[0]?.maxBudgetUsd).toBe(1.5)

    rig.runner.enqueue([])
    rig.manager.resume('local', rig.agentId, {})
    expect(rig.runner.calls[1]?.resume).toBe('s1')
    expect(rig.runner.calls[1]?.maxBudgetUsd).toBeCloseTo(1.0)
    await rig.manager.idle()
  })

  it('el costo acumulado de una sesión reanudada no se cuenta doble', async () => {
    const rig = makeRig({ maxCost: 1.5 })
    await startAndPause(rig, 0.5)

    // La reanudación reporta el total acumulado de la sesión (0.5 previo + 0.3 nuevos).
    rig.runner.enqueue([usage(0.8), { type: 'hold' }])
    rig.manager.resume('local', rig.agentId, {})
    await settle()
    await rig.manager.pause('local', rig.agentId)

    rig.runner.enqueue([])
    rig.manager.resume('local', rig.agentId, {})
    // Contado doble (0.5 + 0.8) quedarían 0.2; lo correcto es 1.5 − 0.8.
    expect(rig.runner.calls[2]?.maxBudgetUsd).toBeCloseTo(0.7)
    await rig.manager.idle()
  })

  it('sin saldo → ConflictError (409) y el runner no se llama', async () => {
    const rig = makeRig({ maxCost: 1.5 })
    await startAndPause(rig, 1.495) // quedan 0.005 < mínimo de reanudación

    let error: unknown
    try {
      rig.manager.resume('local', rig.agentId, {})
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).message).toBe(BUDGET_EXHAUSTED_MESSAGE)
    expect((error as ConflictError).statusCode).toBe(409)
    expect(rig.runner.calls).toHaveLength(1)
    expect(rig.store.getAgent('local', rig.agentId)?.status).toBe('paused')
  })

  it('con gasto por encima del tope tampoco reanuda', async () => {
    const rig = makeRig({ maxCost: 1 })
    await startAndPause(rig, 1.2)
    expect(() => rig.manager.resume('local', rig.agentId, {})).toThrow(ConflictError)
    expect(rig.runner.calls).toHaveLength(1)
  })

  it('un start nuevo (no resume) vuelve a tener el tope completo', async () => {
    const rig = makeRig({ maxCost: 1.5 })
    await startAndPause(rig, 1.495)
    expect(() => rig.manager.resume('local', rig.agentId, {})).toThrow(ConflictError)

    rig.runner.enqueue([{ type: 'session', sessionId: 'nueva' }, usage(0.2)])
    rig.manager.startTask('local', rig.agentId, { prompt: 'otra' })
    expect(rig.runner.calls[1]?.maxBudgetUsd).toBe(1.5)
    expect(rig.runner.calls[1]?.resume).toBeUndefined()
    await rig.manager.idle()

    // La sesión nueva solo arrastra lo gastado desde su inicio: 0.2, no 1.495 + 0.2.
    expect(rig.store.sessionRunCosts('local', rig.agentId)).toEqual([0.2])
  })
})

/**
 * Runner que implementa `AgentRunner` a mano: su `interrupt()` NO termina la iteración
 * (como un proceso del SDK colgado). `close()` la termina, salvo con `ignoreClose`.
 */
class StuckRunner implements AgentRunner {
  readonly runs: Array<{
    options: RunOptions
    interrupted: boolean
    closeCalls: number
    release(): void
  }> = []

  constructor(private readonly ignoreClose = false) {}

  run(options: RunOptions): RunHandle {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = { options, interrupted: false, closeCalls: 0, release }
    this.runs.push(state)
    async function* events(): AsyncGenerator<RunnerEvent> {
      yield { type: 'session', sessionId: 'stuck' }
      await gate
    }
    return {
      events: events(),
      interrupt: async () => {
        state.interrupted = true
      },
      close: () => {
        state.closeCalls++
        if (!this.ignoreClose) release()
      },
    }
  }
}

describe('Drenaje de ejecuciones que no terminan', () => {
  // NOTA: DRAIN_TIMEOUT_MS (5 s) no es inyectable; se usan timers falsos y se avanza 5000 ms,
  // así que estos tests no tardan tiempo real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => vi.useRealTimers())

  it('pause vence la espera a los 5 s y el handle queda abortado y cerrado', async () => {
    const stuck = new StuckRunner()
    const rig = makeRig({ runner: stuck })
    rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1)

    let settled = false
    const pausing = rig.manager.pause('local', rig.agentId).then((a) => {
      settled = true
      return a
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBe(false)
    expect(stuck.runs[0]?.interrupted).toBe(true)
    expect(stuck.runs[0]?.closeCalls).toBe(0)
    expect(stuck.runs[0]?.options.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const agent = await pausing
    expect(agent.status).toBe('paused')
    expect(stuck.runs[0]?.options.signal.aborted).toBe(true)
    expect(stuck.runs[0]?.closeCalls).toBeGreaterThanOrEqual(1)
    // Con la iteración terminada tras el cierre, el hueco queda libre.
    await vi.advanceTimersByTimeAsync(1)
    expect(rig.manager.activeCount()).toBe(0)
  })

  it('mientras sigue drenando, la pausa ocupa hueco y no se puede relanzar', async () => {
    const stuck = new StuckRunner(true)
    const rig = makeRig({ runner: stuck })
    rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1)
    const pausing = rig.manager.pause('local', rig.agentId)
    await vi.advanceTimersByTimeAsync(5000)
    await pausing
    expect(stuck.runs[0]?.options.signal.aborted).toBe(true)
    expect(rig.manager.activeCount()).toBe(1)
    expect(() => rig.manager.resume('local', rig.agentId, {})).toThrow(/cerrando/)
    stuck.runs[0]?.release()
    await vi.advanceTimersByTimeAsync(1)
    expect(rig.manager.activeCount()).toBe(0)
  })

  it('stop sobre un agente pausado que sigue drenando cierra el handle', async () => {
    const stuck = new StuckRunner()
    const rig = makeRig({ runner: stuck })
    rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1)

    const pausing = rig.manager.pause('local', rig.agentId)
    await vi.advanceTimersByTimeAsync(10)
    // La pausa ya es visible (paused) pero el proceso sigue drenando.
    expect(rig.store.getAgent('local', rig.agentId)?.status).toBe('paused')
    expect(rig.manager.activeCount()).toBe(1)
    expect(stuck.runs[0]?.closeCalls).toBe(0)

    const stopped = await rig.manager.stop('local', rig.agentId)
    expect(stopped.status).toBe('stopped')
    expect(stuck.runs[0]?.closeCalls).toBeGreaterThanOrEqual(1)
    expect(stuck.runs[0]?.options.signal.aborted).toBe(true)
    expect(rig.manager.activeCount()).toBe(0)
    await pausing
  })

  it('shutdown cierra también lo que sigue drenando tras una pausa', async () => {
    const stuck = new StuckRunner()
    const rig = makeRig({ runner: stuck })
    rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1)
    const pausing = rig.manager.pause('local', rig.agentId)
    await vi.advanceTimersByTimeAsync(10)
    expect(rig.manager.activeCount()).toBe(1)

    await rig.manager.shutdown()
    expect(stuck.runs[0]?.options.signal.aborted).toBe(true)
    expect(stuck.runs[0]?.closeCalls).toBeGreaterThanOrEqual(1)
    expect(rig.manager.activeCount()).toBe(0)
    await pausing
  })

  it('idle(timeoutMs) devuelve false si vence con consumidores pendientes', async () => {
    const stuck = new StuckRunner(true)
    const rig = makeRig({ runner: stuck })
    rig.manager.startTask('local', rig.agentId, { prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1)

    const idle = rig.manager.idle(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await idle).toBe(false)

    stuck.runs[0]?.release()
    expect(await rig.manager.idle(100)).toBe(true)
  })

  it('idle() devuelve true cuando no hay nada pendiente', async () => {
    const rig = makeRig()
    expect(await rig.manager.idle(50)).toBe(true)
  })
})
