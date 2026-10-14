import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TOKEN_FILE_NAME = 'local-token'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Lee el token local de `dataDir`, o lo genera si no existe o está corrupto.
 * El archivo se crea con permisos solo del usuario (en Windows `%APPDATA%` ya es
 * privado del usuario; `mode` aplica en POSIX). El token nunca se registra en logs.
 */
export function getOrCreateLocalToken(dataDir: string): string {
  const file = path.join(dataDir, TOKEN_FILE_NAME)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  fs.mkdirSync(dataDir, { recursive: true })
  const token = randomBytes(32).toString('base64url')
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
