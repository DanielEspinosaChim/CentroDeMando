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

  it('abrir dos veces no vuelve a aplicar migraciones', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    openDb(file).close()
    const h = openDb(file)
    expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    h.close()
  })
})
