import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ValidationError } from '../errors/index.ts'
import {
  assertCwdInProject,
  hasAmbiguousWin32Segment,
  isInside,
  isUncPath,
  resolveProjectPath,
  revalidateProjectPath,
} from './paths.ts'

let root: string
let project: string
let outside: string

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-paths-')))
  project = path.join(root, 'proyecto')
  outside = path.join(root, 'fuera')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(project, 'archivo.txt'), 'x')
  // En Windows 'junction' no requiere privilegios de administrador.
  fs.symlinkSync(outside, path.join(project, 'enlace-fuera'), 'junction')
  fs.symlinkSync(path.join(project, 'src'), path.join(project, 'enlace-dentro'), 'junction')
})

describe('resolveProjectPath', () => {
  it('acepta una carpeta existente y devuelve la ruta real', () => {
    expect(resolveProjectPath(project)).toBe(fs.realpathSync.native(project))
  })
  it('rechaza rutas inexistentes', () => {
    expect(() => resolveProjectPath(path.join(root, 'no-existe'))).toThrow(ValidationError)
  })
  it('rechaza rutas relativas', () => {
    expect(() => resolveProjectPath('proyecto')).toThrow(/absoluta/)
  })
  it('rechaza segmentos ".."', () => {
    expect(() => resolveProjectPath(`${project}${path.sep}..${path.sep}fuera`)).toThrow(/\.\./)
  })
  it('rechaza archivos', () => {
    expect(() => resolveProjectPath(path.join(project, 'archivo.txt'))).toThrow(/carpeta/)
  })
})

describe('resolveProjectPath: carpetas peligrosas', () => {
  it('rechaza la raíz de la unidad', () => {
    expect(() => resolveProjectPath(path.parse(root).root)).toThrow(/raíz/)
  })
  it('rechaza la carpeta de usuario y sus ancestros', () => {
    expect(() => resolveProjectPath(project, { homeDir: project })).toThrow(/usuario/)
    expect(() => resolveProjectPath(root, { homeDir: project })).toThrow(/usuario/)
    expect(() => resolveProjectPath(project, { homeDir: outside })).not.toThrow()
  })
  it('rechaza carpetas que contienen la carpeta de datos del motor', () => {
    const dataDir = path.join(outside, 'datos')
    fs.mkdirSync(dataDir, { recursive: true })
    expect(() => resolveProjectPath(outside, { dataDir })).toThrow(/datos/)
    expect(() => resolveProjectPath(project, { dataDir })).not.toThrow()
  })
})

describe('assertCwdInProject', () => {
  it('acepta el propio proyecto y subcarpetas', () => {
    expect(assertCwdInProject(project)).toBe(fs.realpathSync.native(project))
    expect(assertCwdInProject(project, path.join(project, 'src'))).toBe(
      fs.realpathSync.native(path.join(project, 'src')),
    )
  })
  it('acepta enlaces que apuntan dentro del proyecto', () => {
    expect(() => assertCwdInProject(project, path.join(project, 'enlace-dentro'))).not.toThrow()
  })
  it('rechaza enlaces que salen del proyecto', () => {
    expect(() => assertCwdInProject(project, path.join(project, 'enlace-fuera'))).toThrow(
      /fuera del proyecto/,
    )
  })
  it('rechaza ".." y carpetas hermanas', () => {
    expect(() => assertCwdInProject(project, `${project}${path.sep}..`)).toThrow(/\.\./)
    expect(() => assertCwdInProject(project, outside)).toThrow(/fuera del proyecto/)
  })
  it('rechaza un prefijo engañoso (proyecto-malo no está dentro de proyecto)', () => {
    const evil = `${project}-malo`
    fs.mkdirSync(evil, { recursive: true })
    expect(() => assertCwdInProject(project, evil)).toThrow(/fuera del proyecto/)
  })
})

describe('isInside', () => {
  it('distingue mayúsculas solo fuera de Windows', () => {
    const upper = project.toUpperCase()
    expect(isInside(project, upper)).toBe(process.platform === 'win32')
  })
})

const UNC_PATHS = [
  '\\\\localhost\\C$\\Users',
  '\\\\127.0.0.1\\C$\\Users\\alguien',
  '//servidor/x',
  '\\\\?\\C:\\Users',
  '\\\\.\\C:\\Users',
  '\\\\servidor\\recurso',
  '\\/servidor/x',
]

describe('rutas UNC y de dispositivo', () => {
  it.each(UNC_PATHS)('isUncPath(%s) es true', (p) => expect(isUncPath(p)).toBe(true))

  it('isUncPath no marca rutas locales', () => {
    expect(isUncPath(project)).toBe(false)
    expect(isUncPath('C:\\Users')).toBe(false)
    expect(isUncPath('/home/x')).toBe(false)
  })

  it.each(UNC_PATHS)('resolveProjectPath rechaza %s al registrar', (p) => {
    expect(() => resolveProjectPath(p)).toThrow(ValidationError)
    expect(() => resolveProjectPath(p)).toThrow(/UNC/)
  })

  it.each(UNC_PATHS)('assertCwdInProject rechaza %s como cwd', (p) => {
    expect(() => assertCwdInProject(project, p)).toThrow(/UNC/)
  })

  it.each(UNC_PATHS)('assertCwdInProject rechaza %s como ruta del proyecto', (p) => {
    expect(() => assertCwdInProject(p)).toThrow(/UNC/)
  })

  it('revalidateProjectPath rechaza UNC guardadas', () => {
    expect(() => revalidateProjectPath('\\\\localhost\\C$\\Users')).toThrow(/no válido.*UNC/)
  })
})

