import os from 'node:os'
import path from 'node:path'

export interface EngineConfig {
  /** Siempre 127.0.0.1: el motor nunca se expone fuera de la máquina. */
  readonly host: '127.0.0.1'
  readonly port: number
  /** Orígenes de la interfaz aceptados en la cabecera `Origin`. */
  readonly allowedOrigins: readonly string[]
  readonly maxConcurrentAgents: number
  /** Tope de turnos por ejecución (checklist de seguridad, punto D). */
  readonly maxTurns: number
  /** Tope de costo estimado por tarea en USD (checklist de seguridad, punto D). */
  readonly maxCostUsdPerTask: number
  /** Carpeta de datos: base SQLite y token local. */
  readonly dataDir: string
  /** Fase 1: un solo workspace local. */
  readonly workspaceId: string
}

export const DEFAULT_PORT = 4317
export const DEFAULT_UI_ORIGIN = 'http://localhost:5173'
export const DEFAULT_MAX_CONCURRENT_AGENTS = 5
export const DEFAULT_MAX_TURNS = 40
export const DEFAULT_MAX_COST_USD_PER_TASK = 2
export const LOCAL_WORKSPACE_ID = 'local'

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'centro-de-mando')
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} debe ser un número positivo`)
  return value
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un entero positivo`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const origins = (env.CDM_UI_ORIGIN ?? DEFAULT_UI_ORIGIN)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return {
    host: '127.0.0.1',
    port: positiveInt(env.CDM_PORT, DEFAULT_PORT, 'CDM_PORT'),
    allowedOrigins: origins,
    maxConcurrentAgents: positiveInt(
      env.MAX_CONCURRENT_AGENTS,
      DEFAULT_MAX_CONCURRENT_AGENTS,
      'MAX_CONCURRENT_AGENTS',
    ),
    maxTurns: positiveInt(env.CDM_MAX_TURNS, DEFAULT_MAX_TURNS, 'CDM_MAX_TURNS'),
    maxCostUsdPerTask: positiveNumber(
      env.CDM_MAX_COST_USD_PER_TASK,
      DEFAULT_MAX_COST_USD_PER_TASK,
      'CDM_MAX_COST_USD_PER_TASK',
    ),
    dataDir: env.CDM_DATA_DIR ? path.resolve(env.CDM_DATA_DIR) : defaultDataDir(env),
    workspaceId: LOCAL_WORKSPACE_ID,
  }
}
