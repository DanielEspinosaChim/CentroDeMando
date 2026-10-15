import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_KEYWORD_LENGTH, MAX_KEYWORDS, type RouterConfig } from '@cdm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouterConfigStore, ROUTER_CONFIG_FILE_NAME } from './config-store.ts'
import { DEFAULT_ROUTER_CONFIG } from './default-config.ts'

const dirs: string[] = []
function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-router-cfg-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function edited(): RouterConfig {
  return { ...structuredClone(DEFAULT_ROUTER_CONFIG), smallKeywords: ['boton'], smallMaxChars: 50 }
}

describe('config-store del enrutador', () => {
  it('sin archivo usa los valores por defecto y no crea nada', () => {
    const dir = tempDataDir()
    const store = createRouterConfigStore(dir)
    expect(store.get()).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(fs.existsSync(path.join(dir, ROUTER_CONFIG_FILE_NAME))).toBe(false)
  })

  it('C003-8 set valida, guarda en dataDir y otra instancia lo relee', () => {
    const dir = tempDataDir()
    const store = createRouterConfigStore(dir)
    const saved = store.set(edited())
    expect(saved.smallKeywords).toEqual(['boton'])
    expect(store.get()).toEqual(saved)
    expect(createRouterConfigStore(dir).get()).toEqual(saved)
    // Escritura atómica: no queda el archivo temporal.
    expect(fs.readdirSync(dir)).toEqual([ROUTER_CONFIG_FILE_NAME])
  })

  it('get devuelve una copia: mutarla no cambia la vigente', () => {
    const store = createRouterConfigStore(tempDataDir())
    const copy = store.get()
    copy.riskKeywords.length = 0
    expect(store.get().riskKeywords.length).toBeGreaterThan(0)
  })

  const invalid: Array<[string, unknown]> = [
    ['riskKeywords vacía', { ...DEFAULT_ROUTER_CONFIG, riskKeywords: [] }],
    [
      `más de ${MAX_KEYWORDS} palabras`,
      { ...DEFAULT_ROUTER_CONFIG, smallKeywords: Array.from({ length: 201 }, (_, i) => `p${i}`) },
    ],
    [
      `palabra de más de ${MAX_KEYWORD_LENGTH} caracteres`,
      { ...DEFAULT_ROUTER_CONFIG, largeKeywords: ['a'.repeat(61)] },
    ],
    ['palabra vacía', { ...DEFAULT_ROUTER_CONFIG, riskKeywords: ['  '] }],
    ['campo desconocido', { ...DEFAULT_ROUTER_CONFIG, disableRiskFloor: true }],
    ['rol sin modelo', { ...DEFAULT_ROUTER_CONFIG, roleDefaults: { qa: 'haiku' } }],
    [
      'modelo inexistente',
      {
        ...DEFAULT_ROUTER_CONFIG,
        roleDefaults: { ...DEFAULT_ROUTER_CONFIG.roleDefaults, qa: 'gpt' },
      },
    ],
    ['escalateAfterFailures 0', { ...DEFAULT_ROUTER_CONFIG, escalateAfterFailures: 0 }],
  ]
  it.each(invalid)('C003-8 rechaza una config inválida (%s) sin tocar el disco', (_name, bad) => {
    const dir = tempDataDir()
    const store = createRouterConfigStore(dir)
    store.set(edited())
    const before = fs.readFileSync(path.join(dir, ROUTER_CONFIG_FILE_NAME), 'utf8')
    expect(() => store.set(bad)).toThrow()
    expect(fs.readFileSync(path.join(dir, ROUTER_CONFIG_FILE_NAME), 'utf8')).toBe(before)
    expect(store.get().smallKeywords).toEqual(['boton'])
  })

  it('archivo inválido o editado a mano: avisa y usa los valores por defecto', () => {
    const dir = tempDataDir()
    fs.writeFileSync(path.join(dir, ROUTER_CONFIG_FILE_NAME), '{"riskKeywords": []')
    const warnings: string[] = []
    const store = createRouterConfigStore(dir, { onWarning: (m) => warnings.push(m) })
    expect(store.get()).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(warnings).toHaveLength(1)
  })

  it('un enlace simbólico en lugar del archivo no se sigue', (ctx) => {
    const dir = tempDataDir()
    const outside = path.join(tempDataDir(), 'otra.json')
    fs.writeFileSync(outside, JSON.stringify(edited()))
    try {
      fs.symlinkSync(outside, path.join(dir, ROUTER_CONFIG_FILE_NAME), 'file')
    } catch {
      ctx.skip() // Windows sin privilegio para crear enlaces simbólicos.
    }
    const warnings: string[] = []
    const store = createRouterConfigStore(dir, { onWarning: (m) => warnings.push(m) })
    expect(store.get()).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(warnings).toHaveLength(1)
  })

  it.each([
    '\\\\servidor\\recurso\\cdm',
    '//servidor/recurso/cdm',
    '\\\\?\\C:\\cdm',
    'C:\\datos\\cdm. ',
  ])('rechaza la carpeta de datos %s sin tocar el disco', (dataDir) => {
    const touched = [
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'lstatSync'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'realpathSync'),
      vi.spyOn(fs, 'existsSync'),
    ]
    expect(() => createRouterConfigStore(dataDir)).toThrow(/carpeta de datos/i)
    for (const spy of touched) expect(spy).not.toHaveBeenCalled()
  })

  it('C003-8 el temporal tiene nombre aleatorio y se crea en exclusiva (wx)', () => {
    const dir = tempDataDir()
    const store = createRouterConfigStore(dir)
    // Un archivo previo con el nombre "predecible" de antes no estorba ni se sobrescribe.
    const stale = path.join(dir, `${ROUTER_CONFIG_FILE_NAME}.${process.pid}.tmp`)
    fs.writeFileSync(stale, 'ajeno')
    const write = vi.spyOn(fs, 'writeFileSync')
    store.set(edited())
    const [tmp, , opts] = write.mock.calls[0] ?? []
    expect(String(tmp)).not.toBe(stale)
    expect(path.basename(String(tmp))).toMatch(/^router-config\.json\.[0-9a-f]{16,}\.tmp$/)
    expect(opts).toMatchObject({ flag: 'wx' })
    expect(fs.readFileSync(stale, 'utf8')).toBe('ajeno')
    expect(fs.existsSync(String(tmp))).toBe(false)
  })

  it('si falla el rename, borra el temporal y no cambia la config vigente', () => {
    const dir = tempDataDir()
    const store = createRouterConfigStore(dir)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EPERM')
    })
    expect(() => store.set(edited())).toThrow('EPERM')
    expect(fs.readdirSync(dir)).toEqual([])
    expect(store.get()).toEqual(DEFAULT_ROUTER_CONFIG)
  })
})
