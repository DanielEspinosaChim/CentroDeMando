import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, openDb } from './client.ts'
import { createStore } from './store.ts'

describe('migraciones', () => {
  it('una base en la versión 1 sube a la última y sus ejecuciones quedan en workspace local', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    const v1 = new Database(file)
    v1.exec(MIGRATIONS[0] as string)
    v1.pragma('user_version = 1')
    v1.exec(`
      INSERT INTO projects VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ0', 'local', 'P', 'C:/p', 1);
      INSERT INTO agents VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ1', 'local', '01JABCDEFGHJKMNPQRSTVWXYZ0',
        'A', 'qa', 'sonnet', 'done', NULL, 1, 1);
      INSERT INTO runs (id, agent_id, prompt, model, status, started_at)
        VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ2', '01JABCDEFGHJKMNPQRSTVWXYZ1', 'x', 'sonnet', 'done', 1);
    `)
    v1.close()

    const h = openDb(file)
    expect(h.sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const store = createStore(h.db)
    expect(store.lastRun('local', '01JABCDEFGHJKMNPQRSTVWXYZ1')?.id).toBe(
      '01JABCDEFGHJKMNPQRSTVWXYZ2',
    )
    expect(store.lastRun('otro', '01JABCDEFGHJKMNPQRSTVWXYZ1')).toBeUndefined()
    h.close()
  })

  it('una base en la versión 2 sube a la última y añade runs.resumed (por defecto 0)', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(3)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    const v2 = new Database(file)
    v2.exec(MIGRATIONS[0] as string)
    v2.exec(MIGRATIONS[1] as string)
    v2.pragma('user_version = 2')
    v2.exec(`
      INSERT INTO projects VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ0', 'local', 'P', 'C:/p', 1);
      INSERT INTO agents VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ1', 'local', '01JABCDEFGHJKMNPQRSTVWXYZ0',
        'A', 'qa', 'sonnet', 'done', NULL, 1, 1);
      INSERT INTO runs (id, agent_id, prompt, model, status, cost_usd, started_at, workspace_id)
        VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ2', '01JABCDEFGHJKMNPQRSTVWXYZ1', 'x', 'sonnet', 'done',
        0.4, 1, 'local');
    `)
    const before = v2.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    expect(before.map((c) => c.name)).not.toContain('resumed')
    v2.close()

    const h = openDb(file)
    expect(h.sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const columns = h.sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('resumed')
    const row = h.sqlite.prepare('SELECT resumed FROM runs').get() as { resumed: number }
    expect(row.resumed).toBe(0)
    // Las filas previas cuentan como inicio de sesión: la sesión es solo esa ejecución.
    const store = createStore(h.db)
    const agentId = '01JABCDEFGHJKMNPQRSTVWXYZ1'
    expect(store.sessionRunCosts('local', agentId)).toEqual([0.4])
    const run = store.createRun('local', agentId, 'y', 'sonnet', true)
    expect(h.sqlite.prepare('SELECT resumed FROM runs WHERE id = ?').get(run.id)).toEqual({
      resumed: 1,
    })
    h.close()
  })

  it('una base en la versión 3 sube a la última y añade runs.budget_usd (NULL en filas previas)', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    const v3 = new Database(file)
    for (const m of MIGRATIONS.slice(0, 3)) v3.exec(m)
    v3.pragma('user_version = 3')
    v3.exec(`
      INSERT INTO projects VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ0', 'local', 'P', 'C:/p', 1);
      INSERT INTO agents VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ1', 'local', '01JABCDEFGHJKMNPQRSTVWXYZ0',
        'A', 'qa', 'sonnet', 'paused', 'ses', 1, 1);
      INSERT INTO runs (id, agent_id, prompt, model, status, cost_usd, started_at, workspace_id, resumed)
        VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ2', '01JABCDEFGHJKMNPQRSTVWXYZ1', 'x', 'sonnet', 'paused',
        NULL, 1, 'local', 0);
    `)
    const before = v3.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    expect(before.map((c) => c.name)).not.toContain('budget_usd')
    v3.close()

    const h = openDb(file)
    expect(h.sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const columns = h.sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toContain('budget_usd')
    const row = h.sqlite.prepare('SELECT budget_usd FROM runs').get() as {
      budget_usd: number | null
    }
    expect(row.budget_usd).toBeNull()

    const store = createStore(h.db)
    const agentId = '01JABCDEFGHJKMNPQRSTVWXYZ1'
    expect(store.sessionRunSpend('local', agentId)).toEqual([{ costUsd: null, budgetUsd: null }])
    store.createRun('local', agentId, 'y', 'sonnet', true, 0.75)
    expect(store.sessionRunSpend('local', agentId)).toEqual([
      { costUsd: null, budgetUsd: null },
      { costUsd: null, budgetUsd: 0.75 },
    ])
    // Sin presupuesto explícito se guarda NULL.
    store.createRun('local', agentId, 'z', 'sonnet')
    expect(store.lastRun('local', agentId)).not.toHaveProperty('budgetUsd')
    h.close()
  })

  it('una base en la versión 4 sube con las columnas del enrutador (sin decisión en filas previas)', () => {
    // La migración 6 (`end_reason`) llegó después: la base sube hasta la última.
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    const v4 = new Database(file)
    for (const m of MIGRATIONS.slice(0, 4)) v4.exec(m)
    v4.pragma('user_version = 4')
    v4.exec(`
      INSERT INTO projects VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ0', 'local', 'P', 'C:/p', 1);
      INSERT INTO agents VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ1', 'local', '01JABCDEFGHJKMNPQRSTVWXYZ0',
        'A', 'qa', 'sonnet', 'done', NULL, 1, 1);
      INSERT INTO runs (id, agent_id, prompt, model, status, cost_usd, started_at, workspace_id, resumed, budget_usd)
        VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ2', '01JABCDEFGHJKMNPQRSTVWXYZ1', 'x', 'sonnet', 'error',
        0.1, 1, 'local', 0, 2);
    `)
    v4.close()

    const h = openDb(file)
    expect(h.sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    const columns = (
      h.sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    for (const name of [
      'task_size',
      'risk',
      'routing_source',
      'routing_reasons',
      'retry_of_run_id',
      'consecutive_failures',
    ]) {
      expect(columns).toContain(name)
    }
    const store = createStore(h.db)
    const agentId = '01JABCDEFGHJKMNPQRSTVWXYZ1'
    const previous = '01JABCDEFGHJKMNPQRSTVWXYZ2'
    expect(store.getRun('local', previous)).toMatchObject({
      taskSize: null,
      risk: null,
      routingSource: null,
      routingReasons: [],
      retryOfRunId: null,
      consecutiveFailures: 0,
    })
    const retry = store.createRun('local', agentId, 'x', 'opus', false, 2, {
      taskSize: 'large',
      risk: 'high',
      routingSource: 'escalation',
      routingReasons: ['razón'],
      retryOfRunId: previous,
      consecutiveFailures: 2,
    })
    expect(store.getRun('local', retry.id)).toMatchObject({
      routingSource: 'escalation',
      routingReasons: ['razón'],
      retryOfRunId: previous,
      consecutiveFailures: 2,
    })
    // Otro workspace no ve la ejecución.
    expect(store.getRun('otro', retry.id)).toBeUndefined()
    h.close()
  })

  it('una base en la versión 5 sube a la 6 con end_reason en NULL para filas previas', () => {
    expect(MIGRATIONS.length).toBe(6)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    const v5 = new Database(file)
    for (const m of MIGRATIONS.slice(0, 5)) v5.exec(m)
    v5.pragma('user_version = 5')
    v5.exec(`
      INSERT INTO projects VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ0', 'local', 'P', 'C:/p', 1);
      INSERT INTO agents VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ1', 'local', '01JABCDEFGHJKMNPQRSTVWXYZ0',
        'A', 'qa', 'sonnet', 'error', NULL, 1, 1);
      INSERT INTO runs (id, agent_id, prompt, model, status, started_at, workspace_id)
        VALUES ('01JABCDEFGHJKMNPQRSTVWXYZ2', '01JABCDEFGHJKMNPQRSTVWXYZ1', 'x', 'sonnet', 'error',
        1, 'local');
    `)
    v5.close()

    const h = openDb(file)
    expect(h.sqlite.pragma('user_version', { simple: true })).toBe(6)
    const store = createStore(h.db)
    const runId = '01JABCDEFGHJKMNPQRSTVWXYZ2'
    expect(store.runEndReason('local', runId)).toBeNull()
    store.setRunEndReason('otro', runId, 'limit_budget')
    // Escritura filtrada por workspace: otro workspace no la marca.
    expect(store.runEndReason('local', runId)).toBeNull()
    store.setRunEndReason('local', runId, 'limit_budget')
    expect(store.runEndReason('local', runId)).toBe('limit_budget')
    expect(store.runEndReason('otro', runId)).toBeNull()
    expect(store.getRun('local', runId)).not.toHaveProperty('endReason')
    h.close()
  })

  it('abrir dos veces no vuelve a aplicar migraciones', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    openDb(file).close()
    const h = openDb(file)
    expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    h.close()
  })
})
