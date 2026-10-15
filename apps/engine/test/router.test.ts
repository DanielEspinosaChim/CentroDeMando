import fs from 'node:fs'
import path from 'node:path'
import type { EngineEvent } from '@cdm/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeAgentRunner, type FakeStep } from '../src/agents/fake-runner.ts'
import { ROUTER_CONFIG_FILE_NAME } from '../src/router/config-store.ts'
import { DEFAULT_ROUTER_CONFIG } from '../src/router/default-config.ts'
import { WS_PROTOCOL_PREFIX } from '../src/security/guards.ts'
import {
  connectWs,
  createProjectAndAgent,
  startTestEngine,
  type TestEngine,
  UI_ORIGIN,
  type WsClient,
} from './helpers.ts'

let engine: TestEngine | undefined
let ws: WsClient | undefined

afterEach(async () => {
  ws?.close()
  ws = undefined
  await engine?.close()
  engine = undefined
})

/** Motor y WebSocket del test en curso (arrancados por `start`). */
function eng(): TestEngine {
  if (!engine) throw new Error('motor sin arrancar')
  return engine
}
function sock(): WsClient {
  if (!ws) throw new Error('WebSocket sin conectar')
  return ws
}

const TRIVIAL = 'Cambia el color del botón a azul'
const LARGE = 'Diseña la arquitectura del módulo de reportes'
const usage = (costUsd: number): FakeStep => ({
  type: 'usage',
  inputTokens: 1,
  outputTokens: 1,
  costUsd,
  contextUsedPct: 1,
})
const ended = (runId: string) => (e: EngineEvent) =>
  e.runId === runId && e.type === 'agent.status' && (e.status === 'done' || e.status === 'error')

async function start(runner = new FakeAgentRunner(), config = {}) {
  engine = await startTestEngine({ runner, config })
  ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])
  const ids = await createProjectAndAgent(engine)
  return { runner, ...ids }
}

async function runTask(agentId: string, body: Record<string, unknown>): Promise<string> {
  const res = await eng().http('POST', `/agents/${agentId}/tasks`, body)
  expect(res.status).toBe(202)
  await sock().waitFor(ended(res.body.runId))
  return res.body.runId as string
}

describe('Enrutador por HTTP', () => {
  it('C003-1 una tarea sin modelo emite router.decision y la ejecución guarda la decisión', async () => {
    const { runner, agentId } = await start()
    const runId = await runTask(agentId, { prompt: TRIVIAL })
    expect(runner.calls[0]?.model).toBe('haiku')
    const decision = await sock().waitFor((e) => e.type === 'router.decision' && e.runId === runId)
    expect(decision).toMatchObject({
      agentId,
      decision: { model: 'haiku', size: 'small', risk: 'normal', source: 'rule' },
    })
    const detail = await eng().http('GET', `/agents/${agentId}`)
    expect(detail.body.lastRun).toMatchObject({
      id: runId,
      model: 'haiku',
      taskSize: 'small',
      risk: 'normal',
      routingSource: 'rule',
      retryOfRunId: null,
      consecutiveFailures: 0,
    })
    expect(detail.body.lastRun.routingReasons.length).toBeGreaterThan(0)
  })

  it('C003-6 modelo explícito bajo el piso → se respeta y llega router.warning por WebSocket', async () => {
    const { runner, agentId } = await start()
    const runId = await runTask(agentId, { prompt: 'Rota el token de la API', model: 'haiku' })
    expect(runner.calls[0]?.model).toBe('haiku')
    await sock().waitFor((e) => e.type === 'router.warning' && e.runId === runId)
  })

  it('C003-8 GET/PUT /router/config: la siguiente decisión ya usa la configuración nueva', async () => {
    const { runner, agentId } = await start()
    const current = await eng().http('GET', '/router/config')
    expect(current.status).toBe(200)
    expect(current.body.config).toEqual(DEFAULT_ROUTER_CONFIG)

    await runTask(agentId, { prompt: 'Ajusta el boton' })
    const next = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: ['boton'] }
    const put = await eng().http('PUT', '/router/config', next)
    expect(put.status).toBe(200)
    expect(put.body.config.smallKeywords).toEqual(['boton'])
    await runTask(agentId, { prompt: 'Ajusta el boton' })
    expect(runner.calls.map((c) => c.model)).toEqual(['sonnet', 'haiku'])

    expect((await eng().http('GET', '/router/config')).body.config).toEqual(next)
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(eng().dataDir, ROUTER_CONFIG_FILE_NAME), 'utf8'),
    )
    expect(onDisk).toEqual(next)
  })

  it.each([
    ['riskKeywords vacía', { ...DEFAULT_ROUTER_CONFIG, riskKeywords: [] }],
    ['campo desconocido', { ...DEFAULT_ROUTER_CONFIG, riskFloor: 'haiku' }],
    ['palabra demasiado larga', { ...DEFAULT_ROUTER_CONFIG, smallKeywords: ['x'.repeat(61)] }],
    [
      'demasiadas palabras',
      { ...DEFAULT_ROUTER_CONFIG, largeKeywords: Array.from({ length: 201 }, (_, i) => `w${i}`) },
    ],
    ['sin cuerpo', undefined],
  ])('C003-8 PUT /router/config inválida (%s) → 400 y no cambia nada', async (_name, body) => {
    await start()
    const res = await eng().http('PUT', '/router/config', body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.text).not.toMatch(/at .*\.ts|node_modules|stack/i)
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(fs.existsSync(path.join(eng().dataDir, ROUTER_CONFIG_FILE_NAME))).toBe(false)
  })

  it('C003-9 GET /router/stats suma ejecuciones y costo por modelo del workspace', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner
      .enqueue([usage(0.01)])
      .enqueue([usage(0.02)])
      .enqueue([usage(0.4)])
    await runTask(agentId, { prompt: TRIVIAL })
    await runTask(agentId, { prompt: TRIVIAL })
    await runTask(agentId, { prompt: LARGE })

    // Ejecución de otro workspace: no debe aparecer en las estadísticas.
    const store = eng().store
    const project = store.createProject('otro', 'Ajeno', eng().projectDir)
    const foreign = store.createAgent('otro', {
      projectId: project.id,
      name: 'Ajeno',
      role: 'qa',
      defaultModel: 'sonnet',
    })
    const run = store.createRun('otro', foreign.id, 'x', 'opus')
    store.setRunTotals('otro', run.id, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 9,
      contextUsedPct: 1,
    })

    const res = await eng().http('GET', '/router/stats')
    expect(res.status).toBe(200)
    expect(res.body.stats.models).toEqual([
      { model: 'haiku', runs: 2, costUsd: 0.03, runsWithoutCost: 0 },
      { model: 'sonnet', runs: 0, costUsd: 0, runsWithoutCost: 0 },
      { model: 'opus', runs: 1, costUsd: 0.4, runsWithoutCost: 0 },
    ])
    expect(res.body.stats).toMatchObject({ totalRuns: 3, totalCostUsd: 0.43 })
  })

  it('C003-7 POST /agents/:id/tasks/:runId/retry escala tras dos fallos', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    const fail: FakeStep[] = [{ type: 'fail', message: 'boom' }]
    runner.enqueue(fail).enqueue(fail)
    const first = await runTask(agentId, { prompt: TRIVIAL })
    const retry1 = await eng().http('POST', `/agents/${agentId}/tasks/${first}/retry`)
    expect(retry1.status).toBe(202)
    await sock().waitFor(ended(retry1.body.runId))
    const retry2 = await eng().http(
      'POST',
      `/agents/${agentId}/tasks/${retry1.body.runId}/retry`,
      {},
    )
    expect(retry2.status).toBe(202)
    await sock().waitFor(ended(retry2.body.runId))
    expect(runner.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet'])
    const decision = await sock().waitFor(
      (e) => e.type === 'router.decision' && e.runId === retry2.body.runId,
    )
    expect(decision).toMatchObject({
      decision: { source: 'escalation', model: 'sonnet' },
      retryOfRunId: retry1.body.runId,
      consecutiveFailures: 2,
    })
    // La última terminó bien: ya no se puede reintentar.
    const again = await eng().http('POST', `/agents/${agentId}/tasks/${retry2.body.runId}/retry`)
    expect(again.status).toBe(409)
  })

  it('retry: id inválido → 400, ejecución inexistente → 404, cuerpo extra → 400', async () => {
    const { agentId } = await start()
    const runId = await runTask(agentId, { prompt: 'x' })
    expect((await eng().http('POST', `/agents/${agentId}/tasks/nope/retry`)).status).toBe(400)
    const missing = await eng().http(
      'POST',
      `/agents/${agentId}/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV/retry`,
    )
    expect(missing.status).toBe(404)
    const extra = await eng().http('POST', `/agents/${agentId}/tasks/${runId}/retry`, {
      prompt: 'otra cosa',
    })
    expect(extra.status).toBe(400)
  })
})

