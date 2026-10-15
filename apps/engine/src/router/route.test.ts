import { AgentRole, type ModelTier, type RouterConfig } from '@cdm/shared'
import { describe, expect, it } from 'vitest'
import { findKeyword, normalizeText, RuleClassifier } from './classifier.ts'
import { CORE_RISK_KEYWORDS, DEFAULT_ROUTER_CONFIG } from './default-config.ts'
import { oneLevelUp, type RouteInput, route } from './route.ts'

const config: RouterConfig = DEFAULT_ROUTER_CONFIG
const ROLES = AgentRole.options

function input(over: Partial<RouteInput> = {}): RouteInput {
  return { prompt: 'Revisa el repo', role: 'implementador', consecutiveFailures: 0, ...over }
}

describe('normalización y palabras clave', () => {
  it('"Contraseña" y "contrasena" se detectan igual', () => {
    expect(normalizeText('  Cambia la CONTRASEÑA\n del   admin ')).toBe(
      'cambia la contrasena del admin',
    )
    const classifier = new RuleClassifier()
    expect(classifier.classify('Cambia la Contraseña', config).risk).toBe('high')
    expect(classifier.classify('cambia la contrasena', config).risk).toBe('high')
  })

  it('la palabra clave empieza en borde de palabra pero admite plurales', () => {
    expect(findKeyword('revisa el contexto', ['texto'])).toBeUndefined()
    expect(findKeyword('cambia los colores', ['color'])).toBe('color')
    expect(findKeyword('lee el archivo .env.local', ['.env'])).toBe('.env')
  })
})

