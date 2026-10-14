import { describe, expect, it } from 'vitest'
import { RATE_LIMIT_WINDOW_MS, RateLimiter } from './rate-limit.ts'

function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

describe('RateLimiter', () => {
  it('permite hasta el límite y rechaza el siguiente', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 3, now: c.now })
    for (let i = 0; i < 3; i++) expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
    expect(rl.hit('a').allowed).toBe(false)
  })

  it('Retry-After es ≥ 1 y redondea hacia arriba', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 1, now: c.now })
    rl.hit('a')
    expect(rl.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 60 })
    c.advance(1)
    // Faltan 59 999 ms → 60 s (redondeo hacia arriba).
    expect(rl.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 60 })
    c.advance(999)
    // Faltan 59 000 ms exactos.
    expect(rl.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 59 })
    c.advance(1)
    // Faltan 58 999 ms → 59 s.
    expect(rl.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 59 })
  })

  it('Retry-After mínimo 1 aunque falte menos de 1000 ms', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 1, now: c.now })
    rl.hit('a')
    c.advance(RATE_LIMIT_WINDOW_MS - 1)
    expect(rl.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it('se recupera al avanzar el reloj más allá de la ventana', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 2, now: c.now })
    rl.hit('a')
    rl.hit('a')
    expect(rl.hit('a').allowed).toBe(false)
    c.advance(RATE_LIMIT_WINDOW_MS)
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
  })

  it('las claves son independientes', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 1, now: c.now })
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
    expect(rl.hit('b').allowed).toBe(true)
  })

  it('un rechazo no consume cupo ni alarga el bloqueo', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 1, now: c.now })
    rl.hit('a')
    c.advance(30_000)
    for (let i = 0; i < 5; i++) rl.hit('a')
    c.advance(30_000)
    expect(rl.hit('a').allowed).toBe(true)
  })

  it('ventana deslizante: no deja pasar el doble en el borde', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 3, now: c.now })
    c.advance(59_000)
    for (let i = 0; i < 3; i++) expect(rl.hit('a').allowed).toBe(true)
    // 2 s después una ventana fija ya habría reiniciado; la deslizante no.
    c.advance(2_000)
    expect(rl.hit('a').allowed).toBe(false)
    c.advance(58_000)
    expect(rl.hit('a').allowed).toBe(true)
  })

  it('los cupos se liberan escalonadamente', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 2, now: c.now })
    rl.hit('a')
    c.advance(10_000)
    rl.hit('a')
    c.advance(50_000) // sale la primera marca, la segunda sigue
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
  })

  it('maxKeys acota la memoria descartando las claves más antiguas', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 5, now: c.now, maxKeys: 3 })
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      rl.hit(k)
      c.advance(1)
    }
    expect(rl.size).toBe(3)
  })

  it('limpia claves viejas al consultar tras una ventana', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 5, now: c.now })
    for (let i = 0; i < 50; i++) rl.hit(`k${i}`)
    expect(rl.size).toBe(50)
    c.advance(RATE_LIMIT_WINDOW_MS + 1)
    rl.hit('nueva')
    expect(rl.size).toBe(1)
  })

  it('sweep() elimina solo las claves totalmente expiradas', () => {
    const c = clock()
    const rl = new RateLimiter({ limit: 5, now: c.now })
    rl.hit('vieja')
    c.advance(40_000)
    rl.hit('reciente')
    c.advance(30_000)
    rl.sweep()
    expect(rl.size).toBe(1)
  })
})
