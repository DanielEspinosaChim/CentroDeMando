import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasAmbiguousWin32Segment, isInside, isUncPath } from './projects/paths.ts'

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
  /** Escrituras generales por workspace y minuto (POST /projects, POST/DELETE /agents). */
  readonly rateLimitWritesPerMin: number
  /** Acciones por agente y minuto (tasks y resume, que lanzan un proceso). pause/stop no se limitan. */
  readonly rateLimitAgentActionsPerMin: number
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
export const DEFAULT_RATE_LIMIT_WRITES_PER_MIN = 60
export const DEFAULT_RATE_LIMIT_AGENT_ACTIONS_PER_MIN = 10
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

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Rechaza una carpeta de datos peligrosa: al arrancar se le aplica una ACL privada que
 * reemplaza la existente, así que no puede ser la raíz de una unidad, la carpeta de
 * usuario ni un ancestro suyo, ni una ruta UNC o de dispositivo, ni tener segmentos que
 * Windows recorte (punto o espacio final) o un `:` de flujo alternativo. Si la carpeta (o un
 * enlace) ya existe, se comprueba también su ruta real. Lanza con un mensaje claro y el
 * motor no arranca.
 */
export function assertSafeDataDir(dataDir: string, homeDir: string = os.homedir()): void {
  const bad = (why: string) =>
    new Error(
      `Carpeta de datos (CDM_DATA_DIR) no válida: ${why}. Usa una carpeta dedicada al motor.`,
    )
  const resolved = path.resolve(dataDir)
  const real = realOrResolved(resolved)
  for (const p of [dataDir, resolved, real]) {
    if (isUncPath(p)) throw bad('no se admiten rutas de red (UNC) ni de dispositivo')
    // Node crea `<home>\. ` o `Documents.` literalmente, pero icacls los recorta y
    // reescribiría la ACL del perfil o de `Documents` (ver hasAmbiguousWin32Segment).
    if (hasAmbiguousWin32Segment(p)) {
      throw bad(
        'ningún segmento de la ruta puede terminar en "." o en espacio, ni contener ":" fuera de la unidad (Windows los recorta o los trata como flujos alternativos y la ruta acabaría en otra carpeta)',
      )
    }
  }
  const home = realOrResolved(homeDir)
  for (const p of [resolved, real]) {
    if (path.parse(p).root === p || path.dirname(p) === p) {
      throw bad('no puede ser la raíz de una unidad')
    }
    if (isInside(p, home)) {
      throw bad('no puede ser la carpeta de usuario ni una que la contenga')
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const origins = (env.CDM_UI_ORIGIN ?? DEFAULT_UI_ORIGIN)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const dataDir = env.CDM_DATA_DIR ? path.resolve(env.CDM_DATA_DIR) : defaultDataDir(env)
  // Se valida aquí (y no solo en main.ts) para que ninguna entrada arranque con ella.
  assertSafeDataDir(env.CDM_DATA_DIR || dataDir)
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
    rateLimitWritesPerMin: positiveInt(
      env.CDM_RATE_LIMIT_WRITES_PER_MIN,
      DEFAULT_RATE_LIMIT_WRITES_PER_MIN,
      'CDM_RATE_LIMIT_WRITES_PER_MIN',
    ),
    rateLimitAgentActionsPerMin: positiveInt(
      env.CDM_RATE_LIMIT_AGENT_ACTIONS_PER_MIN,
      DEFAULT_RATE_LIMIT_AGENT_ACTIONS_PER_MIN,
      'CDM_RATE_LIMIT_AGENT_ACTIONS_PER_MIN',
    ),
    dataDir,
    workspaceId: LOCAL_WORKSPACE_ID,
  }
}
