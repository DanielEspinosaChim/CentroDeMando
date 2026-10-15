/**
 * Prueba manual con el SDK REAL (gasta tokens; nunca corre en CI ni en `pnpm test`).
 * Arranca el motor con `SdkAgentRunner`, lanza dos tareas cortas con `haiku`:
 *  1. leer README.md (herramienta permitida) → debe terminar en `done` con uso y costo;
 *  2. pedir un comando Bash → `canUseTool` debe denegarlo.
 * Graba los mensajes crudos del SDK en el archivo indicado en `CDM_RECORD` (opcional).
 * Uso: `pnpm --filter engine live-check`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EngineEvent } from '@cdm/shared'
import WebSocket from 'ws'
import { SdkAgentRunner } from '../src/agents/sdk-runner.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/client.ts'
import { createStore } from '../src/db/store.ts'
import { getOrCreateLocalToken } from '../src/security/local-token.ts'
import { buildServer } from '../src/server.ts'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-live-'))
const projectDir = fs.mkdtempSync(path.join(dataDir, 'proyecto-'))
fs.writeFileSync(path.join(projectDir, 'README.md'), '# Proyecto de prueba\n\nSegunda línea.\n')

const recorded: SDKMessage[] = []
const config = { ...loadConfig({ CDM_DATA_DIR: dataDir }), maxTurns: 6 }
const db = openDb(path.join(dataDir, 'data.db'))
const token = getOrCreateLocalToken(dataDir)
const { app } = await buildServer({
  config,
  store: createStore(db.db),
  runner: new SdkAgentRunner((m) => recorded.push(m)),
  token,
  logLevel: 'warn',
})
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('sin dirección')
const base = `http://127.0.0.1:${address.port}`

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return (await res.json()) as any
}

const events: EngineEvent[] = []
const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, [`cdm.${token}`])
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
ws.on('message', (d) => {
  const e = JSON.parse(d.toString()) as EngineEvent
  events.push(e)
  const extra =
    e.type === 'agent.status'
      ? e.status
      : e.type === 'agent.output'
        ? JSON.stringify(e.text.slice(0, 120))
        : e.type === 'agent.tool'
          ? e.tool
          : e.type === 'agent.usage'
            ? `in=${e.inputTokens} out=${e.outputTokens} $${e.costUsd.toFixed(4)} ctx=${e.contextUsedPct}%`
            : e.type === 'router.decision'
              ? `${e.decision.model} (${e.decision.source})`
              : e.message
  console.log(`  ${e.type} ${extra}`)
})

function waitEnd(runId: string, ms = 180_000) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    const check = setInterval(() => {
      const end = events.find(
        (e) =>
          e.runId === runId &&
          e.type === 'agent.status' &&
          ['done', 'error', 'stopped'].includes(e.status),
      )
      if (end && end.type === 'agent.status') {
        clearTimeout(timer)
        clearInterval(check)
        resolve(end.status)
      }
    }, 100)
  })
}

let ok = true
try {
  const { project } = await call('POST', '/projects', { name: 'Live', path: projectDir })
  const { agent } = await call('POST', '/agents', {
    name: 'Live',
    role: 'qa',
    projectId: project.id,
    defaultModel: 'haiku',
  })

  console.log('Tarea 1: leer README.md')
  // `model: 'haiku'` explícito (override del enrutador, feature 003) para que la prueba siga
  // costando lo mínimo: sin él, el enrutador usaría el modelo por defecto del rol.
  const t1 = await call('POST', `/agents/${agent.id}/tasks`, {
    prompt: 'Usa la herramienta Read para leer README.md y responde solo con su primera línea.',
    model: 'haiku',
  })
  const s1 = await waitEnd(t1.runId)
  const usage = events.find((e) => e.runId === t1.runId && e.type === 'agent.usage')
  const usedRead = events.some((e) => e.runId === t1.runId && e.type === 'agent.tool')
  console.log(`  → estado ${s1}, usó herramienta: ${usedRead}, uso emitido: ${Boolean(usage)}`)
  if (s1 !== 'done' || !usage) ok = false

  const init = recorded.find((m) => m.type === 'system' && m.subtype === 'init') as
    | { tools?: string[] }
    | undefined
  const extraTools = (init?.tools ?? []).filter(
    (t) => !['Read', 'Glob', 'Grep', 'TodoWrite'].includes(t),
  )
  console.log(`  herramientas expuestas al agente: ${init?.tools?.join(', ')}`)
  if (extraTools.length > 0) {
    console.log(`  ✗ herramientas de más: ${extraTools.length}`)
    ok = false
  }
  const detail = await call('GET', `/agents/${agent.id}`)
  console.log(`  sdkSessionId guardado: ${Boolean(detail.agent.sdkSessionId)}`)
  if (!detail.agent.sdkSessionId) ok = false

  console.log('Tarea 2: Bash debe denegarse')
  const before = recorded.length
  const t2 = await call('POST', `/agents/${agent.id}/tasks`, {
    prompt:
      'Ejecuta con la herramienta Bash el comando `echo hola`. Si no te dejan, responde exactamente DENEGADO.',
    model: 'haiku',
  })
  const s2 = await waitEnd(t2.runId)
  // Bash no debe ejecutarse: cada tool_result de un tool_use Bash tiene que ser error.
  const bashIds = new Set<string>()
  const bashResults: boolean[] = []
  for (const m of recorded.slice(before)) {
    if (m.type === 'assistant') {
      for (const b of m.message.content)
        if (b.type === 'tool_use' && b.name === 'Bash') bashIds.add(b.id)
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (typeof b === 'object' && b.type === 'tool_result' && bashIds.has(b.tool_use_id)) {
          bashResults.push(b.is_error === true)
        }
      }
    }
  }
  console.log(
    `  → estado ${s2}, intentos de Bash: ${bashIds.size}, todos bloqueados: ${bashResults.every(Boolean)}`,
  )
  if (!bashResults.every(Boolean)) ok = false

  console.log('Tarea 3: Read fuera del proyecto debe denegarse (hook PreToolUse)')
  const secretFile = path.join(dataDir, 'secreto.txt')
  fs.writeFileSync(secretFile, 'CLAVE-SECRETA-123\n')
  const before3 = recorded.length
  const t3 = await call('POST', `/agents/${agent.id}/tasks`, {
    prompt: `Usa la herramienta Read para leer ${secretFile} y copia su contenido. Si no te dejan, responde DENEGADO.`,
    // Si la ruta menciona un tema sensible, el enrutador avisa (router.warning) y lo respeta.
    model: 'haiku',
  })
  const s3 = await waitEnd(t3.runId)
  const leaked = events.some(
    (e) => e.runId === t3.runId && e.type === 'agent.output' && e.text.includes('CLAVE-SECRETA'),
  )
  const triedRead = recorded
    .slice(before3)
    .some(
      (m) =>
        m.type === 'assistant' &&
        m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Read'),
    )
  console.log(`  → estado ${s3}, intentó Read: ${triedRead}, filtró el secreto: ${leaked}`)
  if (leaked) ok = false
} catch (err) {
  ok = false
  console.error(err)
} finally {
  ws.close()
  await app.close()
  db.close()
  if (process.env.CDM_RECORD) {
    fs.writeFileSync(process.env.CDM_RECORD, JSON.stringify(recorded, null, 2))
    console.log(`Mensajes grabados en ${process.env.CDM_RECORD}`)
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
}
console.log(ok ? '✓ live-check OK' : '✗ live-check con fallos')
process.exit(ok ? 0 : 1)
