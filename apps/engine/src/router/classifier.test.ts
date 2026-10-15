import { describe, expect, it } from 'vitest'
import { findKeyword, findRiskKeyword, ruleClassifier } from './classifier.ts'
import { DEFAULT_ROUTER_CONFIG } from './default-config.ts'

const config = DEFAULT_ROUTER_CONFIG

function riskOf(prompt: string) {
  return ruleClassifier.classify(prompt, config).risk
}

describe('piso de riesgo dentro de identificadores (H1)', () => {
  it.each([
    'renombra userPassword a pwd',
    'cambia accessToken por at',
    'renombra DB_PASSWORD a DB_PWD',
    'mueve CLAUDE_CODE_OAUTH_TOKEN al otro archivo',
    'renombra mySecretValue',
    'cambia el color de paymentButton',
  ])('C003-5 "%s" es riesgo alto aunque la palabra esté dentro de un identificador', (prompt) => {
    expect(riskOf(prompt)).toBe('high')
  })

  it('C003-5 también aplica a las palabras de riesgo de la configuración', () => {
    const custom = { ...config, riskKeywords: ['nomina'] }
    expect(ruleClassifier.classify('renombra calcNominaMensual', custom).risk).toBe('high')
  })

  it('findRiskKeyword no exige borde de palabra; findKeyword sí', () => {
    expect(findRiskKeyword('userpassword', ['password'])).toBe('password')
    expect(findKeyword('userpassword', ['password'])).toBeUndefined()
  })

  it('las listas de tamaño siguen con borde de palabra', () => {
    expect(ruleClassifier.classify('revisa el contexto', config).size).toBe('unknown')
  })
})

describe('sinónimos de riesgo en la lista base (H2)', () => {
  it.each([
    'cambia la clave del wifi',
    'agrega el botón de pagar',
    'agrega cobrar al menú',
    'renueva la autenticación',
    'configura OAuth',
    'valida el JWT',
    'agrega la llave SSH',
    'renueva el certificado',
    'renew the certificate',
    'borra la cookie de sesión',
  ])('C003-5 "%s" es riesgo alto', (prompt) => {
    expect(riskOf(prompt)).toBe('high')
  })

  it('C003-5 la lista base aplica aunque la configuración no tenga esas palabras', () => {
    const custom = { ...config, riskKeywords: ['zzz'] }
    for (const p of ['cambia la clave', 'valida el jwt', 'borra la cookie', 'usa auth']) {
      expect(ruleClassifier.classify(p, custom).risk).toBe('high')
    }
  })
})

// Con `String.fromCodePoint` para que los caracteres invisibles no se pierdan al editar.
const ZWSP = String.fromCodePoint(0x200b)
const SOFT_HYPHEN = String.fromCodePoint(0xad)
const WORD_JOINER = String.fromCodePoint(0x2060)
const FULLWIDTH_TOKEN = String.fromCodePoint(0xff54, 0xff4f, 0xff4b, 0xff45, 0xff4e)

describe('normalización contra caracteres invisibles y compatibilidad (H3)', () => {
  it.each([
    ['espacio de ancho cero', `cambia la pass${ZWSP}word`],
    ['guion suave', `cambia el to${SOFT_HYPHEN}ken`],
    ['ancho completo', `cambia el ${FULLWIDTH_TOKEN}`],
    ['unión de palabras', `cambia el se${WORD_JOINER}cret`],
  ])('C003-5 con %s sigue siendo riesgo alto', (_name, prompt) => {
    expect(riskOf(prompt)).toBe('high')
  })
})
