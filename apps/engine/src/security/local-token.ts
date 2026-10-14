import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TOKEN_FILE_NAME = 'local-token'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SID_PATTERN = /S-1-\d+(?:-\d+)+/

/** SIDs de grupos amplios que se quitan explícitamente: Todos, Usuarios autenticados y Usuarios. */
const BROAD_SIDS = ['*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545']

/**
 * Ejecuta un binario con argumentos en arreglo (sin shell) y devuelve su stdout.
 * Debe lanzar si el proceso termina con código distinto de cero.
 */
export type CommandExecutor = (file: string, args: readonly string[]) => string

export interface LocalTokenOptions {
  /** Recibe avisos no fatales (p. ej. si no se pudo aplicar la ACL). Nunca incluyen el token. */
  onWarning?: (message: string) => void
  /** Ejecutor de comandos inyectable (para tests). Por defecto `execFileSync`. */
  exec?: CommandExecutor
  /** Plataforma a asumir (para tests). Por defecto `process.platform`. */
  platform?: NodeJS.Platform
}

const defaultExec: CommandExecutor = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

/**
 * Ruta absoluta a un binario de System32. Se evita resolver por PATH para que un
 * `whoami.exe`/`icacls.exe` plantado en el directorio actual o en PATH no se ejecute.
 */
function system32(exe: string): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.win32.join(root, 'System32', exe)
}

/** Obtiene el SID del usuario actual con `whoami /user` (salida CSV: "dominio\usuario","S-1-..."). */
function currentUserSid(exec: CommandExecutor): string {
  const out = exec(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  const sid = out.match(SID_PATTERN)?.[0]
  if (!sid) throw new Error('no se pudo obtener el SID del usuario actual')
  return sid
}

function describeError(err: unknown): string {
  const e = err as { status?: number; code?: string; message?: string }
  if (typeof e?.status === 'number') return `código de salida ${e.status}`
  if (e?.code) return e.code
  return e?.message ?? String(err)
}

/**
 * Deja un archivo o carpeta accesible solo para el usuario actual. Idempotente.
 * - win32: `icacls` quita la herencia, concede control total al SID del usuario
 *   (sintaxis `*S-1-...`, inmune a espacios/acentos en el nombre) y retira grupos amplios.
 *   En carpetas el permiso se concede con `(OI)(CI)` para que lo hereden los hijos.
 * - POSIX: `chmod 600` en archivos y `700` en carpetas (cubre lo que ya existía).
 * Si falla, avisa por `onWarning` pero no lanza: el motor sigue arrancando.
 */
function restrictToCurrentUser(
  target: string,
  kind: 'file' | 'dir',
  opts: LocalTokenOptions,
): void {
  const platform = opts.platform ?? process.platform
  const warn = opts.onWarning ?? (() => {})
  if (platform !== 'win32') {
    try {
      fs.chmodSync(target, kind === 'dir' ? 0o700 : 0o600)
    } catch (err) {
      warn(`no se pudieron restringir los permisos de ${target}: ${describeError(err)}`)
    }
    return
  }
  const exec = opts.exec ?? defaultExec
  try {
    const sid = currentUserSid(exec)
    const grant = kind === 'dir' ? `*${sid}:(OI)(CI)F` : `*${sid}:F`
    exec(system32('icacls.exe'), [
      target,
      '/inheritance:r',
      '/grant:r',
      grant,
      '/remove:g',
      ...BROAD_SIDS,
    ])
  } catch (err) {
    warn(`no se pudo aplicar la ACL privada a ${target} con icacls: ${describeError(err)}`)
  }
}

/**
 * Crea `dataDir` si no existe y lo deja accesible solo para el usuario actual, con
 * herencia a lo que se cree dentro (`data.db`, sus `-wal`/`-shm`, el token). Debe
 * llamarse ANTES de abrir la base y el token: así nacen ya con la ACL privada aunque
 * `CDM_DATA_DIR` apunte a una carpeta compartida, y no queda ventana entre crear el
 * archivo y protegerlo. Mismo manejo que el token: avisa sin datos sensibles y no lanza.
 */
export function restrictDataDir(dataDir: string, opts: LocalTokenOptions = {}): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  restrictToCurrentUser(path.resolve(dataDir), 'dir', opts)
}

/**
 * Lee el token local de `dataDir`, o lo genera si no existe o está corrupto.
 * El archivo queda accesible solo para el usuario actual (ACL explícita en Windows,
 * `0o600` en POSIX), también si ya existía. El token nunca se registra en logs.
 *
 * Para evitar la ventana de carrera, el archivo se crea vacío, se protege y solo
 * después se escribe el token: nunca existe contenido con la ACL heredada.
 */
export function getOrCreateLocalToken(dataDir: string, opts: LocalTokenOptions = {}): string {
  const file = path.join(dataDir, TOKEN_FILE_NAME)
  let exists = false
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    exists = true
    if (TOKEN_PATTERN.test(existing)) {
      restrictToCurrentUser(file, 'file', opts)
      return existing
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  fs.mkdirSync(dataDir, { recursive: true })
  if (!exists) fs.closeSync(fs.openSync(file, 'wx', 0o600))
  // Se protege antes de escribir: si existía corrupto, también se endurece primero.
  restrictToCurrentUser(file, 'file', opts)
  const token = randomBytes(32).toString('base64url')
  // Reescribir un archivo existente conserva su DACL (verificado con icacls).
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

/** Comparación en tiempo constante. */
export function tokensMatch(expected: string, received: string | undefined): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}
