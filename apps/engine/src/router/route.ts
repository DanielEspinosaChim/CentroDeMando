import {
  type AgentRole,
  MODEL_ORDER,
  type ModelTier,
  RISK_FLOOR_MODEL,
  type RouterConfig,
  type RoutingDecision,
  type RoutingSource,
} from '@cdm/shared'
import { type Classifier, ruleClassifier } from './classifier.ts'

export interface RouteInput {
  prompt: string
  role: AgentRole
  /** Modelo pedido explícitamente por el usuario (override). */
  requestedModel?: ModelTier
  /** Fallos seguidos de la cadena de reintentos antes de esta ejecución (0 en una tarea nueva). */
  consecutiveFailures: number
  /** Modelo de la ejecución que falló (solo en reintentos): un reintento nunca baja de él. */
  previousModel?: ModelTier
}

export interface RouteResult {
  decision: RoutingDecision
  /** Avisos para el usuario (evento `router.warning`). */
  warnings: string[]
}

function rank(model: ModelTier): number {
  return MODEL_ORDER.indexOf(model)
}

/** Un nivel más arriba (haiku → sonnet → opus; opus se mantiene). */
export function oneLevelUp(model: ModelTier): ModelTier {
  return MODEL_ORDER[Math.min(rank(model) + 1, MODEL_ORDER.length - 1)] ?? model
}

/**
 * Decide el modelo de una tarea. Función pura y determinista (criterio 10): misma entrada,
 * misma salida; no lee reloj, disco ni estado global.
 *
 * Pasos: override → tamaño (modelo base) → piso de riesgo → no bajar del modelo que ya
 * falló → escalamiento. Un override del usuario se respeta siempre (sin piso ni
 * escalamiento) y, si queda bajo el piso de riesgo, deja una advertencia.
 */
export function route(
  input: RouteInput,
  config: RouterConfig,
  classifier: Classifier = ruleClassifier,
): RouteResult {
  const { size, risk, reasons: classReasons } = classifier.classify(input.prompt, config)
  const reasons = [...classReasons]
  const warnings: string[] = []

  if (input.requestedModel) {
    const model = input.requestedModel
    reasons.push(`Modelo indicado por el usuario: ${model}.`)
    if (risk === 'high' && rank(model) < rank(RISK_FLOOR_MODEL)) {
      warnings.push(
        `La tarea toca un tema sensible y el modelo indicado (${model}) está por debajo del piso de riesgo (${RISK_FLOOR_MODEL}). Se respeta la elección del usuario.`,
      )
    }
    return { decision: { model, size, risk, reasons, source: 'override' }, warnings }
  }

  let model: ModelTier
  let source: RoutingSource
  if (size === 'small') {
    model = 'haiku'
    source = 'rule'
    reasons.push('Tarea chica → haiku.')
  } else if (size === 'large') {
    model = 'opus'
    source = 'rule'
    reasons.push('Tarea grande → opus.')
  } else {
    model = config.roleDefaults[input.role]
    // `medium` (de un clasificador que lo produzca) sale del rol pero por regla; `unknown`,
    // de no tener señales claras.
    source = size === 'medium' ? 'rule' : 'role_default'
    reasons.push(`Modelo por defecto del rol ${input.role}: ${model}.`)
  }

  if (risk === 'high' && rank(model) < rank(RISK_FLOOR_MODEL)) {
    reasons.push(`Piso de riesgo: ${model} → ${RISK_FLOOR_MODEL}.`)
    model = RISK_FLOOR_MODEL
  }

  if (input.previousModel && rank(model) < rank(input.previousModel)) {
    reasons.push(`Un reintento no baja del modelo que ya falló: ${model} → ${input.previousModel}.`)
    model = input.previousModel
  }

  if (input.consecutiveFailures >= config.escalateAfterFailures) {
    const up = oneLevelUp(model)
    reasons.push(
      up === model
        ? `${input.consecutiveFailures} fallos seguidos: ${model} ya es el nivel más alto, se mantiene.`
        : `${input.consecutiveFailures} fallos seguidos: se sube un nivel, ${model} → ${up}.`,
    )
    model = up
    source = 'escalation'
  }

  return { decision: { model, size, risk, reasons, source }, warnings }
}
