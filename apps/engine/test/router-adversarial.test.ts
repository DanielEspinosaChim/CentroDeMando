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
  tempDir,
  type WsClient,
} from './helpers.ts'

// Validación independiente (QA) del enrutador por HTTP: casos límite, persistencia,
// reintentos, estadísticas y límites de tasa. Siempre con FakeAgentRunner.

let engine: TestEngine | undefined
let ws: WsClient | undefined

afterEach(async () => {
  ws?.close()
  ws = undefined
  await engine?.close()
  engine = undefined
})

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
const FAIL: FakeStep[] = [{ type: 'fail', message: 'boom' }]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ended = (runId: string) => (e: EngineEvent) =>
  e.runId === runId && e.type === 'agent.status' && (e.status === 'done' || e.status === 'error')

async function start(
  runner = new FakeAgentRunner(),
  config = {},
  dataDir?: string,
  withAgent = true,
) {
  engine = await startTestEngine({ runner, config, ...(dataDir ? { dataDir } : {}) })
  ws = await connectWs(engine.wsUrl, [`${WS_PROTOCOL_PREFIX}${engine.token}`])
  const ids = withAgent ? await createProjectAndAgent(engine) : { projectId: '', agentId: '' }
  return { runner, ...ids }
}

async function runTask(agentId: string, body: Record<string, unknown>): Promise<string> {
  const res = await eng().http('POST', `/agents/${agentId}/tasks`, body)
  expect(res.status, res.text).toBe(202)
  await sock().waitFor(ended(res.body.runId))
  return res.body.runId as string
}

async function retry(agentId: string, runId: string, body?: unknown): Promise<string> {
  const res = await eng().http('POST', `/agents/${agentId}/tasks/${runId}/retry`, body)
  expect(res.status, res.text).toBe(202)
  await sock().waitFor(ended(res.body.runId))
  return res.body.runId as string
}

const kw = (n: number, len = 5) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, 'k'))

