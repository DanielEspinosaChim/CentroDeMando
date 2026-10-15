import { AgentRole, type ModelTier, type RouterConfig } from '@cdm/shared'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_CONFIG } from './default-config.ts'
import { type RouteInput, route } from './route.ts'

// Validación independiente (QA) del enrutador: casos límite y adversariales de `route()`.

const config: RouterConfig = DEFAULT_ROUTER_CONFIG
const ROLES = AgentRole.options

function input(over: Partial<RouteInput> = {}): RouteInput {
  return { prompt: 'Revisa el repo', role: 'implementador', consecutiveFailures: 0, ...over }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

describe('C003-5 normalización de palabras de riesgo', () => {
  it.each([
    'Cambia la CONTRASEÑA del admin',
    'cambia la contrasena del admin',
    'Cambia la Contraseña del admin',
    // Misma palabra con la ñ descompuesta (n + tilde combinada), como la pega un teclado Mac.
    'cambia la contraseña del admin',
    'Rotate the PASSWORD',
    'Rotate the Password.',
    'Guarda el SECRET en el servidor',
    'Guarda el Secreto',
    'Revisa la API KEY',
    'Revisa la  api   key', // espacios múltiples
    'Cambia la CREDENCIAL',
    'Actualiza el TOKEN',
    'Abre el archivo .ENV',
    'Arregla el PAGO duplicado',
    'Cambia el PERMISO del usuario',
  ])('"%s" → risk high y nunca haiku, con cualquier rol', (prompt) => {
    for (const role of ROLES) {
      const { decision } = route(input({ role, prompt }), config)
      expect(decision.risk, `${role}: ${prompt}`).toBe('high')
      expect(decision.model, `${role}: ${prompt}`).not.toBe('haiku')
    }
  })

  it('C003-5 una palabra de riesgo con tilde en la configuración también coincide sin tilde', () => {
    const cfg: RouterConfig = { ...config, riskKeywords: ['Autenticación'] }
    const { decision } = route(input({ prompt: 'arregla la autenticacion' }), cfg)
    expect(decision.risk).toBe('high')
  })

  it('C003-5 prompt sin tema sensible no se marca como riesgo (sin falso positivo por "contexto")', () => {
    const { decision } = route(input({ prompt: 'Cambia el color del fondo' }), config)
    expect(decision.risk).toBe('normal')
    expect(decision.model).toBe('haiku')
  })
})

describe('C003-5 el riesgo gana sobre el tamaño', () => {
  it.each(ROLES)('palabra chica ("typo") + riesgo, rol %s → nunca haiku', (role) => {
    const { decision } = route(input({ role, prompt: 'Corrige el typo en la contraseña' }), config)
    expect(decision.size).toBe('small')
    expect(decision.risk).toBe('high')
    expect(decision.model).toBe('sonnet')
    expect(decision.reasons.join(' ')).toMatch(/Piso de riesgo/)
  })

  it('palabra chica + riesgo con rol opus → se mantiene opus (el piso no baja nada)', () => {
    const { decision } = route(
      input({ role: 'seguridad', prompt: 'Corrige el typo en el token' }),
      config,
    )
    // Tarea chica → haiku → piso → sonnet. (El rol no pesa cuando hay señal de tamaño.)
    expect(decision.model).toBe('sonnet')
  })

  it('palabra grande + riesgo → opus (el piso no la baja)', () => {
    const { decision } = route(
      input({ prompt: 'Diseña la arquitectura del módulo de pagos con tokens' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'opus', size: 'large', risk: 'high', source: 'rule' })
  })

  it('palabra grande + palabra chica → gana la grande', () => {
    const { decision } = route(input({ prompt: 'Refactor del color del botón' }), config)
    expect(decision).toMatchObject({ model: 'opus', size: 'large' })
  })

  it('rol documentador (haiku) + riesgo sin señal de tamaño → sube a sonnet por el piso', () => {
    const { decision } = route(
      input({ role: 'documentador', prompt: 'Documenta el flujo de pago' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'sonnet', risk: 'high', source: 'role_default' })
  })

  it('el piso se aplica aunque la configuración ponga a todos los roles en haiku', () => {
    const allHaiku: RouterConfig = {
      ...config,
      roleDefaults: Object.fromEntries(
        ROLES.map((r) => [r, 'haiku']),
      ) as RouterConfig['roleDefaults'],
    }
    for (const role of ROLES) {
      const { decision } = route(input({ role, prompt: 'Revisa el password' }), allHaiku)
      expect(decision.model).toBe('sonnet')
    }
  })

  it('el piso se aplica aunque smallKeywords/largeKeywords estén vacías y riskKeywords tenga una sola palabra', () => {
    const minimal: RouterConfig = {
      ...config,
      smallKeywords: [],
      largeKeywords: [],
      riskKeywords: ['zzz'],
    }
    const { decision } = route(input({ role: 'documentador', prompt: 'Cambia el token' }), minimal)
    expect(decision.risk).toBe('high')
    expect(decision.model).toBe('sonnet')
  })

  it('las razones no copian el contenido del prompt (un secreto pegado no se filtra)', () => {
    // Valor falso armado en ejecución para que el escáner de secretos no lo confunda con uno real.
    const secret = ['sk', 'live', 'ABCDEF0123456789'].join('-')
    const { decision, warnings } = route(
      input({ prompt: `Cambia el color, el token es ${secret}`, requestedModel: 'haiku' }),
      config,
    )
    expect(JSON.stringify(decision)).not.toContain(secret)
    expect(JSON.stringify(warnings)).not.toContain(secret)
  })
})

describe('C003-2 / C003-4 frontera de longitud para la señal chica', () => {
  // `smallMaxChars` por defecto = 200; la longitud se mide sobre el texto normalizado.
  const withLength = (n: number) => `color${'x'.repeat(n - 5)}`

  it('199 caracteres con palabra chica → small / haiku', () => {
    const { decision } = route(input({ prompt: withLength(199) }), config)
    expect(decision).toMatchObject({ size: 'small', model: 'haiku' })
  })

  it('exactamente smallMaxChars (200) con palabra chica → sin señal clara, modelo del rol', () => {
    const { decision } = route(input({ role: 'qa', prompt: withLength(200) }), config)
    expect(decision).toMatchObject({ size: 'unknown', model: 'sonnet', source: 'role_default' })
  })

  it('prompt muy largo (≥ smallMaxChars) con palabra chica + riesgo → riesgo alto y nunca haiku', () => {
    const prompt = `Cambia el color. ${'relleno '.repeat(60)} y la contraseña`
    const { decision } = route(input({ role: 'documentador', prompt }), config)
    expect(decision.risk).toBe('high')
    expect(decision.model).not.toBe('haiku')
  })

  it('smallMaxChars de la configuración se respeta', () => {
    const cfg: RouterConfig = { ...config, smallMaxChars: 10 }
    expect(route(input({ prompt: 'color azul' }), cfg).decision.size).toBe('unknown')
    expect(route(input({ prompt: 'color' }), cfg).decision.size).toBe('small')
  })
})

describe('C003-6 override', () => {
  it('override haiku + riesgo → haiku respetado, source override y exactamente un aviso', () => {
    const { decision, warnings } = route(
      input({ prompt: 'Cambia el password', requestedModel: 'haiku' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'haiku', source: 'override', risk: 'high' })
    expect(warnings).toHaveLength(1)
  })

  it('override haiku sin riesgo → sin aviso', () => {
    const { decision, warnings } = route(
      input({ prompt: 'Diseña la arquitectura', requestedModel: 'haiku' }),
      config,
    )
    expect(decision.model).toBe('haiku')
    expect(warnings).toEqual([])
  })

  it('override no se escala aunque haya muchos fallos ni sube por el modelo previo', () => {
    const { decision } = route(
      input({ requestedModel: 'haiku', consecutiveFailures: 9, previousModel: 'opus' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'haiku', source: 'override' })
  })
})

describe('C003-7 cadena de escalamiento', () => {
  const chain = (start: ModelTier, prompt: string, steps = 5) => {
    const out: Array<{ model: ModelTier; source: string }> = []
    let previous = start
    for (let failures = 1; failures <= steps; failures++) {
      const { decision } = route(
        input({ prompt, consecutiveFailures: failures, previousModel: previous }),
        config,
      )
      out.push({ model: decision.model, source: decision.source })
      previous = decision.model
    }
    return out
  }

  it('haiku → haiku (1 fallo) → sonnet → opus → opus → opus', () => {
    expect(chain('haiku', 'Cambia el color del botón').map((c) => c.model)).toEqual([
      'haiku',
      'sonnet',
      'opus',
      'opus',
      'opus',
    ])
  })

  it('con 1 fallo no hay escalamiento (source rule) y con ≥ 2 sí', () => {
    const sources = chain('haiku', 'Cambia el color del botón').map((c) => c.source)
    expect(sources).toEqual(['rule', 'escalation', 'escalation', 'escalation', 'escalation'])
  })

  it('opus se mantiene en opus y lo dice en las razones', () => {
    const { decision } = route(
      input({ prompt: 'Diseña la arquitectura', consecutiveFailures: 2, previousModel: 'opus' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'opus', source: 'escalation' })
    expect(decision.reasons.join(' ')).toMatch(/ya es el nivel más alto/)
  })

  it('un reintento nunca baja del modelo que falló (sonnet falló, la regla diría haiku)', () => {
    const { decision } = route(
      input({
        prompt: 'Cambia el color del botón',
        consecutiveFailures: 1,
        previousModel: 'sonnet',
      }),
      config,
    )
    expect(decision.model).toBe('sonnet')
  })

  it('tarea de riesgo que falló en haiku (override): el piso sube a sonnet y luego escala a opus', () => {
    const { decision } = route(
      input({ prompt: 'Cambia el token', consecutiveFailures: 2, previousModel: 'haiku' }),
      config,
    )
    expect(decision).toMatchObject({ model: 'opus', source: 'escalation', risk: 'high' })
  })

  it('consecutiveFailures 0 sin modelo previo = tarea nueva sin escalamiento', () => {
    const { decision } = route(input({ prompt: 'Cambia el color' }), config)
    expect(decision.source).toBe('rule')
  })
})

describe('C003-10 pureza y determinismo', () => {
  it('funciona con entrada y configuración congeladas (no muta nada)', () => {
    const frozenInput = deepFreeze(
      input({ prompt: 'Cambia el token', consecutiveFailures: 2, previousModel: 'haiku' }),
    )
    const frozenConfig = deepFreeze(structuredClone(config))
    expect(() => route(frozenInput, frozenConfig)).not.toThrow()
  })

  it('la decisión devuelta no comparte referencias con la configuración', () => {
    const cfg = structuredClone(config)
    const { decision } = route(input({ prompt: 'Revisa el repo' }), cfg)
    decision.reasons.push('manipulada')
    cfg.riskKeywords.push('x')
    expect(route(input({ prompt: 'Revisa el repo' }), cfg).decision.reasons).not.toContain(
      'manipulada',
    )
  })

  it('el orden de llamadas no importa: intercalar entradas distintas no cambia los resultados', () => {
    const a = input({ prompt: 'Cambia el color', role: 'qa' })
    const b = input({ prompt: 'Rota el token', role: 'documentador' })
    const ra = route(a, config)
    const rb = route(b, config)
    for (let i = 0; i < 20; i++) {
      expect(route(b, config)).toEqual(rb)
      expect(route(a, config)).toEqual(ra)
    }
  })

  it('un prompt de 500 000 caracteres se decide rápido (sin backtracking)', () => {
    const prompt = `${'contexto texto '.repeat(35_000)} contraseña`
    const started = Date.now()
    const { decision } = route(input({ prompt }), config)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(decision.risk).toBe('high')
  })
})
