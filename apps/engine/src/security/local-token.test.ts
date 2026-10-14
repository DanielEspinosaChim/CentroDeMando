import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROAD_SIDS,
  getOrCreateLocalToken,
  restrictDataDir,
  TOKEN_FILE_NAME,
  tokensMatch,
} from './local-token.ts'

const FAKE_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/
const IS_WIN = process.platform === 'win32'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-token-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

type Call = { file: string; args: readonly string[] }

/** Exec falso: whoami devuelve CSV con un SID falso; icacls devuelve vacío. */
function fakeExec(onIcacls?: (call: Call) => void) {
  const calls: Call[] = []
  const exec = (file: string, args: readonly string[]): string => {
    const call = { file, args: [...args] }
    calls.push(call)
    if (path.win32.basename(file).toLowerCase() === 'whoami.exe') {
      return `"DOMINIO\\usuario con espacio","${FAKE_SID}"\r\n`
    }
    onIcacls?.(call)
    return ''
  }
  return { exec, calls }
}

describe('getOrCreateLocalToken (Windows, exec inyectado)', () => {
  it('llama a whoami y luego a icacls por ruta absoluta de System32 con argumentos exactos', () => {
    const { exec, calls } = fakeExec()
    const token = getOrCreateLocalToken(dir, { platform: 'win32', exec })

    expect(token).toMatch(BASE64URL_43)
    expect(calls).toHaveLength(2)

    const [who, acl] = calls
    const sys32 = (exe: string) =>
      path.win32.join(
        process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
        'System32',
        exe,
      )
    expect(who?.file).toBe(sys32('whoami.exe'))
    expect(path.win32.isAbsolute(who?.file ?? '')).toBe(true)
    expect(who?.args).toEqual(['/user', '/fo', 'csv', '/nh'])

    expect(acl?.file).toBe(sys32('icacls.exe'))
    expect(path.win32.isAbsolute(acl?.file ?? '')).toBe(true)
    expect(acl?.args).toEqual([
      path.join(dir, TOKEN_FILE_NAME),
      '/inheritance:r',
      '/grant:r',
      `*${FAKE_SID}:F`,
      '/remove:g',
      ...BROAD_SIDS,
    ])
  })

  it('crea el archivo vacío, aplica la ACL y solo después escribe el token', () => {
    const file = path.join(dir, TOKEN_FILE_NAME)
    let existedAtIcacls = false
    let contentAtIcacls: string | undefined
    const { exec } = fakeExec(() => {
      existedAtIcacls = fs.existsSync(file)
      contentAtIcacls = existedAtIcacls ? fs.readFileSync(file, 'utf8') : undefined
    })

    const token = getOrCreateLocalToken(dir, { platform: 'win32', exec })

    expect(existedAtIcacls).toBe(true)
    expect(contentAtIcacls).toBe('')
    expect(fs.readFileSync(file, 'utf8')).toBe(token)
  })

  it('crea el directorio de datos si no existe', () => {
    const nested = path.join(dir, 'a', 'b')
    const { exec } = fakeExec()
    const token = getOrCreateLocalToken(nested, { platform: 'win32', exec })
    expect(fs.readFileSync(path.join(nested, TOKEN_FILE_NAME), 'utf8')).toBe(token)
  })

  it('si el archivo existe con contenido corrupto, aplica la ACL antes de reescribirlo', () => {
    const file = path.join(dir, TOKEN_FILE_NAME)
    fs.writeFileSync(file, 'basura')
    let contentAtIcacls: string | undefined
    const { exec } = fakeExec(() => {
      contentAtIcacls = fs.readFileSync(file, 'utf8')
    })
    const token = getOrCreateLocalToken(dir, { platform: 'win32', exec })
    expect(contentAtIcacls).toBe('basura')
    expect(token).toMatch(BASE64URL_43)
    expect(fs.readFileSync(file, 'utf8')).toBe(token)
  })
})

