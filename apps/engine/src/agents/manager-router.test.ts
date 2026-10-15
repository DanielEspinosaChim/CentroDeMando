import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentRole, EngineEvent, RouterConfig } from '@cdm/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db/client.ts'
import { createStore, type Store } from '../db/store.ts'
import { ConflictError, NotFoundError } from '../errors/index.ts'
import { EventHub } from '../events/hub.ts'
import { DEFAULT_ROUTER_CONFIG } from '../router/default-config.ts'
import { FakeAgentRunner, type FakeStep } from './fake-runner.ts'
import { AgentManager } from './manager.ts'

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
const fail = [{ type: 'fail' as const, message: 'boom' }]
/** Sesión con costo reportado que se queda esperando (para pausarla y reanudarla). */
const heldSession: FakeStep[] = [
  { type: 'session', sessionId: 's1' },
  { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.01, contextUsedPct: 1 },
  { type: 'hold' },
]

function realTmp(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('AgentManager + enrutador', () => {
  let store: Store
  let runner: FakeAgentRunner
  let events: EngineEvent[]
  let manager: AgentManager
  let routerConfig: RouterConfig
  let projectId: string

  function newAgent(role: AgentRole = 'implementador', workspaceId = 'local'): string {
    return manager.createAgent(workspaceId, { name: 'A', role, projectId }).id
  }

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
        dataDir: realTmp('cdm-mr-data-'),
      },
      logger: silentLogger,
      routerConfig: { get: () => structuredClone(routerConfig) },
    })
    projectId = store.createProject('local', 'P', realTmp('cdm-mr-proj-')).id
  })

  it('C003-1 sin modelo: decide, guarda la decisión, emite router.decision y lanza con ese modelo', async () => {
    const agentId = newAgent('implementador')
    const run = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    expect(runner.calls[0]?.model).toBe('haiku')
    expect(run).toMatchObject({
      model: 'haiku',
      taskSize: 'small',
      risk: 'normal',
      routingSource: 'rule',
      retryOfRunId: null,
      consecutiveFailures: 0,
    })
    expect(run.routingReasons.length).toBeGreaterThan(0)
    expect(store.getRun('local', run.id)).toMatchObject({
      model: 'haiku',
      taskSize: 'small',
      routingSource: 'rule',
      routingReasons: run.routingReasons,
    })
    const mine = events.filter((e) => e.runId === run.id)
    // agent.status = thinking sigue siendo el primero (C001-5); la decisión va justo después,
    // antes de cualquier evento del runner.
    expect(mine[0]).toMatchObject({ type: 'agent.status', status: 'thinking' })
    expect(mine[1]).toMatchObject({
      type: 'router.decision',
      agentId,
      decision: { model: 'haiku', size: 'small', risk: 'normal', source: 'rule' },
      retryOfRunId: null,
      consecutiveFailures: 0,
    })
    expect(mine[2]?.type).toBe('agent.output')
    expect(events.some((e) => e.type === 'router.warning')).toBe(false)
  })

  it('C003-4 sin señales usa el modelo por defecto del rol de la configuración', async () => {
    const agentId = newAgent('documentador')
    routerConfig.roleDefaults.documentador = 'sonnet'
    const run = manager.startTask('local', agentId, { prompt: 'Revisa el repo' })
    await manager.idle()
    expect(runner.calls[0]?.model).toBe('sonnet')
    expect(run).toMatchObject({ taskSize: 'unknown', routingSource: 'role_default' })
  })

  it('C003-5 tarea chica con "token" no va a haiku', async () => {
    const run = manager.startTask('local', newAgent('documentador'), {
      prompt: 'Cambia el texto del token',
    })
    await manager.idle()
    expect(run).toMatchObject({ model: 'sonnet', risk: 'high' })
    expect(runner.calls[0]?.model).toBe('sonnet')
  })

  it('C003-6 modelo explícito bajo el piso: se respeta y se emite router.warning', async () => {
    const agentId = newAgent()
    const run = manager.startTask('local', agentId, {
      prompt: 'Cambia la contraseña del admin',
      model: 'haiku',
    })
    await manager.idle()
    expect(runner.calls[0]?.model).toBe('haiku')
    expect(run).toMatchObject({ model: 'haiku', routingSource: 'override', risk: 'high' })
    const warning = events.find((e) => e.type === 'router.warning')
    expect(warning).toMatchObject({ agentId, runId: run.id })
    expect(warning && 'message' in warning && warning.message).toMatch(/piso de riesgo/)
    expect(events.find((e) => e.type === 'router.decision')).toMatchObject({
      decision: { source: 'override', model: 'haiku' },
    })
  })

  it('C003-7 dos fallos seguidos + reintento → el runner recibe el modelo escalado', async () => {
    const agentId = newAgent()
    runner.enqueue(fail).enqueue(fail).enqueue(fail).enqueue(fail)
    const first = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    expect(store.getAgent('local', agentId)?.status).toBe('error')

    const r1 = manager.retry('local', agentId, first.id, {})
    await manager.idle()
    const r2 = manager.retry('local', agentId, r1.id, {})
    await manager.idle()
    const r3 = manager.retry('local', agentId, r2.id, {})
    await manager.idle()
    const r4 = manager.retry('local', agentId, r3.id, {})
    await manager.idle()

    expect(runner.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet', 'opus', 'opus'])
    expect(runner.calls.every((c) => c.prompt === TRIVIAL && c.resume === undefined)).toBe(true)
    expect(runner.calls.every((c) => c.maxBudgetUsd === 1.5)).toBe(true)
    expect([r1, r2, r3, r4].map((r) => r.consecutiveFailures)).toEqual([1, 2, 3, 4])
    expect([r1, r2, r3, r4].map((r) => r.retryOfRunId)).toEqual([first.id, r1.id, r2.id, r3.id])
    expect(r1.routingSource).toBe('rule')
    expect(r2).toMatchObject({ routingSource: 'escalation', model: 'sonnet' })
    expect(store.getRun('local', r2.id)).toMatchObject({
      routingSource: 'escalation',
      retryOfRunId: r1.id,
      consecutiveFailures: 2,
    })
    expect(events.find((e) => e.type === 'router.decision' && e.runId === r2.id)).toMatchObject({
      decision: { source: 'escalation', model: 'sonnet' },
      retryOfRunId: r1.id,
      consecutiveFailures: 2,
    })
  })

  it('C003-7 una tarea nueva (no un reintento) reinicia la cadena de fallos', async () => {
    const agentId = newAgent()
    runner.enqueue(fail).enqueue(fail)
    const a = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    const b = manager.retry('local', agentId, a.id, {})
    await manager.idle()
    manager.retry('local', agentId, b.id, {})
    await manager.idle()
    const fresh = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    expect(fresh).toMatchObject({ consecutiveFailures: 0, retryOfRunId: null, model: 'haiku' })
  })

  it('C003-6 reintento con modelo explícito: override sin escalamiento', async () => {
    const agentId = newAgent()
    runner.enqueue(fail).enqueue(fail)
    const a = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await manager.idle()
    const b = manager.retry('local', agentId, a.id, {})
    await manager.idle()
    const c = manager.retry('local', agentId, b.id, { model: 'haiku' })
    await manager.idle()
    expect(c).toMatchObject({ model: 'haiku', routingSource: 'override', consecutiveFailures: 2 })
  })

  it('reintento: rechaza ejecuciones que no son la última, no fallidas o ajenas', async () => {
    const agentId = newAgent()
    const other = newAgent('qa')
    runner.enqueue(fail)
    const failed = manager.startTask('local', agentId, { prompt: 'x' })
    await manager.idle()
    // De otro agente → 404.
    expect(() => manager.retry('local', other, failed.id, {})).toThrow(NotFoundError)
    // De otro workspace → 404.
    expect(() => manager.retry('otro', agentId, failed.id, {})).toThrow(NotFoundError)
    const done = manager.startTask('local', agentId, { prompt: 'y' })
    await manager.idle()
    // Ya no es la última ejecución → 409.
    expect(() => manager.retry('local', agentId, failed.id, {})).toThrow(ConflictError)
    // Terminó bien → 409.
    expect(() => manager.retry('local', agentId, done.id, {})).toThrow(ConflictError)
    expect(runner.calls).toHaveLength(2)
  })

  it('reintento con la tarea aún en curso → 409', async () => {
    const agentId = newAgent()
    runner.enqueue(fail)
    const failed = manager.startTask('local', agentId, { prompt: 'x' })
    await manager.idle()
    const retry = manager.retry('local', agentId, failed.id, {})
    expect(retry.status).toBe('thinking')
    expect(() => manager.retry('local', agentId, failed.id, {})).toThrow(ConflictError)
    await manager.idle()
  })

  it('resume no re-enruta: sigue con el modelo de la ejecución original y no emite decisión', async () => {
    const agentId = newAgent()
    runner.enqueue(heldSession)
    const first = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await settle()
    await manager.pause('local', agentId)
    // Aunque la config cambie, la reanudación conserva el modelo original.
    routerConfig.smallKeywords = ['zzz']
    const resumed = manager.resume('local', agentId, { prompt: 'Diseña la arquitectura' })
    await manager.idle()
    expect(runner.calls[1]).toMatchObject({ model: 'haiku', resume: 's1' })
    expect(resumed).toMatchObject({ model: 'haiku', routingSource: null, taskSize: null })
    const decisions = events.filter((e) => e.type === 'router.decision')
    expect(decisions.map((e) => e.runId)).toEqual([first.id])
  })

  it('reintento tras una reanudación fallida: prompt original y cadena desde el inicio de la sesión', async () => {
    const agentId = newAgent()
    runner.enqueue(heldSession)
    const first = manager.startTask('local', agentId, { prompt: TRIVIAL })
    await settle()
    await manager.pause('local', agentId)
    runner.enqueue(fail)
    const resumed = manager.resume('local', agentId, {})
    await manager.idle()
    expect(store.getAgent('local', agentId)?.status).toBe('error')
    const retry = manager.retry('local', agentId, resumed.id, {})
    await manager.idle()
    expect(runner.calls[2]).toMatchObject({ prompt: TRIVIAL, model: 'haiku', maxBudgetUsd: 1.5 })
    expect(runner.calls[2]?.resume).toBeUndefined()
    expect(retry).toMatchObject({ retryOfRunId: resumed.id, consecutiveFailures: 1 })
    expect(first.consecutiveFailures).toBe(0)
  })

  it('C003-8 un cambio de configuración afecta a la siguiente decisión', async () => {
    const agentId = newAgent('implementador')
    manager.startTask('local', agentId, { prompt: 'Ajusta el boton' })
    await manager.idle()
    routerConfig.smallKeywords = ['boton']
    manager.startTask('local', agentId, { prompt: 'Ajusta el boton' })
    await manager.idle()
    expect(runner.calls.map((c) => c.model)).toEqual(['sonnet', 'haiku'])
  })
})
