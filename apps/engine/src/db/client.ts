import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.ts'

export type Db = BetterSQLite3Database<typeof schema>

export interface DbHandle {
  db: Db
  sqlite: Database.Database
  close(): void
}

/** Migraciones en orden; `PRAGMA user_version` guarda la última aplicada. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX projects_workspace_idx ON projects (workspace_id);
  CREATE UNIQUE INDEX projects_workspace_path_uq ON projects (workspace_id, path);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects (id),
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    default_model TEXT NOT NULL,
    status TEXT NOT NULL,
    sdk_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX agents_workspace_idx ON agents (workspace_id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    context_used_pct REAL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX runs_agent_idx ON runs (agent_id);
  `,
  // 2: toda tabla lleva workspace_id (checklist de seguridad, punto 3).
  `
  ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
  CREATE INDEX runs_workspace_idx ON runs (workspace_id);
  `,
  // 3: marca de reanudación para acotar el tope de costo a toda la sesión (no por query()).
  // Las filas previas quedan como inicio de sesión (0).
  `
  ALTER TABLE runs ADD COLUMN resumed INTEGER NOT NULL DEFAULT 0;
  `,
  // 4: presupuesto (USD) concedido a cada ejecución, para descontarlo entero al reanudar
  // si la ejecución se cerró sin reportar costo. Las filas previas quedan en NULL (el
  // motor usa entonces el tope por tarea, que es la cota superior de lo que se concedió).
  `
  ALTER TABLE runs ADD COLUMN budget_usd REAL;
  `,
  // 5: decisión del enrutador de modelos (feature 003) y cadena de reintentos. Las filas
  // previas quedan sin decisión (NULL) y con 0 fallos seguidos.
  `
  ALTER TABLE runs ADD COLUMN task_size TEXT;
  ALTER TABLE runs ADD COLUMN risk TEXT;
  ALTER TABLE runs ADD COLUMN routing_source TEXT;
  ALTER TABLE runs ADD COLUMN routing_reasons TEXT;
  ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL;
  ALTER TABLE runs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
  `,
  // 6: motivo de fin por tope ('limit_turns' | 'limit_budget'), para no reintentar con
  // presupuesto completo una ejecución que se cortó por tope. Las filas previas quedan NULL.
  `
  ALTER TABLE runs ADD COLUMN end_reason TEXT;
  `,
]

function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const apply = sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[v] as string)
      sqlite.pragma(`user_version = ${v + 1}`)
    })
    apply()
  }
}

/** Abre la base (archivo o `:memory:`), activa WAL y claves foráneas, y migra. */
export function openDb(file: string): DbHandle {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  const db = drizzle(sqlite, { schema })
  return { db, sqlite, close: () => sqlite.close() }
}
