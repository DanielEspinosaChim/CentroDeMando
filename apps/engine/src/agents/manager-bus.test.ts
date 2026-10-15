import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentRole, EngineEvent } from '@cdm/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { MessageBus } from '../bus/bus.ts'
import { DATA_NOTICE, WAKE_PROMPT } from '../bus/delivery.ts'
import { openDb } from '../db/client.ts'
import { createStore, type Store } from '../db/store.ts'
import { EventHub } from '../events/hub.ts'
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

const settle = () => new Promise((r) => setTimeout(r, 10))
const usage: FakeStep = {
  type: 'usage',
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0.001,
  contextUsedPct: 1,
}

function realTmp(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('AgentManager + bus de mensajes', () => {
  let store: Store
  let runner: FakeAgentRunner
  let bus: MessageBus
  let events: EngineEvent[]
  let manager: AgentManager
  let projectId: string
  let maxConcurrentAgents: number

  function build() {
    const hub = new EventHub()
    events = []
    hub.subscribe('local', (e) => events.push(e))
    bus = new MessageBus({ store, hub })
    manager = new AgentManager({
      store,
      runner,
      hub,
      bus,
      config: {
        maxConcurrentAgents,
        maxTurns: 7,
        maxCostUsdPerTask: 1.5,
        dataDir: realTmp('cdm-mb-data-'),
      },
      logger: silentLogger,
    })
  }

  function newAgent(name: string, role: AgentRole = 'implementador'): string {
    return manager.createAgent('local', { name, role, projectId }).id
  }

  const status = (agentId: string) => store.getAgent('local', agentId)?.status
  const statuses = (agentId: string) =>
    store
      .messageHistory('local', agentId, 100)
      ?.messages.filter((m) => m.toAgentId === agentId)
      .map((m) => m.status)

  beforeEach(() => {
    store = createStore(openDb(':memory:').db)
    runner = new FakeAgentRunner()
    maxConcurrentAgents = 5
    build()
    projectId = store.createProject('local', 'P', realTmp('cdm-mb-proj-')).id
  })

  it('C002-1 un agente llama a send_message durante su tarea: se guarda y se emite bus.message', async () => {
    const a = newAgent('Ana')
    const b = newAgent('Beto')
    runner.enqueue([{ type: 'call', tool: 'send_message', input: { to: 'Beto', body: 'hola' } }])
    const run = manager.startTask('local', a, { prompt: 'Coordina' })
    await manager.idle()
    expect(runner.runs[0]?.toolResults[0]?.ok).toBe(true)
    const ev = events.find((e) => e.type === 'bus.message')
    expect(ev).toMatchObject({ from: a, to: b, agentId: a, runId: run.id })
    expect(statuses(b)).toEqual(['pending'])
    // La herramienta del bus cuenta como herramienta en el estado del agente.
    expect(events.some((e) => e.type === 'agent.tool' && e.tool === 'mcp__bus__send_message')).toBe(
      true,
    )
  })

  it('C002-2 difusión desde un agente: N-1 entregas, nunca al remitente', async () => {
    const a = newAgent('Ana')
    newAgent('Beto')
    newAgent('Caro')
    runner.enqueue([{ type: 'call', tool: 'send_message', input: { to: '*', body: 'todos' } }])
    manager.startTask('local', a, { prompt: 'Avisa' })
    await manager.idle()
    const sent = events.filter((e) => e.type === 'bus.message')
    expect(sent).toHaveLength(2)
    expect(sent.some((e) => e.type === 'bus.message' && e.to === a)).toBe(false)
  })

  it('C002-3 destinatario inexistente: la herramienta recibe el error y no se guarda nada', async () => {
    const a = newAgent('Ana')
    runner.enqueue([{ type: 'call', tool: 'send_message', input: { to: 'Nadie', body: 'x' } }])
    manager.startTask('local', a, { prompt: 'x' })
    await manager.idle()
    expect(runner.runs[0]?.toolResults[0]).toEqual({
      ok: false,
      text: 'Destinatario no encontrado',
    })
    expect(events.some((e) => e.type === 'bus.message')).toBe(false)
    expect(status(a)).toBe('done')
  })

  it('C002-4 la siguiente tarea recibe los pendientes antepuestos como datos y quedan delivered', async () => {
    const b = newAgent('Beto')
    bus.send('local', { kind: 'user' }, { to: b, body: 'Revisa el login' })
    const run = manager.startTask('local', b, { prompt: 'Haz tu tarea' })
    const prompt = runner.calls[0]?.prompt ?? ''
    expect(prompt).toContain(DATA_NOTICE)
    expect(prompt).toContain('Revisa el login')
    expect(prompt).toContain('remitente="usuario"')
    expect(prompt.endsWith('\n\nHaz tu tarea')).toBe(true)
    expect(statuses(b)).toEqual(['delivered'])
    // El prompt guardado (el que se reintenta y enruta) es solo el de la tarea.
    expect(store.getRun('local', run.id)?.prompt).toBe('Haz tu tarea')
    await manager.idle()
    // Ya entregados: la tarea siguiente no los repite.
    manager.startTask('local', b, { prompt: 'Otra' })
    expect(runner.calls[1]?.prompt).toBe('Otra')
    await manager.idle()
  })

  it('C002-5 con wake y destinatario idle, el motor le lanza una tarea para atenderlo', async () => {
    const a = newAgent('Ana', 'coordinador')
    const b = newAgent('Beto')
    runner.enqueue([
      { type: 'call', tool: 'send_message', input: { to: 'Beto', body: 'Ayuda', wake: true } },
      usage,
    ])
    manager.startTask('local', a, { prompt: 'Coordina' })
    await manager.idle()
    expect(runner.calls).toHaveLength(2)
    const wakeCall = runner.calls[1]
    expect(wakeCall?.prompt).toContain('Ayuda')
    expect(wakeCall?.prompt.endsWith(WAKE_PROMPT)).toBe(true)
    expect(wakeCall?.role).toBe('implementador')
    expect(store.lastRun('local', b)?.prompt).toBe(WAKE_PROMPT)
    expect(statuses(b)).toEqual(['delivered'])
    expect(status(b)).toBe('done')
  })

  it('C002-5 con wake y destinatario ocupado, queda en cola y se atiende al terminar', async () => {
    const b = newAgent('Beto')
    runner.enqueue([{ type: 'hold' }, usage])
    manager.startTask('local', b, { prompt: 'Larga' })
    await settle()
    bus.send('local', { kind: 'user' }, { to: b, body: 'Cuando puedas', wake: true })
    expect(runner.calls).toHaveLength(1)
    expect(statuses(b)).toEqual(['pending'])
    runner.release(0)
    await manager.idle()
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]?.prompt).toContain('Cuando puedas')
    expect(statuses(b)).toEqual(['delivered'])
  })

  it('C002-5 un agente en pausa o con error no se despierta: el mensaje espera a su próxima tarea', async () => {
    const b = newAgent('Beto')
    runner.enqueue([{ type: 'fail', message: 'boom' }])
    manager.startTask('local', b, { prompt: 'x' })
    await manager.idle()
    expect(status(b)).toBe('error')
    bus.send('local', { kind: 'user' }, { to: b, body: 'hola', wake: true })
    await manager.idle()
    expect(runner.calls).toHaveLength(1)
    expect(statuses(b)).toEqual(['pending'])
  })

  it('C002-5 sin hueco de concurrencia el despertar espera a que termine otra ejecución', async () => {
    maxConcurrentAgents = 1
    build()
    const a = newAgent('Ana')
    const b = newAgent('Beto')
    runner.enqueue([
      { type: 'call', tool: 'send_message', input: { to: 'Beto', body: 'x', wake: true } },
      { type: 'hold' },
    ])
    manager.startTask('local', a, { prompt: 'x' })
    await settle()
    expect(runner.calls).toHaveLength(1)
    expect(statuses(b)).toEqual(['pending'])
    runner.release(0)
    await manager.idle()
    expect(runner.calls).toHaveLength(2)
    expect(status(b)).toBe('done')
  })

  it('C002-7 un bucle A↔B con wake se corta tras 10 despertares encadenados (bus.limit max_depth)', async () => {
    const a = newAgent('Ana', 'coordinador')
    const b = newAgent('Beto', 'implementador')
    // Cada agente despertado responde al otro con wake, sin replyToId: el hilo lo hereda
    // la ejecución, así que no puede escapar del límite "olvidando" responder en el hilo.
    runner.setScript((options) => [
      {
        type: 'call',
        tool: 'send_message',
        input: { to: options.role === 'coordinador' ? 'Beto' : 'Ana', body: 'eco', wake: true },
      },
      usage,
    ])
    bus.send('local', { kind: 'user' }, { to: a, body: 'Empieza', wake: true })
    await manager.idle()
    expect(runner.calls).toHaveLength(10)
    const limits = events.filter((e) => e.type === 'bus.limit')
    expect(limits).toEqual([expect.objectContaining({ reason: 'max_depth' })])
    // Los mensajes se siguen guardando: 1 del usuario + 10 de los agentes.
    const sent = events.filter((e) => e.type === 'bus.message')
    expect(sent).toHaveLength(11)
    expect(new Set(sent.map((e) => (e.type === 'bus.message' ? e.threadId : ''))).size).toBe(1)
    expect(sent.at(-1)).toMatchObject({ depth: 11, wake: true })
    expect(status(a)).toBe('done')
    expect(status(b)).toBe('done')
  })

  it('C002-11 read_inbox desde la tarea solo ve mensajes propios y los marca read', async () => {
    const a = newAgent('Ana')
    const b = newAgent('Beto')
    const c = newAgent('Caro')
    bus.send('local', { kind: 'user' }, { to: c, body: 'para Caro' })
    runner.enqueue([{ type: 'hold' }, { type: 'call', tool: 'read_inbox', input: {} }])
    manager.startTask('local', b, { prompt: 'x' })
    await settle()
    // Llega mientras B trabaja: no estaba en su prompt.
    bus.send('local', { kind: 'agent', agentId: a, runId: null }, { to: b, body: 'para Beto' })
    runner.release(0)
    await manager.idle()
    const inbox = runner.runs[0]?.toolResults[0]
    expect(inbox?.ok).toBe(true)
    expect(inbox?.text).toContain('para Beto')
    expect(inbox?.text).not.toContain('para Caro')
    expect(statuses(b)).toEqual(['read'])
    expect(statuses(c)).toEqual(['pending'])
  })

  it('durante el apagado no se lanzan despertares', async () => {
    const b = newAgent('Beto')
    await manager.shutdown()
    bus.send('local', { kind: 'user' }, { to: b, body: 'x', wake: true })
    await manager.idle()
    expect(runner.calls).toHaveLength(0)
  })
})
