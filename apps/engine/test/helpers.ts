import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { EngineEvent } from '@cdm/shared'
import WebSocket from 'ws'
import type { AgentRunner } from '../src/agents/runner.ts'
import { type EngineConfig, loadConfig } from '../src/config.ts'
import { type DbHandle, openDb } from '../src/db/client.ts'
import { createStore, type Store } from '../src/db/store.ts'
import { getOrCreateLocalToken } from '../src/security/local-token.ts'
import { buildServer, type Engine } from '../src/server.ts'

export const UI_ORIGIN = 'http://localhost:5173'

export function tempDir(prefix = 'cdm-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export interface TestEngine extends Engine {
  baseUrl: string
  wsUrl: string
  token: string
  store: Store
  db: DbHandle
  dataDir: string
  projectDir: string
  /** Todo lo que escribió el logger. */
  logs(): string
  http(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any; text: string }>
  close(): Promise<void>
}

export async function startTestEngine(opts: {
  runner: AgentRunner
  config?: Partial<EngineConfig>
  dataDir?: string
}): Promise<TestEngine> {
  const dataDir = opts.dataDir ?? tempDir()
  const projectDir = fs.mkdtempSync(path.join(dataDir, 'proyecto-'))
  const config: EngineConfig = {
    ...loadConfig({ CDM_DATA_DIR: dataDir, CDM_UI_ORIGIN: UI_ORIGIN }),
    ...opts.config,
  }
  const db = openDb(path.join(dataDir, 'data.db'))
  const store = createStore(db.db)
  const token = getOrCreateLocalToken(dataDir)

  const logStream = new PassThrough()
  let logText = ''
  logStream.on('data', (chunk) => {
    logText += chunk.toString()
  })

  const engine = await buildServer({
    config,
    store,
    runner: opts.runner,
    token,
    logStream,
    logLevel: 'trace',
  })
  await engine.app.listen({ host: '127.0.0.1', port: 0 })
  const address = engine.app.server.address()
  if (!address || typeof address === 'string') throw new Error('sin dirección')
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    ...engine,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    token,
    store,
    db,
    dataDir,
    projectDir,
    logs: () => logText,
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
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      return { status: res.status, body: parsed, text }
    },
    async close() {
      await engine.app.close()
      db.close()
    },
  }
}

export interface WsClient {
  events: EngineEvent[]
  waitFor(predicate: (e: EngineEvent) => boolean, timeoutMs?: number): Promise<EngineEvent>
  close(): void
}

export function connectWs(url: string, protocols: string[] = []): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols)
    const events: EngineEvent[] = []
    const waiters: Array<{
      predicate: (e: EngineEvent) => boolean
      resolve: (e: EngineEvent) => void
    }> = []
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString()) as EngineEvent
      events.push(event)
      for (const w of [...waiters]) {
        if (w.predicate(event)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(event)
        }
      }
    })
    ws.once('open', () =>
      resolve({
        events,
        waitFor(predicate, timeoutMs = 3000) {
          const found = events.find(predicate)
          if (found) return Promise.resolve(found)
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timeout esperando evento')), timeoutMs)
            waiters.push({
              predicate,
              resolve: (e) => {
                clearTimeout(timer)
                res(e)
              },
            })
          })
        },
        close: () => ws.close(),
      }),
    )
    ws.once('error', reject)
  })
}

/** Abre un WebSocket y devuelve el código con el que lo cierra el servidor. */
export function wsCloseCode(url: string, protocols: string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols)
    ws.once('close', (code) => resolve(code))
    ws.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0)
      req.destroy()
    })
    ws.once('error', (err) => {
      if (ws.readyState !== WebSocket.CLOSED) reject(err)
    })
  })
}

export async function createProjectAndAgent(engine: TestEngine, name = 'Ana') {
  const project = await engine.http('POST', '/projects', {
    name: 'Proyecto',
    path: engine.projectDir,
  })
  if (project.status !== 201) throw new Error(`proyecto: ${project.text}`)
  const agent = await engine.http('POST', '/agents', {
    name,
    role: 'implementador',
    projectId: project.body.project.id,
  })
  if (agent.status !== 201) throw new Error(`agente: ${agent.text}`)
  return { projectId: project.body.project.id as string, agentId: agent.body.agent.id as string }
}

export const tick = () => new Promise((r) => setTimeout(r, 20))
