import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrCreateLocalToken, TOKEN_FILE_NAME, tokensMatch } from './local-token.ts'

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
      '*S-1-1-0',
      '*S-1-5-11',
      '*S-1-5-32-545',
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
    expect(aclEntries(file).some((e) => e.includes('(I)'))).toBe(true)

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

  it.runIf(IS_WIN)('el propietario sigue pudiendo leer el token tras la ACL e idempotencia', () => {
    const a = getOrCreateLocalToken(dir)
    const b = getOrCreateLocalToken(dir)
    expect(b).toBe(a)
    expect(fs.readFileSync(path.join(dir, TOKEN_FILE_NAME), 'utf8')).toBe(a)
    expect(aclEntries(path.join(dir, TOKEN_FILE_NAME))).toHaveLength(1)
  })
})
