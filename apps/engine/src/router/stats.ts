import { MODEL_ORDER, type ModelTier, type RouterStats } from '@cdm/shared'

/** Fila mínima de una ejecución para las estadísticas (orden: agente, cronológico). */
export interface StatsRunRow {
  agentId: string
  model: ModelTier
  costUsd: number | null
  resumed: boolean
}

/** Redondeo a micro-dólares para no arrastrar ruido de coma flotante en la respuesta. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Ejecuciones y costo estimado por modelo (criterio 9). Las filas deben venir ya filtradas
 * por `workspaceId` y ordenadas por agente y fecha.
 *
 * El `costUsd` de una reanudación es acumulado de la sesión (ver `sessionSpentUsd` en
 * `agents/manager.ts`), así que sumarlo tal cual contaría doble: dentro de cada sesión se
 * suma solo lo que crece respecto al último reportado, y si baja se suma entero. Una
 * reanudación siempre usa el modelo de la ejecución original, así que el incremento se
 * atribuye al modelo de su fila. Las ejecuciones sin costo reportado se cuentan aparte y
 * no suman (es una estadística, no un tope: aquí no se sobrestima).
 */
export function aggregateRouterStats(rows: readonly StatsRunRow[]): RouterStats {
  const byModel = new Map<ModelTier, { runs: number; costUsd: number; runsWithoutCost: number }>(
    MODEL_ORDER.map((m) => [m, { runs: 0, costUsd: 0, runsWithoutCost: 0 }]),
  )
  let agentId: string | undefined
  let lastReported = 0
  for (const row of rows) {
    if (row.agentId !== agentId || !row.resumed) {
      agentId = row.agentId
      lastReported = 0
    }
    const entry = byModel.get(row.model)
    if (!entry) continue
    entry.runs++
    const cost = row.costUsd
    if (cost === null || !Number.isFinite(cost) || cost < 0) {
      entry.runsWithoutCost++
      continue
    }
    entry.costUsd += cost >= lastReported ? cost - lastReported : cost
    lastReported = cost
  }
  const models = MODEL_ORDER.map((model) => {
    const e = byModel.get(model) ?? { runs: 0, costUsd: 0, runsWithoutCost: 0 }
    return { model, runs: e.runs, costUsd: round(e.costUsd), runsWithoutCost: e.runsWithoutCost }
  })
  return {
    models,
    totalRuns: models.reduce((n, m) => n + m.runs, 0),
    totalCostUsd: round(models.reduce((n, m) => n + m.costUsd, 0)),
  }
}
