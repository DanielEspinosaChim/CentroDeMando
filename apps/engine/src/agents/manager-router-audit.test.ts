import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineEvent, RouterConfig } from '@cdm/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db/client.ts'
import { createStore, type Store } from '../db/store.ts'
import { ConflictError } from '../errors/index.ts'
import { EventHub } from '../events/hub.ts'
import { DEFAULT_ROUTER_CONFIG } from '../router/default-config.ts'
import { FakeAgentRunner, type FakeStep } from './fake-runner.ts'
import { AgentManager, RETRY_LIMIT_HIT_MESSAGE } from './manager.ts'

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

const TRIVIAL = 'Cambia el color del botón a azul'
const settle = () => new Promise((r) => setTimeout(r, 10))
const heldSession: FakeStep[] = [
  { type: 'session', sessionId: 's1' },
  { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.4, contextUsedPct: 1 },
  { type: 'hold' },
]
const limited = (limit: 'turns' | 'budget'): FakeStep[] => [
  { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 1.5, contextUsedPct: 1 },
  { type: 'limit', limit },
]

function realTmp(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('AgentManager + enrutador (observaciones de la auditoría 003)', () => {
  let store: Store
  let runner: FakeAgentRunner
  let events: EngineEvent[]
  let manager: AgentManager
  let routerConfig: RouterConfig
  let projectId: string

  const newAgent = () =>
    manager.createAgent('local', { name: 'A', role: 'implementador', projectId }).id

  beforeEach(() => {
    store = createStore(openDb(':memory:').db)
    runner = new FakeAgentRunner()
    const hub = new EventHub()
    events = []
    hub.subscribe('local', (e) => events.push(e))
    routerConfig = structuredClone(DEFAULT_ROUTER_CONFIG)
    manager = new AgentManager({
      store,
      runner,
      hub,
      config: {
        maxConcurrentAgents: 5,
        maxTurns: 7,
        maxCostUsdPerTask: 1.5,
        dataDir: realTmp('cdm-mra-data-'),
      },
      logger: silentLogger,
      routerConfig: { get: () => structuredClone(routerConfig) },
    })
    projectId = store.createProject('local', 'P', realTmp('cdm-mra-proj-')).id
  })

  async function pausedHaikuSession(agentId: string) {
    runner.enqueue(heldSession)
    const first = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await settle()
    await manager.pause('local', agentId)
    return first
  }

  // --- H4: reanudar con prompt nuevo no se salta el piso de riesgo -----------------------

  it('C003-5 resume con prompt sensible en una sesión haiku sube a sonnet y emite router.decision', async () => {
    const agentId = newAgent()
    const first = await pausedHaikuSession(agentId)
    expect(first.model).toBe('haiku')
    const resumed = manager.resume('local', agentId, { prompt: 'Ahora cambia el accessToken' })
    await manager.idle()
    // Sigue siendo la misma sesión, con el saldo restante del tope de la tarea.
    expect(runner.calls[1]).toMatchObject({ model: 'sonnet', resume: 's1' })
    expect(runner.calls[1]?.maxBudgetUsd).toBeCloseTo(1.1)
    expect(resumed).toMatchObject({
      model: 'sonnet',
      risk: 'high',
      routingSource: 'rule',
      retryOfRunId: null,
      consecutiveFailures: 0,
    })
    expect(resumed.routingReasons.join(' ')).toMatch(/Piso de riesgo: haiku → sonnet/)
    const decisions = events.filter((e) => e.type === 'router.decision')
    expect(decisions.map((e) => e.runId)).toEqual([first.id, resumed.id])
    expect(decisions[1]).toMatchObject({ decision: { model: 'sonnet', risk: 'high' } })
    const mine = events.filter((e) => e.runId === resumed.id)
    expect(mine[0]).toMatchObject({ type: 'agent.status', status: 'thinking' })
    expect(mine[1]?.type).toBe('router.decision')
  })

  it('C003-5 resume con prompt sensible y sesión ya en sonnet o más: conserva el modelo y no emite decisión', async () => {
    const agentId = newAgent()
    runner.enqueue(heldSession)
    const first = manager.startTask('local', agentId, { prompt: 'Diseña la arquitectura' })
    await settle()
    await manager.pause('local', agentId)
    const resumed = manager.resume('local', agentId, { prompt: 'Revisa el password del admin' })
    await manager.idle()
    expect(runner.calls[1]).toMatchObject({ model: 'opus', resume: 's1' })
    expect(resumed).toMatchObject({ model: 'opus', routingSource: null })
    const decisions = events.filter((e) => e.type === 'router.decision')
    expect(decisions.map((e) => e.runId)).toEqual([first.id])
  })

  it('resume sin prompt (o sin riesgo) en una sesión haiku conserva haiku y no emite decisión', async () => {
    const agentId = newAgent()
    const first = await pausedHaikuSession(agentId)
    runner.enqueue(heldSession)
    manager.resume('local', agentId, {})
    await settle()
    await manager.pause('local', agentId)
    manager.resume('local', agentId, { prompt: 'Sigue con el color' })
    await manager.idle()
    expect(runner.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'haiku'])
    const decisions = events.filter((e) => e.type === 'router.decision')
    expect(decisions.map((e) => e.runId)).toEqual([first.id])
  })

  it('resume con prompt sensible sin saldo → 409 antes de lanzar', async () => {
    const agentId = newAgent()
    runner.enqueue([
      { type: 'session', sessionId: 's1' },
      { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 1.5, contextUsedPct: 1 },
      { type: 'hold' },
    ])
    manager.startTask('local', agentId, { prompt: TRIVIAL })
    await settle()
    await manager.pause('local', agentId)
    expect(() => manager.resume('local', agentId, { prompt: 'cambia el token' })).toThrow(
      ConflictError,
    )
    expect(runner.calls).toHaveLength(1)
  })

  // --- H5: una ejecución cortada por tope no se reintenta con presupuesto completo ------

  it.each([
    ['turns', 'limit_turns'],
    ['budget', 'limit_budget'],
  ] as const)(
    'C003-7 tope de %s: guarda end_reason y el reintento responde 409',
    async (limit, reason) => {
      const agentId = newAgent()
      runner.enqueue(limited(limit))
      const run = manager.startTask('local', agentId, { prompt: TRIVIAL })
      await manager.idle()
      expect(store.getAgent('local', agentId)?.status).toBe('error')
      expect(store.runEndReason('local', run.id)).toBe(reason)
      expect(() => manager.retry('local', agentId, run.id, {})).toThrow(ConflictError)
      expect(() => manager.retry('local', agentId, run.id, {})).toThrow(RETRY_LIMIT_HIT_MESSAGE)
      // Tampoco con un modelo explícito.
      expect(() => manager.retry('local', agentId, run.id, { model: 'opus' })).toThrow(
        ConflictError,
      )
      expect(runner.calls).toHaveLength(1)
    },
  )

  it('C003-7 un error real sigue siendo reintentable y su end_reason queda en null', async () => {
    const agentId = newAgent()
    runner.enqueue([{ type: 'fail', message: 'boom' }])
    const run = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    expect(store.runEndReason('local', run.id)).toBeNull()
    const retry = manager.retry('local', agentId, run.id, {})
    await manager.idle()
    expect(retry).toMatchObject({ retryOfRunId: run.id, consecutiveFailures: 1 })
    expect(runner.calls).toHaveLength(2)
  })

  it('C003-7 un tope en mitad de una cadena de fallos corta la cadena (no escala a opus)', async () => {
    const agentId = newAgent()
    const fail: FakeStep[] = [{ type: 'fail', message: 'boom' }]
    runner.enqueue(fail).enqueue(limited('budget'))
    const a = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    const b = manager.retry('local', agentId, a.id, {})
    await manager.idle()
    expect(() => manager.retry('local', agentId, b.id, {})).toThrow(ConflictError)
    expect(runner.calls.map((c) => c.model)).toEqual(['haiku', 'haiku'])
  })

  it('end_reason no sale en la API (Run)', async () => {
    const agentId = newAgent()
    runner.enqueue(limited('turns'))
    const run = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    expect(store.getRun('local', run.id)).not.toHaveProperty('endReason')
  })
})
