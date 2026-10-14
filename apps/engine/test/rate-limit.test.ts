import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeAgentRunner } from '../src/agents/fake-runner.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/client.ts'
import { createStore } from '../src/db/store.ts'
import { getOrCreateLocalToken } from '../src/security/local-token.ts'
import { buildServer } from '../src/server.ts'
import { tempDir, UI_ORIGIN } from './helpers.ts'

interface Res {
  status: number
  body: any
  headers: Headers
}

interface Ctx {
  http(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<Res>
  advance(ms: number): void
  runner: FakeAgentRunner
  projectDir: string
  close(): Promise<void>
}

let ctx: Ctx | undefined
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

/** Como `startTestEngine`, pero con reloj falso (el helper no admite `now`). */
async function start(
  limits: { writes?: number; actions?: number } = {},
  script?: ConstructorParameters<typeof FakeAgentRunner>[0],
): Promise<Ctx> {
  const dataDir = tempDir()
  const projectDir = fs.mkdtempSync(path.join(dataDir, 'proyecto-'))
  const config = {
    ...loadConfig({ CDM_DATA_DIR: dataDir, CDM_UI_ORIGIN: UI_ORIGIN }),
    rateLimitWritesPerMin: limits.writes ?? 1000,
    rateLimitAgentActionsPerMin: limits.actions ?? 1000,
  }
  const db = openDb(path.join(dataDir, 'data.db'))
  const store = createStore(db.db)
  const token = getOrCreateLocalToken(dataDir)
  const runner = new FakeAgentRunner(script)
  let t = 5_000_000
  const engine = await buildServer({
    config,
    store,
    runner,
    token,
    logLevel: 'silent',
    now: () => t,
  })
  await engine.app.listen({ host: '127.0.0.1', port: 0 })
  const address = engine.app.server.address()
  if (!address || typeof address === 'string') throw new Error('sin dirección')
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    runner,
    projectDir,
    advance: (ms) => {
      t += ms
    },
    async http(method, url, body, headers = {}) {
      const res = await fetch(baseUrl + url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
    },
    async close() {
      await engine.app.close()
      db.close()
    },
  }
}

async function newProject(c: Ctx) {
  const r = await c.http('POST', '/projects', { name: 'P', path: c.projectDir })
  if (r.status !== 201) throw new Error(`proyecto: ${JSON.stringify(r.body)}`)
  return r.body.project.id as string
}

async function newAgent(c: Ctx, projectId: string, name: string) {
  const r = await c.http('POST', '/agents', { name, role: 'implementador', projectId })
  if (r.status !== 201) throw new Error(`agente: ${JSON.stringify(r.body)}`)
  return r.body.agent.id as string
}

function expectRateLimited(res: Res) {
  expect(res.status).toBe(429)
  expect(res.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
  const retry = Number(res.headers.get('retry-after'))
  expect(Number.isInteger(retry)).toBe(true)
  expect(retry).toBeGreaterThanOrEqual(1)
  expect(retry).toBeLessThanOrEqual(60)
}

describe('Rate limit general (escrituras)', () => {
  it('POST /projects devuelve 429 con Retry-After al superar el límite', async () => {
    ctx = await start({ writes: 3 })
    for (let i = 0; i < 3; i++) {
      // Cuerpo inválido: consume cupo igualmente porque el límite corre antes de validar.
      expect((await ctx.http('POST', '/projects', {})).status).toBe(400)
    }
    expectRateLimited(await ctx.http('POST', '/projects', {}))
  })

  it('POST /agents devuelve 429 al superar el límite', async () => {
    ctx = await start({ writes: 3 })
    const projectId = await newProject(ctx)
    await newAgent(ctx, projectId, 'A')
    await newAgent(ctx, projectId, 'B')
    expectRateLimited(
      await ctx.http('POST', '/agents', { name: 'C', role: 'implementador', projectId }),
    )
  })

  it('DELETE /agents/:id comparte el cupo de escrituras', async () => {
    ctx = await start({ writes: 2 })
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    expectRateLimited(await ctx.http('DELETE', `/agents/${id}`))
  })

  it('los GET no se limitan', async () => {
    ctx = await start({ writes: 1, actions: 1 })
    await newProject(ctx)
    for (let i = 0; i < 30; i++) {
      expect((await ctx.http('GET', '/projects')).status).toBe(200)
      expect((await ctx.http('GET', '/agents')).status).toBe(200)
      expect((await ctx.http('GET', '/health')).status).toBe(200)
    }
  })

  it('se recupera tras la ventana con el reloj falso', async () => {
    ctx = await start({ writes: 2 })
    await ctx.http('POST', '/projects', {})
    await ctx.http('POST', '/projects', {})
    expectRateLimited(await ctx.http('POST', '/projects', {}))
    ctx.advance(59_000)
    expect((await ctx.http('POST', '/projects', {})).status).toBe(429)
    ctx.advance(1_001)
    expect((await ctx.http('POST', '/projects', {})).status).toBe(400)
  })
})

describe('Rate limit por agente (acciones)', () => {
  it('POST /agents/:id/tasks devuelve 429 al superar el límite', async () => {
    ctx = await start({ actions: 2 })
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    for (let i = 0; i < 2; i++) {
      expect((await ctx.http('POST', `/agents/${id}/tasks`, {})).status).toBe(400)
    }
    expectRateLimited(await ctx.http('POST', `/agents/${id}/tasks`, { prompt: 'x' }))
    expect(ctx.runner.calls).toHaveLength(0)
  })

  it('pause, resume y stop comparten el cupo del agente', async () => {
    ctx = await start({ actions: 3 })
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    await ctx.http('POST', `/agents/${id}/pause`)
    await ctx.http('POST', `/agents/${id}/resume`, {})
    await ctx.http('POST', `/agents/${id}/stop`)
    expectRateLimited(await ctx.http('POST', `/agents/${id}/stop`))
  })

  it('es independiente entre agentes', async () => {
    ctx = await start({ actions: 2 })
    const projectId = await newProject(ctx)
    const a = await newAgent(ctx, projectId, 'A')
    const b = await newAgent(ctx, projectId, 'B')
    await ctx.http('POST', `/agents/${a}/stop`)
    await ctx.http('POST', `/agents/${a}/stop`)
    expectRateLimited(await ctx.http('POST', `/agents/${a}/stop`))
    expect((await ctx.http('POST', `/agents/${b}/stop`)).status).not.toBe(429)
    expect((await ctx.http('POST', `/agents/${b}/stop`)).status).not.toBe(429)
    expectRateLimited(await ctx.http('POST', `/agents/${b}/stop`))
  })

  it('las acciones de agente no consumen el cupo general y viceversa', async () => {
    ctx = await start({ actions: 100, writes: 2 })
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    for (let i = 0; i < 5; i++) await ctx.http('POST', `/agents/${id}/stop`)
    expectRateLimited(await ctx.http('POST', '/projects', {}))
  })

  it('start/stop en bucle no lanza más procesos que el límite', async () => {
    const limit = 6
    ctx = await start({ actions: limit }, [{ type: 'hold' }])
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    let rejected = 0
    for (let i = 0; i < 20; i++) {
      const started = await ctx.http('POST', `/agents/${id}/tasks`, { prompt: `t${i}` })
      const stopped = await ctx.http('POST', `/agents/${id}/stop`)
      if (started.status === 429) rejected++
      if (stopped.status === 429) rejected++
    }
    expect(rejected).toBeGreaterThan(0)
    expect(ctx.runner.calls.length).toBeGreaterThan(0)
    expect(ctx.runner.calls.length).toBeLessThanOrEqual(limit)
  })

  it('se recupera tras la ventana con el reloj falso', async () => {
    ctx = await start({ actions: 1 })
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    expect((await ctx.http('POST', `/agents/${id}/stop`)).status).not.toBe(429)
    expectRateLimited(await ctx.http('POST', `/agents/${id}/stop`))
    ctx.advance(60_000)
    expect((await ctx.http('POST', `/agents/${id}/stop`)).status).not.toBe(429)
  })
})

describe('Las peticiones rechazadas por seguridad no consumen cupo', () => {
  it('401 sin token no consume el cupo general', async () => {
    ctx = await start({ writes: 1 })
    for (let i = 0; i < 5; i++) {
      expect((await ctx.http('POST', '/projects', {}, { authorization: '' })).status).toBe(401)
    }
    expect((await ctx.http('POST', '/projects', { name: 'P', path: ctx.projectDir })).status).toBe(
      201,
    )
  })

  it('401 sin token no consume el cupo del agente', async () => {
    ctx = await start({ actions: 1 })
    const id = await newAgent(ctx, await newProject(ctx), 'A')
    for (let i = 0; i < 5; i++) {
      const r = await ctx.http('POST', `/agents/${id}/stop`, undefined, { authorization: '' })
      expect(r.status).toBe(401)
    }
    expect((await ctx.http('POST', `/agents/${id}/stop`)).status).not.toBe(429)
  })

  it('403 con Origin ajeno no consume cupo', async () => {
    ctx = await start({ writes: 1, actions: 1 })
    const evil = { origin: 'https://evil.example' }
    for (let i = 0; i < 5; i++) {
      expect((await ctx.http('POST', '/projects', {}, evil)).status).toBe(403)
      expect((await ctx.http('POST', '/agents/abc/stop', undefined, evil)).status).toBe(403)
    }
    expect((await ctx.http('POST', '/projects', { name: 'P', path: ctx.projectDir })).status).toBe(
      201,
    )
    expectRateLimited(await ctx.http('POST', '/projects', {}))
  })
})