describe('C003-8 PUT /router/config: límites de validación', () => {
  it('listas de tamaño/grande vacías son válidas y la decisión cae al modelo del rol', async () => {
    const { runner, agentId } = await start()
    const next = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: [], largeKeywords: [] }
    expect((await eng().http('PUT', '/router/config', next)).status).toBe(200)
    await runTask(agentId, { prompt: TRIVIAL })
    await runTask(agentId, { prompt: LARGE })
    expect(runner.calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet'])
  })

  it('frontera: exactamente 200 palabras de 60 caracteres es válido; 201 y 61 no', async () => {
    await start()
    const max = {
      ...DEFAULT_ROUTER_CONFIG,
      smallKeywords: kw(200, 60),
      riskKeywords: ['a'.repeat(60)],
    }
    expect((await eng().http('PUT', '/router/config', max)).status).toBe(200)
    const tooMany = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: kw(201) }
    expect((await eng().http('PUT', '/router/config', tooMany)).status).toBe(400)
    const tooLong = { ...DEFAULT_ROUTER_CONFIG, riskKeywords: ['a'.repeat(61)] }
    expect((await eng().http('PUT', '/router/config', tooLong)).status).toBe(400)
    // La última válida sigue vigente.
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(max)
  })

  it.each([
    ['listas gigantes (10 000 palabras)', { smallKeywords: kw(10_000) }],
    ['palabra de 5 000 caracteres', { largeKeywords: ['x'.repeat(5_000)] }],
    ['riskKeywords vacía', { riskKeywords: [] }],
    ['riskKeywords solo con espacios', { riskKeywords: ['   '] }],
    ['riskKeywords solo con diacríticos', { riskKeywords: ['́'] }],
    ['campo extra', { extra: true }],
    ['campo __proto__', JSON.parse('{"__proto__": {"polluted": true}}')],
    ['smallMaxChars 0', { smallMaxChars: 0 }],
    ['smallMaxChars 20001', { smallMaxChars: 20_001 }],
    ['smallMaxChars decimal', { smallMaxChars: 10.5 }],
    ['escalateAfterFailures 0', { escalateAfterFailures: 0 }],
    ['escalateAfterFailures 11', { escalateAfterFailures: 11 }],
    ['escalateAfterFailures texto', { escalateAfterFailures: '2' }],
    [
      'rol con modelo inexistente',
      { roleDefaults: { ...DEFAULT_ROUTER_CONFIG.roleDefaults, qa: 'gpt-5' } },
    ],
    ['falta un rol', { roleDefaults: { qa: 'haiku' } }],
    ['palabras que no son texto', { smallKeywords: [1, 2, 3] }],
  ])('C003-8 %s → 400 sin stack y la configuración no cambia', async (_name, patch) => {
    await start()
    const res = await eng().http('PUT', '/router/config', { ...DEFAULT_ROUTER_CONFIG, ...patch })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.text).not.toMatch(/at .*\.ts|node_modules|\bstack\b|ZodError/i)
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(fs.existsSync(path.join(eng().dataDir, ROUTER_CONFIG_FILE_NAME))).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    ['null', 'null'],
    ['arreglo', '[]'],
    ['número', '7'],
    ['texto', '"hola"'],
    ['JSON roto', '{"a":'],
  ])('C003-8 cuerpo %s → 400 sin stack', async (_name, raw) => {
    await start()
    const res = await fetch(`${eng().baseUrl}/router/config`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${eng().token}`, 'content-type': 'application/json' },
      body: raw,
    })
    const text = await res.text()
    expect(res.status).toBe(400)
    expect(text).not.toMatch(/at .*\.ts|node_modules|\bstack\b/i)
  })

  it('C003-8 cuerpo mayor que el límite del servidor → error de cliente sin stack ni cambios', async () => {
    await start()
    const huge = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: ['x'.repeat(200 * 1024)] }
    const res = await eng().http('PUT', '/router/config', huge)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(res.text).not.toMatch(/at .*\.ts|node_modules|\bstack\b/i)
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(DEFAULT_ROUTER_CONFIG)
  })

  it('C003-8 el cuerpo de PUT no puede quitar el piso de riesgo (riskKeywords mínima)', async () => {
    const { runner, agentId } = await start()
    const next = { ...DEFAULT_ROUTER_CONFIG, riskKeywords: ['zzz'] }
    expect((await eng().http('PUT', '/router/config', next)).status).toBe(200)
    await runTask(agentId, { prompt: 'Cambia el color del token' })
    await runTask(agentId, { prompt: 'Cambia el color de la zzz' })
    expect(runner.calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet'])
  })
})

describe('C003-8 persistencia de la configuración', () => {
  it('sobrevive a reiniciar el motor con la misma carpeta de datos y la siguiente decisión la usa', async () => {
    const dataDir = tempDir('cdm-persist-')
    await start(new FakeAgentRunner(), {}, dataDir, false)
    const next = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: ['boton'], smallMaxChars: 80 }
    expect((await eng().http('PUT', '/router/config', next)).status).toBe(200)
    ws?.close()
    await eng().close()
    engine = undefined

    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner, {}, dataDir)
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(next)
    await runTask(agentId, { prompt: 'Ajusta el boton' })
    expect(runner.calls[0]?.model).toBe('haiku')
  })
})

describe('C003-8 router-config.json ausente o corrupto → valores por defecto seguros', () => {
  const broken: Array<[string, string]> = [
    ['JSON truncado', '{"riskKeywords": ['],
    ['vacío', ''],
    ['null', 'null'],
    ['arreglo', '[]'],
    ['texto binario', '\u0000\u0001\u0002 no es json'],
    ['riskKeywords vaciada a mano', JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, riskKeywords: [] })],
    ['campo extra a mano', JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, floor: 'haiku' })],
    [
      'rol→modelo inválido',
      JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, roleDefaults: { qa: 'x' } }),
    ],
  ]

  it.each(broken)(
    '%s: el motor arranca, usa los defaults y el piso de riesgo sigue',
    async (_n, content) => {
      const dataDir = tempDir('cdm-corrupt-')
      fs.writeFileSync(path.join(dataDir, ROUTER_CONFIG_FILE_NAME), content)
      const runner = new FakeAgentRunner()
      const { agentId } = await start(runner, {}, dataDir)
      const got = await eng().http('GET', '/router/config')
      expect(got.status).toBe(200)
      expect(got.body.config).toEqual(DEFAULT_ROUTER_CONFIG)
      await runTask(agentId, { prompt: 'Cambia el color del token' })
      await runTask(agentId, { prompt: TRIVIAL })
      expect(runner.calls.map((c) => c.model)).toEqual(['sonnet', 'haiku'])
      // Un PUT válido repara el archivo.
      const fixed = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: ['boton'] }
      expect((await eng().http('PUT', '/router/config', fixed)).status).toBe(200)
      expect(
        JSON.parse(fs.readFileSync(path.join(dataDir, ROUTER_CONFIG_FILE_NAME), 'utf8')),
      ).toEqual(fixed)
    },
  )

  it('archivo ausente: usa los defaults y no crea el archivo al leer', async () => {
    await start()
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(fs.existsSync(path.join(eng().dataDir, ROUTER_CONFIG_FILE_NAME))).toBe(false)
  })

  it('archivo de más de 256 KB: se ignora y se usan los defaults', async () => {
    const dataDir = tempDir('cdm-bigcfg-')
    fs.writeFileSync(
      path.join(dataDir, ROUTER_CONFIG_FILE_NAME),
      JSON.stringify({ ...DEFAULT_ROUTER_CONFIG, pad: 'x'.repeat(300 * 1024) }),
    )
    await start(new FakeAgentRunner(), {}, dataDir, false)
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(DEFAULT_ROUTER_CONFIG)
  })
})

describe('C003-7 reintentos por HTTP', () => {
  it('cadena haiku → haiku → sonnet → opus → opus, y tras un éxito la cadena se reinicia', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue(FAIL).enqueue(FAIL).enqueue(FAIL).enqueue(FAIL)
    let last = await runTask(agentId, { prompt: TRIVIAL })
    for (let i = 0; i < 4; i++) last = await retry(agentId, last)
    // Éxito (guion por defecto): la última ejecución terminó bien.
    expect(runner.calls.map((c) => c.model)).toEqual(['haiku', 'haiku', 'sonnet', 'opus', 'opus'])
    const detail = await eng().http('GET', `/agents/${agentId}`)
    expect(detail.body.lastRun).toMatchObject({ status: 'done', model: 'opus' })

    // Tarea nueva tras el éxito: vuelve a empezar (haiku, 0 fallos), y un nuevo fallo → reintento sin escalar.
    runner.enqueue(FAIL)
    const fresh = await runTask(agentId, { prompt: TRIVIAL })
    const again = await retry(agentId, fresh)
    expect(runner.calls.slice(5).map((c) => c.model)).toEqual(['haiku', 'haiku'])
    const decision = await sock().waitFor((e) => e.type === 'router.decision' && e.runId === again)
    expect(decision).toMatchObject({ consecutiveFailures: 1, decision: { source: 'rule' } })
  })

  it('el reintento reutiliza el prompt original y no cambia el prompt aunque se envíe otro modelo', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue(FAIL)
    const first = await runTask(agentId, { prompt: LARGE })
    await retry(agentId, first, { model: 'sonnet' })
    expect(runner.calls[1]).toMatchObject({ prompt: LARGE, model: 'sonnet' })
    expect(runner.calls[1]?.resume).toBeUndefined()
  })

  it('C003-6 reintento con modelo inexistente o campo extra → 400 y no lanza nada', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue(FAIL)
    const first = await runTask(agentId, { prompt: TRIVIAL })
    for (const body of [{ model: 'gpt-5' }, { model: 'haiku', prompt: 'otro' }, { model: 7 }]) {
      const res = await eng().http('POST', `/agents/${agentId}/tasks/${first}/retry`, body)
      expect(res.status).toBe(400)
      expect(res.text).not.toMatch(/at .*\.ts|node_modules|\bstack\b/i)
    }
    expect(runner.calls).toHaveLength(1)
  })

  it('reintentar una ejecución que terminó bien → 409 y no lanza nada', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    const ok = await runTask(agentId, { prompt: TRIVIAL })
    const res = await eng().http('POST', `/agents/${agentId}/tasks/${ok}/retry`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
    expect(runner.calls).toHaveLength(1)
  })

  it('reintentar una ejecución en curso → 409', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue([{ type: 'hold' }])
    const res = await eng().http('POST', `/agents/${agentId}/tasks`, { prompt: TRIVIAL })
    const running = res.body.runId as string
    await sleep(20)
    const r = await eng().http('POST', `/agents/${agentId}/tasks/${running}/retry`)
    expect(r.status).toBe(409)
    runner.release()
    await sock().waitFor(ended(running))
  })

  it('reintentar una ejecución vieja (no la última) → 409', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue(FAIL)
    const failed = await runTask(agentId, { prompt: TRIVIAL })
    await runTask(agentId, { prompt: TRIVIAL })
    const res = await eng().http('POST', `/agents/${agentId}/tasks/${failed}/retry`)
    expect(res.status).toBe(409)
    expect(runner.calls).toHaveLength(2)
  })

  it('reintentar la ejecución de otro agente → 404 (no filtra que existe) y no lanza nada', async () => {
    const runner = new FakeAgentRunner()
    const { agentId, projectId } = await start(runner)
    const other = await eng().http('POST', '/agents', { name: 'Otra', role: 'qa', projectId })
    const otherId = other.body.agent.id as string
    runner.enqueue(FAIL)
    const failed = await runTask(agentId, { prompt: TRIVIAL })
    const res = await eng().http('POST', `/agents/${otherId}/tasks/${failed}/retry`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(runner.calls).toHaveLength(1)
    // El agente dueño sí puede.
    expect((await eng().http('POST', `/agents/${agentId}/tasks/${failed}/retry`)).status).toBe(202)
    await sock().waitFor((e) => e.type === 'router.decision' && e.runId !== failed)
  })

  it('reintentar con un agente inexistente → 404', async () => {
    const { agentId } = await start()
    const failedId = await runTask(agentId, { prompt: TRIVIAL })
    const res = await eng().http(
      'POST',
      `/agents/01ARZ3NDEKTSV4RRFFQ69G5FAV/tasks/${failedId}/retry`,
    )
    expect(res.status).toBe(404)
  })
})

describe('C003-7 reanudar no re-enruta', () => {
  it('pausar y reanudar conserva el modelo y no emite un segundo router.decision', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue([
      { type: 'session', sessionId: 's1' },
      { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0.01, contextUsedPct: 1 },
      { type: 'hold' },
    ])
    const started = await eng().http('POST', `/agents/${agentId}/tasks`, { prompt: LARGE })
    await sleep(30)
    expect((await eng().http('POST', `/agents/${agentId}/pause`)).status).toBe(200)
    // La config cambia entre la pausa y la reanudación: no debe re-enrutar.
    const next = { ...DEFAULT_ROUTER_CONFIG, largeKeywords: ['zzz'] }
    expect((await eng().http('PUT', '/router/config', next)).status).toBe(200)
    const resumed = await eng().http('POST', `/agents/${agentId}/resume`, {
      prompt: 'Sigue con el color',
    })
    expect(resumed.status).toBe(202)
    await sock().waitFor(ended(resumed.body.runId))
    expect(runner.calls[1]).toMatchObject({ model: 'opus', resume: 's1' })
    const decisions = sock().events.filter((e) => e.type === 'router.decision')
    expect(decisions.map((e) => e.runId)).toEqual([started.body.runId])
  })
})

describe('C003-9 GET /router/stats casos límite', () => {
  async function seedAgent(workspace: string) {
    const store = eng().store
    const project = store.createProject(workspace, `P-${workspace}`, eng().projectDir)
    return store.createAgent(workspace, {
      projectId: project.id,
      name: `A-${workspace}`,
      role: 'qa',
      defaultModel: 'sonnet',
    })
  }
  async function addRun(
    workspace: string,
    agentId: string,
    model: 'haiku' | 'sonnet' | 'opus',
    costUsd: number | null,
    resumed = false,
  ) {
    const store = eng().store
    await sleep(4) // orden estable por startedAt
    const run = store.createRun(workspace, agentId, 'x', model, resumed)
    if (costUsd !== null) {
      store.setRunTotals(workspace, run.id, {
        inputTokens: 1,
        outputTokens: 1,
        costUsd,
        contextUsedPct: 1,
      })
    }
    return run
  }

  it('sin ejecuciones: tres modelos en cero', async () => {
    await start()
    const res = await eng().http('GET', '/router/stats')
    expect(res.body.stats).toEqual({
      models: [
        { model: 'haiku', runs: 0, costUsd: 0, runsWithoutCost: 0 },
        { model: 'sonnet', runs: 0, costUsd: 0, runsWithoutCost: 0 },
        { model: 'opus', runs: 0, costUsd: 0, runsWithoutCost: 0 },
      ],
      totalRuns: 0,
      totalCostUsd: 0,
    })
  })

  it('aislamiento por workspace: otro workspace no suma ni resta', async () => {
    await start(new FakeAgentRunner(), {}, undefined, false)
    const mine = await seedAgent('local')
    const theirs = await seedAgent('otro')
    await addRun('local', mine.id, 'haiku', 0.25)
    await addRun('otro', theirs.id, 'haiku', 100)
    await addRun('otro', theirs.id, 'opus', 100)
    const res = await eng().http('GET', '/router/stats')
    expect(res.body.stats.models[0]).toEqual({
      model: 'haiku',
      runs: 1,
      costUsd: 0.25,
      runsWithoutCost: 0,
    })
    expect(res.body.stats).toMatchObject({ totalRuns: 1, totalCostUsd: 0.25 })
  })

  it('reanudaciones: el costo acumulado de la sesión no se cuenta doble', async () => {
    await start(new FakeAgentRunner(), {}, undefined, false)
    const agent = await seedAgent('local')
    await addRun('local', agent.id, 'opus', 0.3)
    await addRun('local', agent.id, 'opus', 0.5, true) // acumulado: +0.2
    await addRun('local', agent.id, 'opus', 0.5, true) // sin gasto nuevo: +0
    const res = await eng().http('GET', '/router/stats')
    const opus = res.body.stats.models.find((m: { model: string }) => m.model === 'opus')
    expect(opus).toMatchObject({ runs: 3, costUsd: 0.5 })
    expect(res.body.stats.totalCostUsd).toBe(0.5)
  })

  it('ejecuciones sin costo se cuentan aparte y no suman ni rompen el total', async () => {
    await start(new FakeAgentRunner(), {}, undefined, false)
    const agent = await seedAgent('local')
    await addRun('local', agent.id, 'sonnet', null)
    await addRun('local', agent.id, 'sonnet', 0.1)
    await addRun('local', agent.id, 'haiku', null)
    const res = await eng().http('GET', '/router/stats')
    expect(res.body.stats.models).toEqual([
      { model: 'haiku', runs: 1, costUsd: 0, runsWithoutCost: 1 },
      { model: 'sonnet', runs: 2, costUsd: 0.1, runsWithoutCost: 1 },
      { model: 'opus', runs: 0, costUsd: 0, runsWithoutCost: 0 },
    ])
    expect(res.body.stats).toMatchObject({ totalRuns: 3, totalCostUsd: 0.1 })
  })

  it('un reintento fallido sin costo cuenta como ejecución del modelo con el que corrió', async () => {
    const runner = new FakeAgentRunner()
    const { agentId } = await start(runner)
    runner.enqueue(FAIL).enqueue(FAIL)
    const first = await runTask(agentId, { prompt: TRIVIAL })
    const second = await retry(agentId, first)
    await retry(agentId, second)
    const res = await eng().http('GET', '/router/stats')
    const byModel = Object.fromEntries(
      res.body.stats.models.map((m: { model: string; runs: number }) => [m.model, m.runs]),
    )
    expect(byModel).toEqual({ haiku: 2, sonnet: 1, opus: 0 })
    expect(res.body.stats.totalRuns).toBe(3)
  })
})

describe('C003-8 límites de tasa', () => {
  it('un PUT bloqueado por el límite (429) no modifica la configuración', async () => {
    // createProjectAndAgent consume 2 escrituras.
    await start(new FakeAgentRunner(), { rateLimitWritesPerMin: 3 })
    const first = { ...DEFAULT_ROUTER_CONFIG, smallKeywords: ['uno'] }
    expect((await eng().http('PUT', '/router/config', first)).status).toBe(200)
    const blocked = await eng().http('PUT', '/router/config', {
      ...DEFAULT_ROUTER_CONFIG,
      smallKeywords: ['dos'],
    })
    expect(blocked.status).toBe(429)
    expect((await eng().http('GET', '/router/config')).body.config).toEqual(first)
  })

  it('un PUT inválido también consume escritura (el límite va antes de validar)', async () => {
    await start(new FakeAgentRunner(), { rateLimitWritesPerMin: 3 })
    expect((await eng().http('PUT', '/router/config', { nada: 1 })).status).toBe(400)
    expect((await eng().http('PUT', '/router/config', DEFAULT_ROUTER_CONFIG)).status).toBe(429)
  })

  it('el retry no consume del cupo de escrituras y el cupo por agente es independiente por agente', async () => {
    const runner = new FakeAgentRunner()
    const { agentId, projectId } = await start(runner, {
      rateLimitAgentActionsPerMin: 2,
      rateLimitWritesPerMin: 100,
    })
    const other = await eng().http('POST', '/agents', { name: 'B', role: 'qa', projectId })
    const otherId = other.body.agent.id as string
    runner.enqueue(FAIL).enqueue(FAIL)
    const a1 = await runTask(agentId, { prompt: TRIVIAL }) // acción 1 del agente A
    const a2 = await retry(agentId, a1) // acción 2 del agente A
    expect((await eng().http('POST', `/agents/${agentId}/tasks/${a2}/retry`)).status).toBe(429)
    // El otro agente conserva su cupo propio.
    const b1 = await runTask(otherId, { prompt: TRIVIAL })
    expect(b1).toBeTruthy()
    // Las escrituras generales siguen disponibles.
    expect((await eng().http('PUT', '/router/config', DEFAULT_ROUTER_CONFIG)).status).toBe(200)
  })

  it('un retry rechazado por validación (400) o no encontrado (404) también cuenta como acción del agente', async () => {
    const { agentId } = await start(new FakeAgentRunner(), { rateLimitAgentActionsPerMin: 2 })
    const missing = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect((await eng().http('POST', `/agents/${agentId}/tasks/${missing}/retry`)).status).toBe(404)
    expect((await eng().http('POST', `/agents/${agentId}/tasks/${missing}/retry`)).status).toBe(404)
    expect((await eng().http('POST', `/agents/${agentId}/tasks/${missing}/retry`)).status).toBe(429)
  })
})
