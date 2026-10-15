import { describe, expect, it } from 'vitest'
import { EngineEvent } from './events.ts'
import { normalizeText, RetryInput, RouterConfig } from './router.ts'

const decision = {
  model: 'haiku',
  size: 'small',
  risk: 'normal',
  reasons: ['Tarea chica → haiku.'],
  source: 'rule',
}
const base = { agentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', runId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', at: 1 }

describe('esquemas del enrutador', () => {
  it('C003-1 router.decision y router.warning son eventos válidos del motor', () => {
    expect(
      EngineEvent.safeParse({
        type: 'router.decision',
        ...base,
        decision,
        retryOfRunId: null,
        consecutiveFailures: 0,
      }).success,
    ).toBe(true)
    expect(
      EngineEvent.safeParse({ type: 'router.warning', ...base, message: 'aviso' }).success,
    ).toBe(true)
    expect(
      EngineEvent.safeParse({
        type: 'router.decision',
        ...base,
        decision: { ...decision, source: 'magia' },
        retryOfRunId: null,
        consecutiveFailures: 0,
      }).success,
    ).toBe(false)
  })

  it('RouterConfig exige todos los roles y riskKeywords no vacía', () => {
    const roleDefaults = {
      coordinador: 'opus',
      planeador: 'opus',
      implementador: 'sonnet',
      qa: 'sonnet',
      seguridad: 'opus',
      disenador: 'sonnet',
      documentador: 'haiku',
    }
    const ok = {
      roleDefaults,
      smallKeywords: [],
      largeKeywords: [],
      riskKeywords: ['token'],
      smallMaxChars: 200,
      escalateAfterFailures: 2,
    }
    expect(RouterConfig.safeParse(ok).success).toBe(true)
    expect(RouterConfig.safeParse({ ...ok, riskKeywords: [] }).success).toBe(false)
    const { qa: _qa, ...missingQa } = roleDefaults
    expect(RouterConfig.safeParse({ ...ok, roleDefaults: missingQa }).success).toBe(false)
    // Una palabra hecha solo de diacríticos quedaría vacía al normalizar.
    expect(RouterConfig.safeParse({ ...ok, smallKeywords: ['́'] }).success).toBe(false)
  })

  it('RetryInput acepta vacío o un modelo y rechaza campos extra', () => {
    expect(RetryInput.safeParse({}).success).toBe(true)
    expect(RetryInput.safeParse({ model: 'opus' }).success).toBe(true)
    expect(RetryInput.safeParse({ model: 'gpt' }).success).toBe(false)
    expect(RetryInput.safeParse({ prompt: 'x' }).success).toBe(false)
  })

  it('normalizeText quita acentos, pasa a minúsculas y colapsa espacios', () => {
    expect(normalizeText('  Diseña   el MÓDULO ')).toBe('disena el modulo')
  })

  it('normalizeText aplica NFKC y quita caracteres de formato invisibles', () => {
    // Con `String.fromCodePoint` para que los caracteres invisibles no se pierdan al editar.
    const cp = (...points: number[]) => String.fromCodePoint(...points)
    expect(normalizeText(`pass${cp(0x200b)}word`)).toBe('password')
    expect(normalizeText(`to${cp(0xad)}ken${cp(0xfeff)}`)).toBe('token')
    expect(normalizeText(cp(0xff34, 0xff4f, 0xff4b, 0xff45, 0xff4e))).toBe('token')
    expect(normalizeText(`${cp(0xfb01)}le`)).toBe('file')
  })
})
