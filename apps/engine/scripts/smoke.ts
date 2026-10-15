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
  let onDone: ((runId: string) => void) | undefined
  ws.on('message', (data) => {
    const e = JSON.parse(data.toString()) as EngineEvent
    events.push(e)
    if (e.type === 'agent.status' && e.status === 'done') onDone?.(e.runId)
  })

  const { project } = await post('/projects', { name: 'Humo', path: projectDir })
  const { agent } = await post('/agents', { name: 'Humo', role: 'qa', projectId: project.id })

  // Enrutador (feature 003): trivial → haiku, sin señales → modelo del rol (qa → sonnet),
  // grande → opus. Una tarea a la vez (el agente no acepta dos simultáneas).
  const cases = [
    { prompt: 'Cambia el color del botón a azul', model: 'haiku', source: 'rule' },
    { prompt: 'Prueba de humo', model: 'sonnet', source: 'role_default' },
    { prompt: 'Diseña la arquitectura del módulo de reportes', model: 'opus', source: 'rule' },
  ] as const
  for (const c of cases) {
    const finished = new Promise<string>((resolve) => {
      onDone = resolve
    })
    const { runId } = await post(`/agents/${agent.id}/tasks`, { prompt: c.prompt })
    await Promise.race([
      finished.then((id) => (id === runId ? undefined : fail('done de otra ejecución'))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]).catch(() => fail(`no llegó agent.status = done para "${c.prompt}"`))

    const mine = events.filter((e) => e.runId === runId)
    const seq = mine.map((e) => e.type)
    const first = mine[0]
    if (first?.type !== 'agent.status' || first.status !== 'thinking') {
      fail(`primer evento incorrecto: ${seq.join(', ')}`)
    }
    const decision = mine[1]
    if (decision?.type !== 'router.decision') {
      fail(`se esperaba router.decision tras agent.status = thinking: ${seq.join(', ')}`)
    }
    if (decision.decision.model !== c.model || decision.decision.source !== c.source) {
      fail(
        `"${c.prompt}" → ${decision.decision.model} (${decision.decision.source}); se esperaba ${c.model} (${c.source})`,
      )
    }
    if (seq.at(-2) !== 'agent.usage')
      fail(`se esperaba agent.usage antes de done: ${seq.join(', ')}`)
    console.log(`✓ humo OK (${c.model}): ${seq.join(' → ')}`)
  }
  ws.close()
} finally {
  await app.close()
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
