import { describe, expect, it } from 'vitest'
import { SdkAgentRunner } from '../src/agents/sdk-runner.ts'

describe('la suite no hace llamadas reales al SDK', () => {
  it('C001-11 SdkAgentRunner.run() falla dentro de los tests en vez de llamar al SDK real', () => {
    const runner = new SdkAgentRunner()
    expect(() =>
      runner.run({
        prompt: 'hola',
        model: 'haiku',
        role: 'qa',
        cwd: process.cwd(),
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        signal: new AbortController().signal,
      }),
    ).toThrow(/Llamada real al SDK/)
  })
})
