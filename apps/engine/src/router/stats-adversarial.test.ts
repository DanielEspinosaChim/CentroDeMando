import { describe, expect, it } from 'vitest'
import { aggregateRouterStats, type StatsRunRow } from './stats.ts'

const row = (over: Partial<StatsRunRow>): StatsRunRow => ({
  agentId: 'A',
  model: 'sonnet',
  costUsd: 0.1,
  resumed: false,
  ...over,
})

const costOf = (rows: StatsRunRow[], model: StatsRunRow['model']) =>
  aggregateRouterStats(rows).models.find((m) => m.model === model)

describe('C003-9 aggregateRouterStats casos límite', () => {
  it('cadena de varias reanudaciones: cada una suma solo su incremento', () => {
    const stats = costOf(
      [
        row({ costUsd: 0.1 }),
        row({ costUsd: 0.25, resumed: true }),
        row({ costUsd: 0.25, resumed: true }),
        row({ costUsd: 0.6, resumed: true }),
      ],
      'sonnet',
    )
    expect(stats).toMatchObject({ runs: 4, costUsd: 0.6 })
  })

  it('agentes intercalados no mezclan sus sesiones', () => {
    const stats = aggregateRouterStats([
      row({ agentId: 'A', costUsd: 0.4 }),
      row({ agentId: 'A', costUsd: 0.6, resumed: true }),
      row({ agentId: 'B', costUsd: 0.5, resumed: true }), // reanudada sin fila previa de B: cuenta entera
    ])
    expect(stats.totalCostUsd).toBe(1.1)
  })

  it('una ejecución sin costo dentro de una sesión no reinicia el acumulado', () => {
    const stats = costOf(
      [
        row({ costUsd: 0.3 }),
        row({ costUsd: null, resumed: true }),
        row({ costUsd: 0.5, resumed: true }),
      ],
      'sonnet',
    )
    expect(stats).toMatchObject({ runs: 3, runsWithoutCost: 1, costUsd: 0.5 })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'costo inválido (%s) se trata como sin costo y no contamina el total',
    (bad) => {
      const stats = aggregateRouterStats([row({ costUsd: bad }), row({ costUsd: 0.2 })])
      expect(stats.totalCostUsd).toBe(0.2)
      expect(stats.models.find((m) => m.model === 'sonnet')?.runsWithoutCost).toBe(1)
    },
  )

  it('costo cero cuenta como costo reportado (no como "sin costo")', () => {
    const stats = costOf([row({ costUsd: 0 })], 'sonnet')
    expect(stats).toMatchObject({ runs: 1, runsWithoutCost: 0, costUsd: 0 })
  })

  it('sin ruido de coma flotante: 0.1 + 0.2 se informa como 0.3', () => {
    const stats = aggregateRouterStats([row({ costUsd: 0.1 }), row({ costUsd: 0.2 })])
    expect(stats.totalCostUsd).toBe(0.3)
  })

  it('no muta las filas de entrada', () => {
    const rows = Object.freeze([Object.freeze(row({ costUsd: 0.1 }))])
    expect(() => aggregateRouterStats(rows)).not.toThrow()
  })
})