describe('getOrCreateLocalToken (fallos de ACL)', () => {
  const failure = () => Object.assign(new Error('Command failed'), { status: 5 })

  it('si icacls falla: no lanza, devuelve token válido y avisa una vez sin filtrar el token', () => {
    const warnings: string[] = []
    const exec = (file: string): string => {
      if (path.win32.basename(file).toLowerCase() === 'whoami.exe') return `"x\\y","${FAKE_SID}"`
      throw failure()
    }
    let token = ''
    expect(() => {
      token = getOrCreateLocalToken(dir, {
        platform: 'win32',
        exec,
        onWarning: (m) => warnings.push(m),
      })
    }).not.toThrow()
    expect(token).toMatch(BASE64URL_43)
    expect(fs.readFileSync(path.join(dir, TOKEN_FILE_NAME), 'utf8')).toBe(token)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain(token)
    expect(warnings[0]).toContain('5')
  })

  it('si whoami falla: no lanza, no llama a icacls, avisa una vez sin el token', () => {
    const warnings: string[] = []
    const exec = vi.fn((_file: string): string => {
      throw failure()
    })
    const token = getOrCreateLocalToken(dir, {
      platform: 'win32',
      exec,
      onWarning: (m) => warnings.push(m),
    })
    expect(token).toMatch(BASE64URL_43)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain(token)
  })

  it('si whoami devuelve salida sin SID: avisa y no llama a icacls', () => {
    const warnings: string[] = []
    const exec = vi.fn((_file: string): string => 'sin sid')
    const token = getOrCreateLocalToken(dir, {
      platform: 'win32',
      exec,
      onWarning: (m) => warnings.push(m),
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain(token)
  })

  it('sin onWarning tampoco lanza', () => {
    const exec = (): string => {
      throw failure()
    }
    expect(getOrCreateLocalToken(dir, { platform: 'win32', exec })).toMatch(BASE64URL_43)
  })
})

describe('getOrCreateLocalToken (idempotencia y corrupción)', () => {
  it('dos llamadas devuelven el mismo token y se vuelve a aplicar la ACL', () => {
    const { exec, calls } = fakeExec()
    const a = getOrCreateLocalToken(dir, { platform: 'win32', exec })
    expect(calls).toHaveLength(2)
    const b = getOrCreateLocalToken(dir, { platform: 'win32', exec })
    expect(b).toBe(a)
    expect(calls).toHaveLength(4)
    expect(path.win32.basename(calls[2]?.file ?? '').toLowerCase()).toBe('whoami.exe')
    expect(path.win32.basename(calls[3]?.file ?? '').toLowerCase()).toBe('icacls.exe')
    expect(calls[3]?.args).toEqual(calls[1]?.args)
  })

  it('un token existente válido con espacios/salto de línea finales se acepta', () => {
    const { exec } = fakeExec()
    const a = getOrCreateLocalToken(dir, { platform: 'win32', exec })
    fs.writeFileSync(path.join(dir, TOKEN_FILE_NAME), `${a}\n`)
    expect(getOrCreateLocalToken(dir, { platform: 'win32', exec })).toBe(a)
  })

  it.each([
    ['vacío', ''],
    ['corto', 'abc'],
    ['largo', 'a'.repeat(44)],
    ['caracteres inválidos', `${'a'.repeat(42)}!`],
  ])('archivo corrupto (%s) genera un token nuevo válido', (_name, content) => {
    const { exec } = fakeExec()
    fs.writeFileSync(path.join(dir, TOKEN_FILE_NAME), content)
    const token = getOrCreateLocalToken(dir, { platform: 'win32', exec })
    expect(token).toMatch(BASE64URL_43)
    expect(token).not.toBe(content)
    expect(fs.readFileSync(path.join(dir, TOKEN_FILE_NAME), 'utf8')).toBe(token)
  })

  it('tokens generados en directorios distintos son distintos', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-token-'))
    try {
      const { exec } = fakeExec()
      const a = getOrCreateLocalToken(dir, { platform: 'win32', exec })
      const b = getOrCreateLocalToken(other, { platform: 'win32', exec })
      expect(a).not.toBe(b)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('tokensMatch', () => {
  it('iguales', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
  })
  it('distintos de la misma longitud', () => {
    expect(tokensMatch('abc', 'abd')).toBe(false)
  })
  it('longitud distinta', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false)
    expect(tokensMatch('abcd', 'abc')).toBe(false)
  })
  it('undefined', () => {
    expect(tokensMatch('abc', undefined)).toBe(false)
  })
  it('cadena vacía no coincide con un token no vacío', () => {
    expect(tokensMatch('abc', '')).toBe(false)
  })
})

describe('getOrCreateLocalToken (POSIX)', () => {
  it('con platform no-win32 no ejecuta comandos externos', () => {
    const exec = vi.fn((): string => '')
    const token = getOrCreateLocalToken(dir, { platform: 'linux', exec })
    expect(token).toMatch(BASE64URL_43)
    expect(exec).not.toHaveBeenCalled()
  })

  it('si chmod falla en POSIX avisa sin lanzar ni filtrar el token', () => {
    const warnings: string[] = []
    const spy = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    try {
      const token = getOrCreateLocalToken(dir, {
        platform: 'linux',
        onWarning: (m) => warnings.push(m),
      })
      expect(token).toMatch(BASE64URL_43)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).not.toContain(token)
    } finally {
      spy.mockRestore()
    }
  })

  it.runIf(!IS_WIN)('el archivo queda 0600, también si existía con permisos abiertos', () => {
    const file = path.join(dir, TOKEN_FILE_NAME)
    const token = getOrCreateLocalToken(dir)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    fs.chmodSync(file, 0o644)
    expect(getOrCreateLocalToken(dir)).toBe(token)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    fs.writeFileSync(file, 'corrupto')
    fs.chmodSync(file, 0o666)
    getOrCreateLocalToken(dir)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('getOrCreateLocalToken (ACL real en Windows)', () => {
  const icacls = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')

  /** Líneas de entrada de acceso de la salida de icacls (independiente del idioma). */
  function aclEntries(file: string): string[] {
    const out = execFileSync(icacls, [file], { encoding: 'utf8', windowsHide: true })
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(file, '').trim())
      .filter((l) => /:\(/.test(l))
  }

  it.runIf(IS_WIN)('archivo nuevo: sin herencia y una única entrada, la del usuario actual', () => {
    getOrCreateLocalToken(dir)
    const file = path.join(dir, TOKEN_FILE_NAME)
    const entries = aclEntries(file)
    expect(entries.some((e) => e.includes('(I)'))).toBe(false)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.toLowerCase()).toContain(os.userInfo().username.toLowerCase())
    expect(entries[0]).toContain('(F)')
  })

  it.runIf(IS_WIN)('archivo preexistente con ACL heredada queda endurecido', () => {
    const file = path.join(dir, TOKEN_FILE_NAME)
    fs.writeFileSync(file, 'contenido previo corrupto')
    // Según la máquina, el archivo nace con entradas heredadas (I) o explícitas (runners de
    // GitHub): en ambos casos tiene más de una entrada antes de endurecerlo.
    expect(aclEntries(file).length).toBeGreaterThan(1)

    const warnings: string[] = []
    const token = getOrCreateLocalToken(dir, { onWarning: (m) => warnings.push(m) })

    expect(warnings).toEqual([])
    const entries = aclEntries(file)
    expect(entries.some((e) => e.includes('(I)'))).toBe(false)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.toLowerCase()).toContain(os.userInfo().username.toLowerCase())
    expect(fs.readFileSync(file, 'utf8')).toBe(token)
  })

  it.runIf(IS_WIN)('token válido preexistente con ACL heredada: se conserva y se endurece', () => {
    const file = path.join(dir, TOKEN_FILE_NAME)
    const existing = 'A'.repeat(43)
    fs.writeFileSync(file, existing)
    expect(getOrCreateLocalToken(dir)).toBe(existing)
    const entries = aclEntries(file)
    expect(entries.some((e) => e.includes('(I)'))).toBe(false)
    expect(entries).toHaveLength(1)
  })

  it.runIf(IS_WIN)(
    'quita entradas EXPLÍCITAS de SYSTEM y Administradores (caso runner de CI)',
    () => {
      const file = path.join(dir, TOKEN_FILE_NAME)
      fs.writeFileSync(file, 'B'.repeat(43))
      execFileSync(icacls, [file, '/grant', '*S-1-5-18:F', '*S-1-5-32-544:F', '*S-1-3-0:F'], {
        windowsHide: true,
      })
      expect(aclEntries(file).length).toBeGreaterThan(1)
      getOrCreateLocalToken(dir)
      const entries = aclEntries(file)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toContain(os.userInfo().username)
    },
  )

  it.runIf(IS_WIN)('el propietario sigue pudiendo leer el token tras la ACL e idempotencia', () => {
    const a = getOrCreateLocalToken(dir)
    const b = getOrCreateLocalToken(dir)
    expect(b).toBe(a)
    expect(fs.readFileSync(path.join(dir, TOKEN_FILE_NAME), 'utf8')).toBe(a)
    expect(aclEntries(path.join(dir, TOKEN_FILE_NAME))).toHaveLength(1)
  })
})

describe('restrictDataDir (Windows, exec inyectado)', () => {
  const sys32 = (exe: string) =>
    path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', exe)

  it('whoami + icacls por ruta absoluta de System32, con (OI)(CI)F y sin shell', () => {
    const target = path.join(dir, 'datos')
    const { exec, calls } = fakeExec()
    restrictDataDir(target, { platform: 'win32', exec })

    expect(fs.statSync(target).isDirectory()).toBe(true)
    expect(calls).toHaveLength(2)
    const [who, acl] = calls
    expect(who?.file).toBe(sys32('whoami.exe'))
    expect(who?.args).toEqual(['/user', '/fo', 'csv', '/nh'])
    expect(acl?.file).toBe(sys32('icacls.exe'))
    expect(path.win32.isAbsolute(acl?.file ?? '')).toBe(true)
    expect(acl?.args).toEqual([
      path.resolve(target),
      '/inheritance:r',
      '/grant:r',
      `*${FAKE_SID}:(OI)(CI)F`,
      '/remove:g',
      ...BROAD_SIDS,
    ])
    // Sin shell: cada argumento es un elemento propio, nada de una línea de comandos.
    expect(acl?.args.every((a) => !/[&|;<>]/.test(a))).toBe(true)
  })

  it('el permiso del directorio hereda a hijos; el del archivo del token no', () => {
    const { exec, calls } = fakeExec()
    restrictDataDir(dir, { platform: 'win32', exec })
    getOrCreateLocalToken(dir, { platform: 'win32', exec })
    const grants = calls.filter((c) => c.args.includes('/grant:r')).map((c) => c.args[3])
    expect(grants).toEqual([`*${FAKE_SID}:(OI)(CI)F`, `*${FAKE_SID}:F`])
  })

  it('crea la carpeta (con padres) si no existe', () => {
    const nested = path.join(dir, 'a', 'b')
    restrictDataDir(nested, { platform: 'win32', exec: fakeExec().exec })
    expect(fs.statSync(nested).isDirectory()).toBe(true)
  })

  it('si icacls falla: no lanza y avisa una vez sin datos sensibles', () => {
    const warnings: string[] = []
    const exec = (file: string): string => {
      if (path.win32.basename(file).toLowerCase() === 'whoami.exe') return `"x\\y","${FAKE_SID}"`
      throw Object.assign(new Error(`Command failed: ${FAKE_SID} secreto`), { status: 5 })
    }
    expect(() =>
      restrictDataDir(dir, { platform: 'win32', exec, onWarning: (m) => warnings.push(m) }),
    ).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('5')
    expect(warnings[0]).not.toContain(FAKE_SID)
    expect(warnings[0]).not.toContain('secreto')
  })

  it('si whoami falla: no lanza, no llama a icacls y avisa', () => {
    const warnings: string[] = []
    const exec = vi.fn((_file: string): string => {
      throw Object.assign(new Error('boom'), { status: 1 })
    })
    expect(() =>
      restrictDataDir(dir, { platform: 'win32', exec, onWarning: (m) => warnings.push(m) }),
    ).not.toThrow()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveLength(1)
  })

  it('sin onWarning tampoco lanza', () => {
    const exec = (): string => {
      throw new Error('x')
    }
    expect(() => restrictDataDir(dir, { platform: 'win32', exec })).not.toThrow()
  })

  it('en POSIX no ejecuta comandos externos', () => {
    const exec = vi.fn((_file: string): string => '')
    restrictDataDir(path.join(dir, 'p'), { platform: 'linux', exec })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('restrictDataDir (ACL real en Windows)', () => {
  const icacls = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')

  function aclEntries(target: string): string[] {
    const out = execFileSync(icacls, [target], { encoding: 'utf8', windowsHide: true })
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(target, '').trim())
      .filter((l) => /:\(/.test(l))
  }

  it.runIf(IS_WIN)(
    'la carpeta queda sin herencia con una sola entrada del usuario y los hijos la heredan',
    () => {
      const data = path.join(dir, 'datos')
      const warnings: string[] = []
      restrictDataDir(data, { onWarning: (m) => warnings.push(m) })
      expect(warnings).toEqual([])

      const dirEntries = aclEntries(data)
      expect(dirEntries).toHaveLength(1)
      expect(dirEntries.some((e) => e.includes('(I)'))).toBe(false)
      expect(dirEntries[0]?.toLowerCase()).toContain(os.userInfo().username.toLowerCase())
      expect(dirEntries[0]).toContain('(OI)')
      expect(dirEntries[0]).toContain('(CI)')
      expect(dirEntries[0]).toContain('(F)')

      // Un archivo creado después hereda solo esa entrada.
      const child = path.join(data, 'data.db')
      fs.writeFileSync(child, 'x')
      const childEntries = aclEntries(child)
      expect(childEntries).toHaveLength(1)
      expect(childEntries[0]).toContain('(I)')
      expect(childEntries[0]?.toLowerCase()).toContain(os.userInfo().username.toLowerCase())

      // También una subcarpeta nueva hereda solo la entrada del usuario.
      const sub = path.join(data, 'sub')
      fs.mkdirSync(sub)
      expect(aclEntries(sub)).toHaveLength(1)
    },
  )

  it.runIf(IS_WIN)('es idempotente y el propietario sigue pudiendo leer y escribir', () => {
    const data = path.join(dir, 'datos2')
    restrictDataDir(data)
    restrictDataDir(data)
    expect(aclEntries(data)).toHaveLength(1)
    fs.writeFileSync(path.join(data, 'f.txt'), 'ok')
    expect(fs.readFileSync(path.join(data, 'f.txt'), 'utf8')).toBe('ok')
  })
})
