import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hasAmbiguousWin32Segment, isUncPath } from '../projects/paths.ts'

export const TOKEN_FILE_NAME = 'local-token'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SID_PATTERN = /S-1-\d+(?:-\d+)+/

/**
 * SIDs cuyas entradas EXPLÍCITAS se quitan: `/inheritance:r` solo elimina las heredadas, y
 * en algunas máquinas (p. ej. los runners de GitHub) un archivo nuevo nace con entradas
 * explícitas de SYSTEM y Administradores tomadas de la DACL por defecto del proceso.
 * Todos, Usuarios autenticados, Usuarios, SYSTEM, Administradores, Usuarios avanzados,
 * CREATOR OWNER y CREATOR GROUP.
 */
export const BROAD_SIDS = [
  '*S-1-1-0',
  '*S-1-5-11',
  '*S-1-5-32-545',
  '*S-1-5-18',
  '*S-1-5-32-544',
  '*S-1-5-32-547',
  '*S-1-3-0',
  '*S-1-3-1',
]

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
 * Defensa en profundidad antes de llamar a icacls (que usa la API Win32 sin `\\?\`):
 * `true` si icacls podría acabar en un objeto distinto del que abrió Node. Lo es si la
 * ruta (dada o real) es UNC/de dispositivo o tiene segmentos que Windows recorta (punto o
 * espacio final) o un `:` extra, o si su ruta real no coincide (sin distinguir mayúsculas)
 * con la real de su carpeta padre más su nombre: el último segmento es un enlace o Windows
 * lo normaliza a otro nombre. Se compara contra la real del padre, y no contra la ruta
 * tal cual, para tolerar nombres cortos 8.3 en los ancestros (p. ej. `C:\Users\RUNNER~1`
 * en el %TEMP% del CI), que Win32 resuelve al mismo objeto; los ancestros ya se validaron
 * en `assertSafeDataDir`. Lanza si la ruta no existe.
 */
function isAmbiguousAclTarget(target: string): boolean {
  if (isUncPath(target) || hasAmbiguousWin32Segment(target)) return true
  const real = fs.realpathSync.native(target)
  if (isUncPath(real) || hasAmbiguousWin32Segment(real)) return true
  const expected = path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target))
  return real.toLowerCase() !== expected.toLowerCase()
}

/**
 * Deja un archivo o carpeta accesible solo para el usuario actual. Idempotente.
 * - win32: `icacls` quita la herencia, concede control total al SID del usuario
 *   (sintaxis `*S-1-...`, inmune a espacios/acentos en el nombre) y retira grupos amplios.
 *   En carpetas el permiso se concede con `(OI)(CI)` para que lo hereden los hijos.
 * - POSIX: `chmod 600` en archivos y `700` en carpetas (cubre lo que ya existía).
 * Si falla, avisa por `onWarning` pero no lanza: el motor sigue arrancando. En win32, si
 * la ruta es ambigua (`isAmbiguousAclTarget`) no llama a icacls y solo avisa.
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
  let ambiguous: boolean
  try {
    ambiguous = isAmbiguousAclTarget(target)
  } catch (err) {
    warn(`no se pudo comprobar la ruta ${target}: ${describeError(err)}; no se cambió su ACL`)
    return
  }
  if (ambiguous) {
    warn(
      `la ruta ${target} es ambigua para Windows (enlace, punto o espacio final, o ":"): no se cambió su ACL`,
    )
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

/** Archivos que el motor crea en `dataDir`: la base SQLite (con su WAL) y el token. */
export const ENGINE_DATA_FILES: readonly string[] = [
  'data.db',
  'data.db-wal',
  'data.db-shm',
  TOKEN_FILE_NAME,
]

/** `true` si la carpeta está vacía o solo contiene archivos del motor. */
function holdsOnlyEngineFiles(dir: string, platform: NodeJS.Platform): boolean {
  const norm = (name: string) => (platform === 'win32' ? name.toLowerCase() : name)
  const allowed = new Set(ENGINE_DATA_FILES.map(norm))
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .every((entry) => entry.isFile() && allowed.has(norm(entry.name)))
}

/**
 * Crea `dataDir` si no existe y lo deja accesible solo para el usuario actual, con
 * herencia a lo que se cree dentro (`data.db`, sus `-wal`/`-shm`, el token). Debe
 * llamarse ANTES de abrir la base y el token: así nacen ya con la ACL privada y no queda
 * ventana entre crear el archivo y protegerlo.
 *
 * La ACL de la carpeta solo se reescribe si el motor la creó en este arranque, o si ya
 * existía vacía o con solo archivos del motor (`ENGINE_DATA_FILES`): `CDM_DATA_DIR`
 * podría apuntar a una carpeta con datos ajenos y quitarles la herencia y los permisos
 * de otros usuarios sería destructivo. En ese caso no se toca y se avisa (sin nombrar su
 * contenido) para que se use una carpeta dedicada; el archivo del token se sigue
 * protegiendo igual en `getOrCreateLocalToken`. Mismo manejo que el token: avisa sin
 * datos sensibles y no lanza por fallos de la ACL.
 */
export function restrictDataDir(dataDir: string, opts: LocalTokenOptions = {}): void {
  const target = path.resolve(dataDir)
  // Antes de crearla: Node crearía `x.` o `. ` literalmente y icacls tocaría otra carpeta.
  if (hasAmbiguousWin32Segment(dataDir) || hasAmbiguousWin32Segment(target)) {
    opts.onWarning?.(
      `la ruta de la carpeta de datos ${target} es ambigua para Windows (punto o espacio final, o ":"): no se creó ni se cambió su ACL`,
    )
    return
  }
  const created = fs.mkdirSync(target, { recursive: true, mode: 0o700 }) !== undefined
  if (!created) {
    let dedicated: boolean
    try {
      dedicated = holdsOnlyEngineFiles(target, opts.platform ?? process.platform)
    } catch (err) {
      opts.onWarning?.(
        `no se pudo revisar el contenido de la carpeta de datos ${target}: ${describeError(err)}; no se cambió su ACL`,
      )
      return
    }
    if (!dedicated) {
      opts.onWarning?.(
        `la carpeta de datos ${target} contiene archivos ajenos al motor: no se cambió su ACL. El token sigue protegido; usa una carpeta dedicada (CDM_DATA_DIR) para proteger también la base.`,
      )
      return
    }
  }
  restrictToCurrentUser(target, 'dir', opts)
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
