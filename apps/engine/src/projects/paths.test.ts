import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ValidationError } from '../errors/index.ts'
import { assertCwdInProject, isInside, resolveProjectPath } from './paths.ts'

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
