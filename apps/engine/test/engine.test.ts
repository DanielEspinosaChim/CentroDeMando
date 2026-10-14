import path from 'node:path'
import type { EngineEvent } from '@cdm/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeAgentRunner } from '../src/agents/fake-runner.ts'
import { GENERIC_RUN_ERROR } from '../src/agents/manager.ts'
import { DEFAULT_MAX_COST_USD_PER_TASK } from '../src/config.ts'
import { openDb } from '../src/db/client.ts'
import { createStore } from '../src/db/store.ts'
import { WS_PROTOCOL_PREFIX, WS_UNAUTHORIZED_CLOSE_CODE } from '../src/security/guards.ts'
import {
  connectWs,
  createProjectAndAgent,
  startTestEngine,
  type TestEngine,
  tempDir,
  tick,
  UI_ORIGIN,
  wsCloseCode,
} from './helpers.ts'

let engine: TestEngine | undefined

afterEach(async () => {
  await engine?.close()
  engine = undefined
})

const statuses = (events: EngineEvent[], runId: string) =>
  events.filter((e) => e.runId === runId && e.type === 'agent.status').map((e) => (e as any).status)

describe('Control de acceso (criterios 1 y 2)', () => {
  it('GET /health responde sin token y sin datos internos', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const res = await fetch(`${engine.baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('sin token o con token incorrecto → 401', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const noToken = await fetch(`${engine.baseUrl}/agents`)
    expect(noToken.status).toBe(401)
    expect(await noToken.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    })
    const wrong = await engine.http('GET', '/agents', undefined, { authorization: 'Bearer nope' })
    expect(wrong.status).toBe(401)
  })

  it('WebSocket sin token o con token incorrecto se cierra con 4401', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    expect(await wsCloseCode(engine.wsUrl)).toBe(WS_UNAUTHORIZED_CLOSE_CODE)
    expect(await wsCloseCode(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}malo`])).toBe(
      WS_UNAUTHORIZED_CLOSE_CODE,
    )
  })

  it('Host ajeno (DNS rebinding) → 403 aunque el token sea válido', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${engine!.baseUrl}/agents`,
        { headers: { host: 'evil.example:4317', authorization: `Bearer ${engine!.token}` } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
    expect((await engine.http('GET', '/agents', undefined, { host: 'localhost' })).status).toBe(200)
  })

  it('Origin ajeno → 403, también en el WebSocket; Origin de la interfaz se acepta', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const evil = await engine.http('GET', '/agents', undefined, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    expect(evil.body.error.code).toBe('FORBIDDEN')
    const ok = await engine.http('GET', '/agents', undefined, { origin: UI_ORIGIN })
    expect(ok.status).toBe(200)
    const wsEvil = await new Promise<number>((resolve) => {
      import('ws').then(({ default: WebSocket }) => {
        const ws = new WebSocket(engine!.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine!.token}`], {
          origin: 'https://evil.example',
        })
        ws.once('unexpected-response', (req, res) => {
          resolve(res.statusCode ?? 0)
          req.destroy()
        })
        ws.once('open', () => {
          resolve(101)
          ws.terminate()
        })
        ws.once('error', () => {})
      })
    })
    expect(wsEvil).toBe(403)
  })
})