describe('revalidateProjectPath', () => {
  it('acepta una ruta real guardada y la devuelve', () => {
    expect(revalidateProjectPath(fs.realpathSync.native(project))).toBe(
      fs.realpathSync.native(project),
    )
  })

  it('rechaza raíz, carpeta de usuario y contenedor de dataDir', () => {
    expect(() => revalidateProjectPath(path.parse(root).root)).toThrow(/no válido/)
    expect(() => revalidateProjectPath(project, { homeDir: project })).toThrow(/usuario/)
    const dataDir = path.join(outside, 'datos-reval')
    fs.mkdirSync(dataDir, { recursive: true })
    expect(() => revalidateProjectPath(outside, { dataDir })).toThrow(/datos/)
  })

  it('rechaza una ruta no canónica (su ruta real cambió desde el registro)', () => {
    // `enlace-dentro` resuelve a `src`: la ruta guardada no coincide con la real.
    expect(() => revalidateProjectPath(path.join(project, 'enlace-dentro'))).toThrow(/cambió/)
  })

  it('rechaza una carpeta que ya no existe', () => {
    expect(() => revalidateProjectPath(path.join(root, 'no-existe'))).toThrow(ValidationError)
  })
})

describe('hasAmbiguousWin32Segment', () => {
  it.each([
    'C:\\a\\b.',
    'C:\\a\\b ',
    'C:\\a\\. ',
    'C:\\a\\.. ',
    'C:\\a\\...',
    'C:\\a\\b:ads',
    'C:\\ ',
  ])('true para %j', (p) => expect(hasAmbiguousWin32Segment(p)).toBe(true))

  it.each(['C:\\a\\b', 'C:\\a\\.\\b', 'C:\\a\\x\\..\\b', 'C:\\a\\b.txt', 'C:\\a\\.git'])(
    'false para %j',
    (p) => expect(hasAmbiguousWin32Segment(p)).toBe(false),
  )
})

const IS_WIN = process.platform === 'win32'

describe('segmentos ambiguos de Windows (carpetas literales con prefijo de dispositivo)', () => {
  let base = ''
  let lit = ''
  let docsDot = ''
  let dotSpace = ''
  let normal = ''
  let linkToDotSpace = ''

  beforeAll(() => {
    if (!IS_WIN) return
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-amb-')))
    lit = `\\\\?\\${base}`
    docsDot = path.join(base, 'Docs.')
    dotSpace = path.join(base, '. ')
    normal = path.join(base, 'Docs')
    linkToDotSpace = path.join(base, 'enlace-punto-espacio')
    fs.mkdirSync(`${lit}\\Docs.`)
    fs.mkdirSync(`${lit}\\. `)
    fs.mkdirSync(normal)
    fs.symlinkSync(`${lit}\\. `, linkToDotSpace, 'junction')
  })

  afterAll(() => {
    if (!IS_WIN || !base) return
    // Las carpetas literales solo se pueden borrar con la ruta \\?\ .
    try {
      fs.rmdirSync(linkToDotSpace)
    } catch {}
    for (const n of ['Docs.', '. ']) {
      try {
        fs.rmdirSync(`${lit}\\${n}`)
      } catch {}
    }
    fs.rmSync(base, { recursive: true, force: true })
  })

  it.runIf(IS_WIN)('las carpetas literales existen de verdad (precondición)', () => {
    expect(fs.statSync(`${lit}\\Docs.`).isDirectory()).toBe(true)
    expect(fs.statSync(`${lit}\\. `).isDirectory()).toBe(true)
  })

  it.runIf(IS_WIN)('resolveProjectPath rechaza Docs. y ". " aunque exista la gemela normal', () => {
    expect(() => resolveProjectPath(docsDot)).toThrow(ValidationError)
    expect(() => resolveProjectPath(docsDot)).toThrow(/terminar en/)
    expect(() => resolveProjectPath(dotSpace)).toThrow(/terminar en/)
  })

  it.runIf(IS_WIN)('revalidateProjectPath rechaza las rutas ambiguas guardadas', () => {
    expect(() => revalidateProjectPath(docsDot)).toThrow(/no válido/)
    expect(() => revalidateProjectPath(dotSpace)).toThrow(/no válido/)
  })

  it.runIf(IS_WIN)('assertCwdInProject las rechaza como cwd y como proyecto', () => {
    expect(() => assertCwdInProject(normal, docsDot)).toThrow(/terminar en/)
    expect(() => assertCwdInProject(normal, dotSpace)).toThrow(/terminar en/)
    expect(() => assertCwdInProject(docsDot)).toThrow(/terminar en/)
    expect(() => assertCwdInProject(dotSpace)).toThrow(/terminar en/)
  })

  it.runIf(IS_WIN)(
    'una junction hacia la carpeta literal ". " se rechaza (ruta real ambigua)',
    () => {
      expect(() => resolveProjectPath(linkToDotSpace)).toThrow(/terminar en/)
      expect(() => assertCwdInProject(normal, linkToDotSpace)).toThrow(/terminar en/)
      expect(() => assertCwdInProject(base, linkToDotSpace)).toThrow(/terminar en/)
    },
  )

  it.runIf(IS_WIN)('una carpeta normal sigue aceptándose', () => {
    expect(resolveProjectPath(normal)).toBe(fs.realpathSync.native(normal))
    expect(assertCwdInProject(normal)).toBe(fs.realpathSync.native(normal))
  })
})