describe('route()', () => {
  it.each(ROLES)('C003-2 tarea trivial con rol %s → haiku, small', (role) => {
    const { decision } = route(input({ role, prompt: 'Cambia el color del botón a azul' }), config)
    expect(decision).toMatchObject({
      model: 'haiku',
      size: 'small',
      risk: 'normal',
      source: 'rule',
    })
    expect(decision.reasons.length).toBeGreaterThan(0)
  })

  it.each(ROLES)('C003-3 tarea grande con rol %s → opus, large', (role) => {
    const { decision } = route(
      input({ role, prompt: 'Diseña la arquitectura del módulo de pagos' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'opus', size: 'large', source: 'rule' })
  })

  const expectedDefaults: Record<string, ModelTier> = {
    coordinador: 'opus',
    planeador: 'opus',
    seguridad: 'opus',
    implementador: 'sonnet',
    qa: 'sonnet',
    disenador: 'sonnet',
    documentador: 'haiku',
  }
  it.each(ROLES)('C003-4 sin señales de tamaño, rol %s → modelo por defecto del rol', (role) => {
    const { decision } = route(input({ role, prompt: 'Revisa el repo y dime qué ves' }), config)
    expect(decision).toMatchObject({
      model: expectedDefaults[role],
      size: 'unknown',
      source: 'role_default',
    })
  })

  it('C003-4 una señal chica en un prompt largo no cuenta como señal clara', () => {
    const prompt = `Cambia el color del encabezado. ${'Contexto adicional. '.repeat(20)}`
    const { decision } = route(input({ role: 'qa', prompt }), config)
    expect(decision).toMatchObject({ model: 'sonnet', size: 'unknown', source: 'role_default' })
  })

  it.each([
    'Cambia el token del botón',
    'Corrige el typo en el texto del pago',
    'Renombra la variable password',
    'Cambia el color del .env',
    'Ajusta el texto del permiso',
  ])('C003-5 tarea chica con tema sensible ("%s") nunca va a haiku', (prompt) => {
    for (const role of ROLES) {
      const { decision, warnings } = route(input({ role, prompt }), config)
      expect(decision.risk).toBe('high')
      expect(decision.model).not.toBe('haiku')
      expect(warnings).toEqual([])
    }
  })

  it('C003-5 el piso de riesgo no se desactiva vaciando la configuración', () => {
    const relaxed: RouterConfig = {
      ...config,
      riskKeywords: ['zzz'],
      roleDefaults: { ...config.roleDefaults, documentador: 'haiku' },
    }
    for (const word of CORE_RISK_KEYWORDS) {
      const { decision } = route(
        input({ role: 'documentador', prompt: `Cambia el color de ${word}` }),
        relaxed,
      )
      expect(decision.risk).toBe('high')
      expect(decision.model).toBe('sonnet')
    }
  })

  it('C003-6 un modelo explícito se respeta con source = override', () => {
    const { decision, warnings } = route(
      input({ prompt: 'Diseña la arquitectura', requestedModel: 'haiku' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'haiku', source: 'override', size: 'large' })
    expect(warnings).toEqual([])
  })

  it('C003-6 override por debajo del piso de riesgo → se respeta y advierte', () => {
    const { decision, warnings } = route(
      input({ prompt: 'Cambia la contraseña del admin', requestedModel: 'haiku' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'haiku', source: 'override', risk: 'high' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/piso de riesgo/)
  })

  it('C003-6 override en el piso o por encima no advierte', () => {
    for (const requestedModel of ['sonnet', 'opus'] as const) {
      const { warnings } = route(input({ prompt: 'Rota el token', requestedModel }), config)
      expect(warnings).toEqual([])
    }
  })

  it('C003-7 escalamiento haiku → sonnet → opus → opus', () => {
    expect(oneLevelUp('haiku')).toBe('sonnet')
    expect(oneLevelUp('sonnet')).toBe('opus')
    expect(oneLevelUp('opus')).toBe('opus')

    const prompt = 'Cambia el color del botón a azul'
    // Primer reintento (1 fallo): aún no escala y no baja del modelo que falló.
    const first = route(input({ prompt, consecutiveFailures: 1, previousModel: 'haiku' }), config)
    expect(first.decision).toMatchObject({ model: 'haiku', source: 'rule' })
    // Tras dos fallos seguidos, sube un nivel desde el modelo que falló.
    const chain: ModelTier[] = []
    let previous: ModelTier = 'haiku'
    for (const failures of [2, 3, 4]) {
      const { decision } = route(
        input({ prompt, consecutiveFailures: failures, previousModel: previous }),
        config,
      )
      expect(decision.source).toBe('escalation')
      chain.push(decision.model)
      previous = decision.model
    }
    expect(chain).toEqual(['sonnet', 'opus', 'opus'])
  })

  it('C003-7 el umbral de escalamiento sale de la configuración', () => {
    const eager: RouterConfig = { ...config, escalateAfterFailures: 1 }
    const { decision } = route(
      input({ prompt: 'Revisa el repo', consecutiveFailures: 1, previousModel: 'sonnet' }),
      eager,
    )
    expect(decision).toMatchObject({ model: 'opus', source: 'escalation' })
  })

  it('C003-7 un override en el reintento se respeta sin escalar', () => {
    const { decision } = route(
      input({ consecutiveFailures: 5, previousModel: 'opus', requestedModel: 'sonnet' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'sonnet', source: 'override' })
  })

  it('C003-10 determinismo: 100 llamadas con la misma entrada dan la misma salida', () => {
    const cases: RouteInput[] = [
      input({ prompt: 'Cambia el color del botón a azul', role: 'qa' }),
      input({ prompt: 'Diseña la arquitectura del módulo de pagos' }),
      input({ prompt: 'Rota el token', requestedModel: 'haiku' }),
      input({ prompt: 'Revisa el repo', consecutiveFailures: 3, previousModel: 'sonnet' }),
    ]
    for (const c of cases) {
      const first = route(c, config)
      for (let i = 0; i < 100; i++) expect(route(structuredClone(c), config)).toEqual(first)
    }
  })

  it('C003-10 no modifica la entrada ni la configuración', () => {
    const c = input({ prompt: 'Cambia el token', consecutiveFailures: 2, previousModel: 'haiku' })
    const cfg = structuredClone(config)
    const before = { c: structuredClone(c), cfg: structuredClone(cfg) }
    route(c, cfg)
    expect(c).toEqual(before.c)
    expect(cfg).toEqual(before.cfg)
  })
})
