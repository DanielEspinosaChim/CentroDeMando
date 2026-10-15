import { describe, expect, it } from 'vitest'
import { BusLimits, MAX_MESSAGES_PER_MINUTE, MAX_WAKE_DEPTH, nextDepth } from './limits.ts'

describe('BusLimits', () => {
  it('C002-6 el mensaje 21 dentro de 60 s falla; pasada la ventana vuelve a haber cupo', () => {
    expect(MAX_MESSAGES_PER_MINUTE).toBe(20)
    let t = 1_000_000
    const limits = new BusLimits({ now: () => t })
    for (let i = 0; i < 20; i++) {
      expect(limits.tryConsume('local', 'A')).toBe(true)
      t += 1000
    }
    expect(limits.tryConsume('local', 'A')).toBe(false)
    // El cupo es por agente y por workspace.
    expect(limits.tryConsume('local', 'B')).toBe(true)
    expect(limits.tryConsume('otro', 'A')).toBe(true)
    // Ventana deslizante: a los 60 s del primer envío se libera una unidad, no veinte.
    t = 1_000_000 + 60_001
    expect(limits.tryConsume('local', 'A')).toBe(true)
    expect(limits.tryConsume('local', 'A')).toBe(false)
  })

  it('C002-7 profundidad: hasta 10 despertares encadenados; el 11 no despierta', () => {
    expect(MAX_WAKE_DEPTH).toBe(10)
    const limits = new BusLimits()
    let parent: { depth: number } | undefined
    const woke: boolean[] = []
    for (let i = 0; i < 11; i++) {
      const depth = nextDepth([parent], true)
      woke.push(limits.canWake(depth))
      parent = { depth }
    }
    expect(woke.slice(0, 10).every(Boolean)).toBe(true)
    expect(woke[10]).toBe(false)
  })

  it('nextDepth toma el mayor antecedente y solo suma si hay wake', () => {
    expect(nextDepth([], false)).toBe(0)
    expect(nextDepth([undefined], true)).toBe(1)
    expect(nextDepth([{ depth: 2 }, { depth: 7 }], true)).toBe(8)
    expect(nextDepth([{ depth: 7 }], false)).toBe(7)
    // Sin wake no hay despertar que contar.
    expect(new BusLimits().canWake(0)).toBe(false)
  })
})
