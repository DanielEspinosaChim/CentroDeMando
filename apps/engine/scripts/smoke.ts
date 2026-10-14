/**
 * Prueba de humo: arranca el motor con `FakeAgentRunner` (sin gastar tokens),
 * lanza una tarea por HTTP y verifica la secuencia de eventos por WebSocket.
 * Uso: `pnpm --filter engine smoke`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineEvent } from '@cdm/shared'
import WebSocket from 'ws'
import { FakeAgentRunner } from '../src/agents/fake-runner.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/client.ts'
import { createStore } from '../src/db/store.ts'
import { getOrCreateLocalToken } from '../src/security/local-token.ts'
import { buildServer } from '../src/server.ts'

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-smoke-'))
const projectDir = fs.mkdtempSync(path.join(dataDir, 'proyecto-'))
const config = loadConfig({ CDM_DATA_DIR: dataDir })
const db = openDb(path.join(dataDir, 'data.db'))
const token = getOrCreateLocalToken(dataDir)
const { app } = await buildServer({
  config,
  store: createStore(db.db),
  runner: new FakeAgentRunner(),
  token,
  logLevel: 'warn',
})
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') fail('sin dirección')
const base = `http://127.0.0.1:${address.port}`

async function post(url: string, body: unknown) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as any
  if (!res.ok) fail(`${url} → ${res.status} ${JSON.stringify(json)}`)
  return json
}

try {
  const events: EngineEvent[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, [`cdm.${token}`])
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const done = new Promise<void>((resolve) => {
    ws.on('message', (data) => {
      const e = JSON.parse(data.toString()) as EngineEvent
      events.push(e)
      if (e.type === 'agent.status' && e.status === 'done') resolve()
    })
  })

  const { project } = await post('/projects', { name: 'Humo', path: projectDir })
  const { agent } = await post('/agents', { name: 'Humo', role: 'qa', projectId: project.id })
  const { runId } = await post(`/agents/${agent.id}/tasks`, { prompt: 'Prueba de humo' })

  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
  ]).catch(() => fail('no llegó agent.status = done'))

  const seq = events.filter((e) => e.runId === runId).map((e) => e.type)
  const first = events[0]
  if (first?.type !== 'agent.status' || first.status !== 'thinking')
    fail('primer evento incorrecto')
  if (seq.at(-2) !== 'agent.usage') fail(`se esperaba agent.usage antes de done: ${seq.join(', ')}`)
  console.log(`✓ humo OK: ${seq.join(' → ')}`)
  ws.close()
} finally {
  await app.close()
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
