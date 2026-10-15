import { normalizeText, type RiskLevel, type RouterConfig, type TaskSize } from '@cdm/shared'
import { CORE_RISK_KEYWORDS } from './default-config.ts'

export { normalizeText }

/** Resultado de clasificar una tarea: tamaño, riesgo y las razones legibles de ambos. */
export interface Classification {
  size: TaskSize
  risk: RiskLevel
  reasons: string[]
}

/**
 * Clasifica el tamaño y el riesgo de una tarea. Hoy solo existe `RuleClassifier`
 * (determinista); un clasificador con un modelo podría añadirse detrás de esta interfaz.
 */
export interface Classifier {
  classify(prompt: string, config: RouterConfig): Classification
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

/**
 * Primera palabra clave que aparece en el texto (ya normalizado). La palabra debe empezar
 * en un borde de palabra (así "texto" no coincide dentro de "contexto"), pero puede
 * continuar (plurales y conjugaciones: "colores", "refactorizar"). Si la palabra clave
 * empieza por un signo (".env"), no se exige borde.
 */
export function findKeyword(text: string, keywords: readonly string[]): string | undefined {
  for (const keyword of keywords) {
    const needle = normalizeText(keyword)
    if (!needle) continue
    const needsBoundary = isWordChar(needle[0])
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at === -1) break
      if (!needsBoundary || !isWordChar(text[at - 1])) return keyword
      from = at + 1
    }
  }
  return undefined
}

/**
 * Primera palabra de riesgo que aparece en el texto (ya normalizado), por subcadena y sin
 * exigir borde de palabra: así se detecta dentro de identificadores camelCase o snake_case
 * ("userPassword", "accessToken", "DB_PASSWORD"). Produce falsos positivos ("apagar"
 * contiene "pagar", "author" contiene "auth"), pero el error va al lado seguro: la tarea
 * solo sube a sonnet.
 */
export function findRiskKeyword(text: string, keywords: readonly string[]): string | undefined {
  for (const keyword of keywords) {
    const needle = normalizeText(keyword)
    if (needle && text.includes(needle)) return keyword
  }
  return undefined
}

/** Palabra de riesgo del texto normalizado: lista base fija + la de la configuración. */
function classifyRisk(text: string, config: RouterConfig): string | undefined {
  return findRiskKeyword(text, [...CORE_RISK_KEYWORDS, ...config.riskKeywords])
}

/**
 * Solo el riesgo de un prompt (sin tamaño): lo usa la reanudación con prompt nuevo, que no
 * re-enruta pero no puede saltarse el piso de riesgo.
 */
export function classifyPromptRisk(
  prompt: string,
  config: RouterConfig,
): { risk: RiskLevel; keyword?: string } {
  const keyword = classifyRisk(normalizeText(prompt), config)
  return keyword ? { risk: 'high', keyword } : { risk: 'normal' }
}

/** Clasificador por reglas: palabras clave configurables y longitud del prompt. */
export class RuleClassifier implements Classifier {
  classify(prompt: string, config: RouterConfig): Classification {
    const text = normalizeText(prompt)
    const reasons: string[] = []

    let size: TaskSize = 'unknown'
    const large = findKeyword(text, config.largeKeywords)
    if (large) {
      size = 'large'
      reasons.push(`Señal de tarea grande: "${large}".`)
    } else {
      const small = findKeyword(text, config.smallKeywords)
      if (small && text.length < config.smallMaxChars) {
        size = 'small'
        reasons.push(
          `Señal de tarea chica ("${small}") y prompt corto (menos de ${config.smallMaxChars} caracteres).`,
        )
      } else if (small) {
        // Plan, paso 2: una señal chica en un prompt largo no es una señal clara de tamaño.
        // `medium` queda reservado para un clasificador futuro detrás de `Classifier`.
        reasons.push(
          `Señal de tarea chica ("${small}"), pero el prompt es largo (${config.smallMaxChars} caracteres o más): sin señal clara de tamaño.`,
        )
      } else {
        reasons.push('Sin señales claras de tamaño.')
      }
    }

    // La lista base siempre se aplica: la configuración solo puede añadir palabras de riesgo.
    const risky = classifyRisk(text, config)
    const risk: RiskLevel = risky ? 'high' : 'normal'
    if (risky) reasons.push(`Menciona un tema sensible ("${risky}"): riesgo alto.`)

    return { size, risk, reasons }
  }
}

export const ruleClassifier = new RuleClassifier()