describe('Seguridad de /router/*', () => {
  it('sin token → 401 en GET/PUT /router/config, GET /router/stats y retry', async () => {
    const { agentId } = await start()
    const noAuth = { authorization: '' }
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    for (const [method, url, body] of [
      ['GET', '/router/config', undefined],
      ['PUT', '/router/config', DEFAULT_ROUTER_CONFIG],
      ['GET', '/router/stats', undefined],
      ['POST', `/agents/${agentId}/tasks/${id}/retry`, {}],
    ] as const) {
      const res = await eng().http(method, url, body, noAuth)
      expect(res.status, `${method} ${url}`).toBe(401)
    }
    expect(fs.existsSync(path.join(eng().dataDir, ROUTER_CONFIG_FILE_NAME))).toBe(false)
  })

  it('PUT /router/config con Origin ajeno → 403; con el de la interfaz, 200', async () => {
    await start()
    const evil = await eng().http('PUT', '/router/config', DEFAULT_ROUTER_CONFIG, {
      origin: 'https://evil.example',
    })
    expect(evil.status).toBe(403)
    const ok = await eng().http('PUT', '/router/config', DEFAULT_ROUTER_CONFIG, {
      origin: UI_ORIGIN,
    })
    expect(ok.status).toBe(200)
  })

  it('PUT /router/config usa el límite de escrituras; los GET no se limitan', async () => {
    // createProjectAndAgent consume 2 escrituras.
    await start(new FakeAgentRunner(), { rateLimitWritesPerMin: 3 })
    expect((await eng().http('PUT', '/router/config', DEFAULT_ROUTER_CONFIG)).status).toBe(200)
    const limited = await eng().http('PUT', '/router/config', DEFAULT_ROUTER_CONFIG)
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    for (let i = 0; i < 5; i++) {
      expect((await eng().http('GET', '/router/config')).status).toBe(200)
      expect((await eng().http('GET', '/router/stats')).status).toBe(200)
    }
  })

  it('retry usa el límite de acciones por agente', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner, { rateLimitAgentActionsPerMin: 2 })
    runner.enqueue([{ type: 'fail', message: 'boom' }])
    const first = await runTask(agentId, { prompt: 'x' })
    const retry = await eng().http('POST', `/agents/${agentId}/tasks/${first}/retry`)
    expect(retry.status).toBe(202)
    await sock().waitFor(ended(retry.body.runId))
    const limited = await eng().http('POST', `/agents/${agentId}/tasks/${retry.body.runId}/retry`)
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    expect(runner.calls).toHaveLength(2)
  })
})
