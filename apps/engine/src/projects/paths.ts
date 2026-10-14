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

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Normaliza la ruta de un proyecto nuevo: absoluta, sin `..`, existente, carpeta,
 * y con enlaces resueltos (se guarda la ruta real). Rechaza la raíz de una unidad,
 * la carpeta de usuario (o un ancestro) y cualquier carpeta que contenga `dataDir`:
 * el agente podría leer el token local, `~/.ssh`, etc.
 */
export function resolveProjectPath(
  raw: string,
  opts: { dataDir?: string; homeDir?: string } = {},
): string {
  if (!path.isAbsolute(raw)) throw new ValidationError('path: debe ser una ruta absoluta')
  if (hasDotDotSegment(raw)) throw new ValidationError('path: no puede contener ".."')
  let real: string
  try {
    real = fs.realpathSync.native(path.normalize(raw))
  } catch {
    throw new ValidationError('path: la ruta no existe')
  }
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
 * Verifica que `cwd` (tras resolver enlaces) quede dentro de la ruta del proyecto
 * (checklist de seguridad, punto C). Devuelve el `cwd` real con el que se lanza el agente.
 */
export function assertCwdInProject(projectPath: string, cwd: string = projectPath): string {
  if (hasDotDotSegment(cwd)) throw new ValidationError('cwd: no puede contener ".."')
  let realProject: string
  let realCwd: string
  try {
    realProject = fs.realpathSync.native(projectPath)
    realCwd = fs.realpathSync.native(cwd)
  } catch {
    throw new ValidationError('cwd: la ruta del proyecto ya no existe')
  }
  if (!isInside(realProject, realCwd)) {
    throw new ValidationError('cwd: fuera del proyecto registrado')
  }
  return realCwd
}
