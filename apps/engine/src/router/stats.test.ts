import { describe, expect, it } from 'vitest'
import { aggregateRouterStats, type StatsRunRow } from './stats.ts'

const row = (over: Partial<StatsRunRow>): StatsRunRow => ({
  agentId: 'A',
  model: 'sonnet',
  costUsd: 0.1,
  resumed: false,
  ...over,
})

describe('aggregateRouterStats', () => {
  it('C003-9 cuenta ejecuciones y suma el costo por modelo', () => {
    const stats = aggregateRouterStats([
      row({ model: 'haiku', costUsd: 0.01 }),
      row({ model: 'haiku', costUsd: 0.02 }),
      row({ model: 'opus', costUsd: 0.5 }),
      row({ agentId: 'B', model: 'sonnet', costUsd: null }),
    ])
    expect(stats.models).toEqual([
      { model: 'haiku', runs: 2, costUsd: 0.03, runsWithoutCost: 0 },
      { model: 'sonnet', runs: 1, costUsd: 0, runsWithoutCost: 1 },
      { model: 'opus', runs: 1, costUsd: 0.5, runsWithoutCost: 0 },
    ])
    expect(stats.totalRuns).toBe(4)
    expect(stats.totalCostUsd).toBe(0.53)
  })

  it('C003-9 una reanudación suma solo su incremento sobre la sesión (costo acumulado)', () => {
    const stats = aggregateRouterStats([
      row({ costUsd: 0.3 }),
      row({ costUsd: 0.5, resumed: true }),
      // Nueva sesión del mismo agente: vuelve a contar desde cero.
      row({ costUsd: 0.2 }),
      // Un costo que baja (transcript sin total) se suma entero.
      row({ costUsd: 0.1, resumed: true }),
    ])
    const sonnet = stats.models.find((m) => m.model === 'sonnet')
    expect(sonnet).toMatchObject({ runs: 4, costUsd: 0.8 })
  })

  it('sin ejecuciones devuelve ceros para los tres modelos', () => {
    const stats = aggregateRouterStats([])
    expect(stats.models.map((m) => m.model)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(stats.totalRuns).toBe(0)
    expect(stats.totalCostUsd).toBe(0)
  })
})