describe('Validación de entradas (criterios 3 y 4)', () => {
  it('crea un agente idle con el modelo por defecto de su rol', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const { agentId } = await createProjectAndAgent(engine)
    const res = await engine.http('GET', `/agents/${agentId}`)
    expect(res.status).toBe(200)
    expect(res.body.agent).toMatchObject({
      status: 'idle',
      defaultModel: 'sonnet',
      role: 'implementador',
    })
    expect(res.body.lastRun).toBeNull()
  })

  it('datos inválidos → 400 VALIDATION_ERROR sin stack trace', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const res = await engine.http('POST', '/agents', { name: '', role: 'jefe' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.text).not.toMatch(/at .*\.ts|node_modules|stack/i)

    const badJson = await fetch(`${engine.baseUrl}/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
      body: '{no es json',
    })
    expect(badJson.status).toBe(400)
    const text = await badJson.text()
    expect(JSON.parse(text).error.code).toBe('VALIDATION_ERROR')
    expect(text).not.toMatch(/node_modules|\.js:\d+/)
  })

  it('ruta de proyecto inexistente, relativa o con ".." → 400', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    for (const p of [
      path.join(engine.dataDir, 'no-existe'),
      'relativa/carpeta',
      `${engine.projectDir}${path.sep}..${path.sep}${path.basename(engine.projectDir)}`,
    ]) {
      const res = await engine.http('POST', '/projects', { name: 'X', path: p })
      expect(res.status, p).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('projectId inexistente → 400', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const res = await engine.http('POST', '/agents', {
      name: 'Ana',
      role: 'qa',
      projectId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('registrar dos veces la misma ruta → 409', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    await createProjectAndAgent(engine)
    const res = await engine.http('POST', '/projects', { name: 'Otra', path: engine.projectDir })
    expect(res.status).toBe(409)
  })
})

describe('Ciclo de vida de una tarea', () => {
  it('criterio 5: eventos en orden por WebSocket', async () => {
    const runner = new FakeAgentRunner([
      { type: 'session', sessionId: 'ses-1' },
      { type: 'output', text: 'Leyendo el repo' },
      { type: 'tool', tool: 'Read', toolUseId: 'tu-1' },
      { type: 'tool_result', toolUseId: 'tu-1' },
      { type: 'output', text: 'Listo' },
      { type: 'usage', inputTokens: 1200, outputTokens: 300, costUsd: 0.0123, contextUsedPct: 4.2 },
    ])
    engine = await startTestEngine({ runner })
    const { agentId } = await createProjectAndAgent(engine)
    const ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])

    const res = await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'Revisa el repo' })
    expect(res.status).toBe(202)
    const { runId } = res.body
    await ws.waitFor((e) => e.type === 'agent.status' && e.status === 'done')

    const types = ws.events.filter((e) => e.runId === runId).map((e) => e.type)
    expect(types[0]).toBe('agent.status')
    expect(types.at(-2)).toBe('agent.usage')
    expect(types.at(-1)).toBe('agent.status')
    expect(statuses(ws.events, runId)[0]).toBe('thinking')
    expect(statuses(ws.events, runId).at(-1)).toBe('done')
    expect(ws.events.filter((e) => e.type === 'agent.output').map((e: any) => e.text)).toEqual([
      'Leyendo el repo',
      'Listo',
    ])
    expect(ws.events.find((e) => e.type === 'agent.tool')).toMatchObject({ tool: 'Read' })
    expect(ws.events.find((e) => e.type === 'agent.usage')).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.0123,
      contextUsedPct: 4.2,
    })

    // El runner recibió el cwd del proyecto y el modelo por defecto del rol.
    expect(runner.calls[0]).toMatchObject({
      model: 'sonnet',
      prompt: 'Revisa el repo',
      maxTurns: 40,
    })
    expect(runner.calls[0]?.resume).toBeUndefined()

    const detail = await engine.http('GET', `/agents/${agentId}`)
    expect(detail.body.agent).toMatchObject({ status: 'done', sdkSessionId: 'ses-1' })
    expect(detail.body.lastRun).toMatchObject({
      id: runId,
      status: 'done',
      inputTokens: 1200,
      costUsd: 0.0123,
    })
    expect(detail.body.lastRun.endedAt).toEqual(expect.any(Number))
    ws.close()
  })

  it('criterio 6: pausa guarda la sesión y reanudar pasa resume = sdkSessionId', async () => {
    const runner = new FakeAgentRunner()
    runner.enqueue([
      { type: 'session', sessionId: 'ses-pausa' },
      { type: 'output', text: 'a' },
      // El SDK real reporta costo en cada turno: sin él no hay presupuesto que descontar.
      { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01, contextUsedPct: 1 },
      { type: 'hold' },
    ])
    runner.enqueue([{ type: 'output', text: 'continuando' }])
    engine = await startTestEngine({ runner })
    const { agentId } = await createProjectAndAgent(engine)
    const ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])

    await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'Tarea larga', model: 'opus' })
    await ws.waitFor((e) => e.type === 'agent.usage')
    const paused = await engine.http('POST', `/agents/${agentId}/pause`)
    expect(paused.status).toBe(200)
    expect(paused.body.agent).toMatchObject({ status: 'paused', sdkSessionId: 'ses-pausa' })
    expect(runner.runs[0]?.interrupted).toBe(true)

    const resumed = await engine.http('POST', `/agents/${agentId}/resume`, {})
    expect(resumed.status).toBe(202)
    await ws.waitFor(
      (e) => e.runId === resumed.body.runId && e.type === 'agent.status' && e.status === 'done',
    )
    expect(runner.calls[1]).toMatchObject({ resume: 'ses-pausa', model: 'opus' })
    expect(runner.calls[1]?.maxBudgetUsd).toBeCloseTo(DEFAULT_MAX_COST_USD_PER_TASK - 0.01)

    // Reanudar algo que no está en pausa → 409.
    expect((await engine.http('POST', `/agents/${agentId}/resume`, {})).status).toBe(409)
    ws.close()
  })

  it('criterio 7: stop deja stopped y no hay eventos posteriores de esa ejecución', async () => {
    const runner = new FakeAgentRunner([
      { type: 'output', text: 'antes' },
      { type: 'hold' },
      { type: 'output', text: 'después' },
      { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0, contextUsedPct: 0 },
    ])
    engine = await startTestEngine({ runner })
    const { agentId } = await createProjectAndAgent(engine)
    const ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])

    const { body } = await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'x' })
    await ws.waitFor((e) => e.type === 'agent.output')
    const stopped = await engine.http('POST', `/agents/${agentId}/stop`)
    expect(stopped.status).toBe(200)
    expect(stopped.body.agent.status).toBe('stopped')
    await ws.waitFor((e) => e.type === 'agent.status' && e.status === 'stopped')
    const countAfterStop = ws.events.length

    runner.release() // aunque el proceso "siguiera", nada debe salir
    await engine.manager.idle()
    await tick()
    expect(ws.events.length).toBe(countAfterStop)
    expect(ws.events.at(-1)).toMatchObject({
      type: 'agent.status',
      status: 'stopped',
      runId: body.runId,
    })
    expect(runner.runs[0]?.closed).toBe(true)
    expect(runner.calls[0]?.signal.aborted).toBe(true)
    ws.close()
  })

  it('criterio 8: 409 si el agente ya ejecuta y 429 al exceder la concurrencia', async () => {
    const runner = new FakeAgentRunner([{ type: 'hold' }])
    engine = await startTestEngine({ runner, config: { maxConcurrentAgents: 2 } })
    const a = await createProjectAndAgent(engine, 'A')
    const b = await engine.http('POST', '/agents', {
      name: 'B',
      role: 'qa',
      projectId: a.projectId,
    })
    const c = await engine.http('POST', '/agents', {
      name: 'C',
      role: 'qa',
      projectId: a.projectId,
    })

    expect((await engine.http('POST', `/agents/${a.agentId}/tasks`, { prompt: '1' })).status).toBe(
      202,
    )
    const busy = await engine.http('POST', `/agents/${a.agentId}/tasks`, { prompt: '2' })
    expect(busy.status).toBe(409)
    expect(busy.body.error.code).toBe('CONFLICT')
    expect(
      (await engine.http('POST', `/agents/${b.body.agent.id}/tasks`, { prompt: '3' })).status,
    ).toBe(202)
    const limit = await engine.http('POST', `/agents/${c.body.agent.id}/tasks`, { prompt: '4' })
    expect(limit.status).toBe(429)
    expect(limit.body.error.code).toBe('LIMIT_EXCEEDED')

    // Borrar un agente que está ejecutando → 409.
    expect((await engine.http('DELETE', `/agents/${a.agentId}`)).status).toBe(409)
  })

  it('criterio 9: si el runner falla → error, evento genérico y detalle solo en el log', async () => {
    const runner = new FakeAgentRunner([
      { type: 'output', text: 'empezando' },
      { type: 'fail', message: 'detalle interno del fallo' },
    ])
    engine = await startTestEngine({ runner })
    const { agentId } = await createProjectAndAgent(engine)
    const ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])

    await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'x' })
    const err = await ws.waitFor((e) => e.type === 'agent.error')
    expect(err).toMatchObject({ message: GENERIC_RUN_ERROR })
    await ws.waitFor((e) => e.type === 'agent.status' && e.status === 'error')
    expect(JSON.stringify(ws.events)).not.toContain('detalle interno')
    expect(engine.logs()).toContain('detalle interno del fallo')

    const detail = await engine.http('GET', `/agents/${agentId}`)
    expect(detail.body.agent.status).toBe('error')
    expect(detail.text).not.toContain('detalle interno')
    ws.close()
  })

  it('DELETE elimina un agente detenido', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const { agentId } = await createProjectAndAgent(engine)
    expect((await engine.http('DELETE', `/agents/${agentId}`)).status).toBe(204)
    expect((await engine.http('GET', `/agents/${agentId}`)).status).toBe(404)
  })
})

describe('Persistencia (criterio 10)', () => {
  it('tras reiniciar, lo que estaba en curso queda interrupted', async () => {
    const dataDir = tempDir()
    const runner = new FakeAgentRunner([{ type: 'hold' }])
    engine = await startTestEngine({ runner, dataDir })
    const { agentId } = await createProjectAndAgent(engine)
    const { body } = await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'x' })
    // Simula una caída: se cierra la base sin pasar por stop.
    engine.db.close()
    engine.manager.shutdown = async () => {}
    await engine.app.close()
    engine = undefined

    const reopened = openDb(path.join(dataDir, 'data.db'))
    const store = createStore(reopened.db)
    expect(store.markInterrupted()).toEqual({ agents: 1, runs: 1 })
    expect(store.getAgent('local', agentId)?.status).toBe('interrupted')
    expect(store.lastRun('local', agentId)).toMatchObject({ id: body.runId, status: 'interrupted' })
    expect(store.listProjects('local')).toHaveLength(1)
    reopened.close()
  })
})

describe('Seguridad', () => {
  it('el token local no aparece en ningún log', async () => {
    const runner = new FakeAgentRunner([{ type: 'fail', message: 'fallo' }])
    engine = await startTestEngine({ runner })
    const { agentId } = await createProjectAndAgent(engine)
    const ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])
    await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'x' })
    await ws.waitFor((e) => e.type === 'agent.error')
    await engine.http('GET', '/agents', undefined, { authorization: `Bearer ${engine.token}x` })
    ws.close()
    await tick()
    expect(engine.logs().length).toBeGreaterThan(0)
    expect(engine.logs()).not.toContain(engine.token)
  })

  it('un error que contiene el token se registra con el token oculto', async () => {
    let token = ''
    const runner = new FakeAgentRunner(() => [{ type: 'fail', message: `fallo con ${token}` }])
    engine = await startTestEngine({ runner })
    token = engine.token
    const { agentId } = await createProjectAndAgent(engine)
    await engine.http('POST', `/agents/${agentId}/tasks`, { prompt: 'x' })
    await engine.manager.idle()
    expect(engine.logs()).toContain('fallo con [oculto]')
    expect(engine.logs()).not.toContain(engine.token)
  })

  it('aislamiento multi-tenant: un agente del workspace A no es visible ni operable desde B', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner([{ type: 'hold' }]) })
    const { agentId, projectId } = await createProjectAndAgent(engine)
    const m = engine.manager
    expect(m.listAgents('otro')).toEqual([])
    expect(engine.store.listProjects('otro')).toEqual([])
    expect(() => m.getAgent('otro', agentId)).toThrow(/no encontrado/i)
    expect(() => m.startTask('otro', agentId, { prompt: 'x' })).toThrow(/no encontrado/i)
    await expect(m.stop('otro', agentId)).rejects.toThrow(/no encontrado/i)
    expect(() => m.deleteAgent('otro', agentId)).toThrow(/no encontrado/i)
    expect(() => m.createAgent('otro', { name: 'X', role: 'qa', projectId })).toThrow(
      /proyecto no existe/i,
    )
    // Sigue existiendo en su workspace.
    expect(m.getAgent('local', agentId).agent.id).toBe(agentId)
  })

  it('rechaza campos extra que intenten fijar el workspace', async () => {
    engine = await startTestEngine({ runner: new FakeAgentRunner() })
    const res = await engine.http('POST', '/projects', {
      name: 'X',
      path: engine.projectDir,
      workspaceId: 'otro',
    })
    expect(res.status).toBe(400)
  })
})
