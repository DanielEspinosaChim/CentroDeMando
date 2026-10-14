import { describe, expect, it } from 'vitest'
import { CreateAgentInput, EngineEvent, StartTaskInput } from '../index.ts'
import { CreateProjectInput } from './project.ts'

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0'

describe('CreateAgentInput', () => {
  it('acepta datos válidos', () => {
    expect(CreateAgentInput.parse({ name: 'Ana', role: 'qa', projectId: ID })).toMatchObject({
      name: 'Ana',
    })
  })
  it('rechaza nombre vacío o de más de 40 caracteres', () => {
    expect(CreateAgentInput.safeParse({ name: '', role: 'qa', projectId: ID }).success).toBe(false)
    expect(
      CreateAgentInput.safeParse({ name: 'x'.repeat(41), role: 'qa', projectId: ID }).success,
    ).toBe(false)
  })
  it('rechaza rol y modelo fuera del enum', () => {
    expect(CreateAgentInput.safeParse({ name: 'a', role: 'jefe', projectId: ID }).success).toBe(
      false,
    )
    expect(
      CreateAgentInput.safeParse({ name: 'a', role: 'qa', projectId: ID, defaultModel: 'gpt' })
        .success,
    ).toBe(false)
  })
  it('rechaza campos desconocidos', () => {
    expect(
      CreateAgentInput.safeParse({ name: 'a', role: 'qa', projectId: ID, workspaceId: 'x' })
        .success,
    ).toBe(false)
  })
})

describe('StartTaskInput', () => {
  it('limita el prompt a 20 000 caracteres', () => {
    expect(StartTaskInput.safeParse({ prompt: 'x'.repeat(20_000) }).success).toBe(true)
    expect(StartTaskInput.safeParse({ prompt: 'x'.repeat(20_001) }).success).toBe(false)
  })
})

describe('CreateProjectInput', () => {
  it('limita el nombre a 80 caracteres', () => {
    expect(CreateProjectInput.safeParse({ name: 'x'.repeat(81), path: 'C:/tmp' }).success).toBe(
      false,
    )
  })
})

describe('EngineEvent', () => {
  it('discrimina por tipo y valida contextUsedPct entre 0 y 100', () => {
    const ok = EngineEvent.safeParse({
      type: 'agent.usage',
      agentId: ID,
      runId: ID,
      at: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      contextUsedPct: 50,
    })
    expect(ok.success).toBe(true)
    const bad = EngineEvent.safeParse({
      type: 'agent.usage',
      agentId: ID,
      runId: ID,
      at: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
      contextUsedPct: 101,
    })
    expect(bad.success).toBe(false)
  })
})
