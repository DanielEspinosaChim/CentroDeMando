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

  it('abrir dos veces no vuelve a aplicar migraciones', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-mig-')), 'data.db')
    openDb(file).close()
    const h = openDb(file)
    expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    h.close()
  })
})
