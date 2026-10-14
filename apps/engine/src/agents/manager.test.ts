import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentStatus, EngineEvent } from '@cdm/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db/client.ts'
import { createStore, type Store } from '../db/store.ts'
import { EventHub } from '../events/hub.ts'
import { FakeAgentRunner } from './fake-runner.ts'
import { AgentManager, canTransition, LIMIT_MESSAGES } from './manager.ts'

describe('canTransition', () => {
  const valid: Array<[AgentStatus, AgentStatus]> = [
    ['idle', 'thinking'],
    ['thinking', 'running_tool'],
    ['running_tool', 'thinking'],
    ['thinking', 'done'],
    ['running_tool', 'error'],
    ['thinking', 'paused'],
    ['paused', 'thinking'],
    ['paused', 'stopped'],
    ['done', 'thinking'],
    ['interrupted', 'thinking'],
  ]
  const invalid: Array<[AgentStatus, AgentStatus]> = [
    ['idle', 'done'],
    ['idle', 'paused'],
    ['done', 'paused'],
    ['stopped', 'done'],
    ['paused', 'done'],
    ['error', 'running_tool'],
    ['interrupted', 'done'],
  ]
  it.each(valid)('%s → %s es válida', (from, to) => expect(canTransition(from, to)).toBe(true))
  it.each(invalid)('%s → %s es inválida', (from, to) => expect(canTransition(from, to)).toBe(false))
})

describe('AgentManager', () => {
  let store: Store
  let runner: FakeAgentRunner
  let events: EngineEvent[]
  let manager: AgentManager
  let agentId: string

  beforeEach(() => {
    store = createStore(openDb(':memory:').db)
    runner = new FakeAgentRunner()
    const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mgr-data-')))
    const hub = new EventHub()
    events = []
    hub.subscribe('local', (e) => events.push(e))
    manager = new AgentManager({
      store,
      runner,
      hub,
      config: { maxConcurrentAgents: 5, maxTurns: 7, maxCostUsdPerTask: 1.5, dataDir },
      logger: silentLogger,
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mgr-'))
    const project = store.createProject('local', 'P', fs.realpathSync.native(dir))
    agentId = manager.createAgent('local', {
      name: 'A',
      role: 'documentador',
      projectId: project.id,
    }).id
  })

  it('usa el modelo por defecto del rol y el maxTurns de la config', async () => {
    manager.startTask('local', agentId, { prompt: 'hola' })
    await manager.idle()
    expect(runner.calls[0]).toMatchObject({
      model: 'haiku',
      maxTurns: 7,
      maxBudgetUsd: 1.5,
      role: 'documentador',
    })
    expect(store.getAgent('local', agentId)?.status).toBe('done')
  })

  it('tope de costo alcanzado → estado error con aviso específico', async () => {
    runner.enqueue([
      { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 1.6, contextUsedPct: 1 },
      { type: 'limit', limit: 'budget' },
    ])
    const run = manager.startTask('local', agentId, { prompt: 'x' })
    await manager.idle()
    expect(store.getAgent('local', agentId)?.status).toBe('error')
    expect(store.lastRun('local', agentId)).toMatchObject({ id: run.id, costUsd: 1.6 })
    expect(events.find((e) => e.type === 'agent.error')).toMatchObject({
      message: LIMIT_MESSAGES.budget,
    })
  })

  it('pausa espera a que el proceso termine antes de liberar el hueco', async () => {
    runner.enqueue([{ type: 'session', sessionId: 's' }, { type: 'hold' }])
    manager.startTask('local', agentId, { prompt: 'x' })
    await new Promise((r) => setTimeout(r, 10))
    expect(manager.activeCount()).toBe(1)
    await manager.pause('local', agentId)
    expect(manager.activeCount()).toBe(0)
    expect(runner.runs[0]?.closed).toBe(true)
  })

  it('pausar o detener un agente idle → conflicto', async () => {
    await expect(manager.pause('local', agentId)).rejects.toThrow(/no está ejecutando/)
    await expect(manager.stop('local', agentId)).rejects.toThrow(/no está ejecutando/)
    expect(() => manager.resume('local', agentId, {})).toThrow(/no está en pausa/)
  })

  it('pasa por running_tool y vuelve a thinking con el resultado de la herramienta', async () => {
    runner.enqueue([
      { type: 'tool', tool: 'Grep', toolUseId: 't1' },
      { type: 'tool_result', toolUseId: 't1' },
      { type: 'output', text: 'ok' },
    ])
    const run = manager.startTask('local', agentId, { prompt: 'x' })
    await manager.idle()
    const seq = events
      .filter((e) => e.type === 'agent.status' && e.runId === run.id)
      .map((e) => (e as { status: AgentStatus }).status)
    expect(seq).toEqual(['thinking', 'running_tool', 'thinking', 'done'])
  })

  it('un agente pausado puede detenerse sin ejecución viva', async () => {
    runner.enqueue([{ type: 'session', sessionId: 's' }, { type: 'hold' }])
    manager.startTask('local', agentId, { prompt: 'x' })
    await new Promise((r) => setTimeout(r, 10))
    await manager.pause('local', agentId)
    expect(manager.activeCount()).toBe(0)
    const agent = await manager.stop('local', agentId)
    expect(agent.status).toBe('stopped')
  })

  it('nueva tarea (no reanudación) descarta la sesión anterior', async () => {
    runner.enqueue([{ type: 'session', sessionId: 'vieja' }])
    manager.startTask('local', agentId, { prompt: '1' })
    await manager.idle()
    runner.enqueue([])
    manager.startTask('local', agentId, { prompt: '2' })
    expect(store.getAgent('local', agentId)?.sdkSessionId).toBeNull()
    expect(runner.calls[1]?.resume).toBeUndefined()
    await manager.idle()
  })
})

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
