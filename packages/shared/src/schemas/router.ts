import { z } from 'zod'
import { AgentRole, ModelTier } from './agent.ts'
import { RiskLevel, RoutingSource, TaskSize } from './routing.ts'

/** Orden de los modelos de menor a mayor capacidad (para pisos y escalamiento). */
export const MODEL_ORDER: readonly ModelTier[] = ['haiku', 'sonnet', 'opus']

/** Modelo mínimo para tareas de riesgo alto. Fijo en código: la configuración no lo cambia. */
export const RISK_FLOOR_MODEL: ModelTier = 'sonnet'

/** Decisión del enrutador: qué modelo y por qué (criterio 1). */
export const RoutingDecision = z.object({
  model: ModelTier,
  size: TaskSize,
  risk: RiskLevel,
  reasons: z.array(z.string()),
  source: RoutingSource,
})
export type RoutingDecision = z.infer<typeof RoutingDecision>

/**
 * Normaliza texto para comparar palabras clave: NFKC (formas de compatibilidad: letras de
 * ancho completo, ligaduras), sin caracteres de formato invisibles (`\p{Cf}`: espacio de
 * ancho cero, guion suave, BOM…), sin acentos ni diacríticos, minúsculas y espacios
 * colapsados. "Contraseña", "contrasena" y "pass​word" → "password" quedan iguales.
 *
 * Riesgo residual (aceptado): no se resuelven homoglifos de otros alfabetos ("pаssword" con
 * "а" cirílica) ni leet ("p4ssw0rd"). El piso de riesgo es una red de seguridad por reglas,
 * no un control frente a un usuario que quiera esquivarlo a propósito.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export const MAX_KEYWORDS = 200
export const MAX_KEYWORD_LENGTH = 60

const Keyword = z
  .string()
  .trim()
  .min(1)
  .max(MAX_KEYWORD_LENGTH)
  // Una palabra hecha solo de diacríticos quedaría vacía al normalizar y coincidiría con todo.
  .refine((k) => normalizeText(k).length > 0, 'palabra clave vacía al normalizar')

const KeywordList = z.array(Keyword).max(MAX_KEYWORDS)

/** Configuración editable del enrutador (`router-config.json`). */
export const RouterConfig = z.strictObject({
  roleDefaults: z.record(AgentRole, ModelTier),
  smallKeywords: KeywordList,
  largeKeywords: KeywordList,
  // Nunca vacía; además, el motor siempre aplica una lista base de riesgo que no se puede quitar.
  riskKeywords: KeywordList.min(1, 'riskKeywords no puede quedar vacía'),
  smallMaxChars: z.number().int().min(1).max(20_000),
  escalateAfterFailures: z.number().int().min(1).max(10),
})
export type RouterConfig = z.infer<typeof RouterConfig>

/** Cuerpo de `POST /agents/:id/tasks/:runId/retry`. */
export const RetryInput = z.strictObject({
  /** Modelo explícito para el reintento (se respeta como override, sin escalamiento). */
  model: ModelTier.optional(),
})
export type RetryInput = z.infer<typeof RetryInput>

export const ModelStats = z.object({
  model: ModelTier,
  runs: z.number().int().nonnegative(),
  /** Suma de lo reportado; las reanudaciones cuentan solo su incremento sobre la sesión. */
  costUsd: z.number().nonnegative(),
  /** Ejecuciones sin costo reportado (cerradas antes de su resultado): no suman al costo. */
  runsWithoutCost: z.number().int().nonnegative(),
})
export type ModelStats = z.infer<typeof ModelStats>

export const RouterStats = z.object({
  models: z.array(ModelStats),
  totalRuns: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
})
export type RouterStats = z.infer<typeof RouterStats>
