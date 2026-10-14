import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ValidationError } from '../errors/index.ts'

const caseInsensitive = process.platform === 'win32'

function comparable(p: string): string {
  return caseInsensitive ? p.toLowerCase() : p
}

/** `true` si `child` es `parent` o está dentro de él (rutas ya resueltas). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(comparable(parent), comparable(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function hasDotDotSegment(raw: string): boolean {
  return raw.split(/[\\/]+/).some((segment) => segment === '..')
}

/**
 * `true` para rutas UNC (`\\servidor\recurso`, `//servidor/recurso`) y de dispositivo
 * (`\\?\C:\...`, `\\.\C:\...`): todo lo que empieza por dos separadores. Se rechazan
 * siempre: `\\localhost\C$\Users` llega a la carpeta de usuario por la red local y las
 * comparaciones contra `C:\Users\...` no lo detectan (realpath conserva la forma UNC).
 */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

export interface ProjectPathOptions {
  dataDir?: string
  homeDir?: string
}

const UNC_PATH_MESSAGE = 'path: no se admiten rutas de red (UNC) ni de dispositivo'
const UNC_CWD_MESSAGE = 'cwd: no se admiten rutas de red (UNC) ni de dispositivo'

/**
 * Normaliza la ruta de un proyecto nuevo: absoluta, local (no UNC), sin `..`, existente,
 * carpeta, y con enlaces resueltos (se guarda la ruta real). Rechaza la raíz de una unidad,
 * la carpeta de usuario (o un ancestro) y cualquier carpeta que contenga `dataDir`:
 * el agente podría leer el token local, `~/.ssh`, etc.
 */
export function resolveProjectPath(raw: string, opts: ProjectPathOptions = {}): string {
  if (isUncPath(raw)) throw new ValidationError(UNC_PATH_MESSAGE)
  if (!path.isAbsolute(raw)) throw new ValidationError('path: debe ser una ruta absoluta')
  if (hasDotDotSegment(raw)) throw new ValidationError('path: no puede contener ".."')
  let real: string
  try {
    real = fs.realpathSync.native(path.normalize(raw))
  } catch {
    throw new ValidationError('path: la ruta no existe')
  }
  // Un enlace local podría apuntar a un recurso de red: se revisa también la ruta real.
  if (isUncPath(real)) throw new ValidationError(UNC_PATH_MESSAGE)
  if (!fs.statSync(real).isDirectory()) throw new ValidationError('path: debe ser una carpeta')
  if (path.parse(real).root === real || path.dirname(real) === real) {
    throw new ValidationError('path: no puede ser la raíz de una unidad')
  }
  const home = realOrSelf(opts.homeDir ?? os.homedir())
  if (isInside(real, home)) {
    throw new ValidationError('path: no puede ser la carpeta de usuario ni una que la contenga')
  }
  if (opts.dataDir && isInside(real, realOrSelf(opts.dataDir))) {
    throw new ValidationError('path: no puede contener la carpeta de datos del motor')
  }
  return real
}

/**
 * Revalida, al lanzar, un proyecto ya guardado con las mismas reglas que al registrarlo:
 * un proyecto registrado antes de endurecer las reglas (raíz, carpeta de usuario,
 * contenedor de `dataDir`, UNC) no debe poder lanzar agentes. Además exige que la ruta
 * real siga siendo la guardada (al registrar se guarda la real): si la carpeta se
 * sustituyó después por un enlace a otro sitio, se rechaza. Devuelve la ruta validada.
 */
export function revalidateProjectPath(storedPath: string, opts: ProjectPathOptions = {}): string {
  let real: string
  try {
    real = resolveProjectPath(storedPath, opts)
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(`proyecto registrado no válido (${err.message})`)
    }
    throw err
  }
  if (comparable(real) !== comparable(path.normalize(storedPath))) {
    throw new ValidationError(
      'proyecto registrado no válido (su ruta real cambió desde el registro)',
    )
  }
  return real
}

/**
 * Verifica que `cwd` (tras resolver enlaces) quede dentro de la ruta del proyecto
 * (checklist de seguridad, punto C). Devuelve el `cwd` real con el que se lanza el agente.
 */
export function assertCwdInProject(projectPath: string, cwd: string = projectPath): string {
  if (isUncPath(projectPath) || isUncPath(cwd)) throw new ValidationError(UNC_CWD_MESSAGE)
  if (hasDotDotSegment(cwd)) throw new ValidationError('cwd: no puede contener ".."')
  let realProject: string
  let realCwd: string
  try {
    realProject = fs.realpathSync.native(projectPath)
    realCwd = fs.realpathSync.native(cwd)
  } catch {
    throw new ValidationError('cwd: la ruta del proyecto ya no existe')
  }
  if (isUncPath(realProject) || isUncPath(realCwd)) throw new ValidationError(UNC_CWD_MESSAGE)
  if (!isInside(realProject, realCwd)) {
    throw new ValidationError('cwd: fuera del proyecto registrado')
  }
  return realCwd
}
