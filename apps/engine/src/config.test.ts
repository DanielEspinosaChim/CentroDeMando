import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSafeDataDir, loadConfig } from './config.ts'

let base: string
let home: string

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-cfg-')))
  home = path.join(base, 'usuario')
  fs.mkdirSync(home)
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('assertSafeDataDir', () => {
  it('rechaza la raíz de la unidad', () => {
    const root = path.parse(base).root
    expect(() => assertSafeDataDir(root, home)).toThrow(/raíz de una unidad/)
  })

  it('rechaza la carpeta de usuario', () => {
    expect(() => assertSafeDataDir(home, home)).toThrow(/carpeta de usuario/)
  })

  it('rechaza un ancestro de la carpeta de usuario', () => {
    expect(() => assertSafeDataDir(base, home)).toThrow(/carpeta de usuario/)
    expect(() => assertSafeDataDir(path.dirname(base), home)).toThrow(/carpeta de usuario/)
  })

  it('rechaza rutas UNC y de dispositivo', () => {
    expect(() => assertSafeDataDir('\\\\servidor\\recurso\\datos', home)).toThrow(/UNC/)
    expect(() => assertSafeDataDir('//servidor/recurso/datos', home)).toThrow(/UNC/)
    expect(() => assertSafeDataDir('\\\\?\\C:\\datos', home)).toThrow(/UNC/)
  })

  it('rechaza un enlace que apunta a la carpeta de usuario', () => {
    const link = path.join(base, 'enlace')
    fs.symlinkSync(home, link, 'junction')
    expect(() => assertSafeDataDir(link, home)).toThrow(/carpeta de usuario/)
  })

  it('acepta una subcarpeta dedicada, exista o no', () => {
    expect(() =>
      assertSafeDataDir(path.join(home, 'AppData', 'centro-de-mando'), home),
    ).not.toThrow()
    const existing = path.join(home, 'datos')
    fs.mkdirSync(existing)
    expect(() => assertSafeDataDir(existing, home)).not.toThrow()
  })
})

describe('assertSafeDataDir: segmentos ambiguos de Windows', () => {
  const AMBIGUOUS = /terminar en/

  it.each(['\\. ', '\\Documents.', '\\Documents ', '\\x\\cdm. .', '\\cdm:ads'])(
    'rechaza <home>%s',
    (suffix) => {
      expect(() => assertSafeDataDir(`${home}${suffix}`, home)).toThrow(AMBIGUOUS)
    },
  )

  it('rechaza "C:\\ "', () => {
    expect(() => assertSafeDataDir('C:\\ ', home)).toThrow(AMBIGUOUS)
  })

  it.each(['\\cdm-datos', '\\.\\cdm-datos', '\\x\\..\\cdm-datos'])('acepta <home>%s', (suffix) => {
    expect(() => assertSafeDataDir(`${home}${suffix}`, home)).not.toThrow()
  })

  it('loadConfig también lo rechaza y el mensaje nombra CDM_DATA_DIR', () => {
    expect(() => loadConfig({ CDM_DATA_DIR: `${home}\\Documents.` })).toThrow(/CDM_DATA_DIR/)
  })

  it('el caso por defecto (APPDATA de prueba) sigue funcionando', () => {
    const appData = path.join(home, 'AppData', 'Roaming')
    const cfg = loadConfig({ APPDATA: appData })
    expect(cfg.dataDir).toBe(path.join(appData, 'centro-de-mando'))
  })
})

describe('loadConfig con CDM_DATA_DIR', () => {
  it('lanza con un mensaje claro si apunta a la carpeta de usuario', () => {
    expect(() => loadConfig({ CDM_DATA_DIR: os.homedir() })).toThrow(/CDM_DATA_DIR.*no válida/)
  })

  it('lanza si apunta a la raíz de la unidad o a una ruta UNC', () => {
    expect(() => loadConfig({ CDM_DATA_DIR: path.parse(base).root })).toThrow(/raíz de una unidad/)
    expect(() => loadConfig({ CDM_DATA_DIR: '\\\\servidor\\recurso\\datos' })).toThrow(/UNC/)
  })

  it('lanza si apunta a un ancestro de la carpeta de usuario', () => {
    expect(() => loadConfig({ CDM_DATA_DIR: path.dirname(os.homedir()) })).toThrow(/CDM_DATA_DIR/)
  })

  it('acepta una carpeta dedicada y la devuelve resuelta', () => {
    const dedicated = path.join(base, 'motor')
    expect(loadConfig({ CDM_DATA_DIR: dedicated }).dataDir).toBe(path.resolve(dedicated))
  })
})
