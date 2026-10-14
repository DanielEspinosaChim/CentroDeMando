import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './client.ts'
import { createStore, type RunTotals, type Store } from './store.ts'

const TOTALS: RunTotals = { inputTokens: 9, outputTokens: 8, costUsd: 0.7, contextUsedPct: 33 }

describe('Store: escrituras acotadas por workspaceId', () => {
  let store: Store
  let agentId: string
  let runId: string

  beforeEach(() => {
    store = createStore(openDb(':memory:').db)
    const project = store.createProject('A', 'P', 'C:/p')
    agentId = store.createAgent('A', {
      projectId: project.id,
      name: 'X',
      role: 'qa',
      defaultModel: 'sonnet',
    }).id
    runId = store.createRun('A', agentId, 'hola', 'sonnet').id
  })

  it('setAgentStatus con workspace ajeno no modifica nada', () => {
    store.setAgentStatus('B', agentId, 'error')
    expect(store.getAgent('A', agentId)?.status).toBe('idle')
    store.setAgentStatus('A', agentId, 'paused')
    expect(store.getAgent('A', agentId)?.status).toBe('paused')
  })

  it('setAgentSession con workspace ajeno no modifica nada', () => {
    store.setAgentSession('B', agentId, 'sesion-ajena')
    expect(store.getAgent('A', agentId)?.sdkSessionId).toBeNull()
    store.setAgentSession('A', agentId, 'sesion-propia')
    expect(store.getAgent('A', agentId)?.sdkSessionId).toBe('sesion-propia')
  })

  it('setRunStatus con workspace ajeno no modifica nada', () => {
    store.setRunStatus('B', runId, 'done', true)
    expect(store.lastRun('A', agentId)).toMatchObject({ status: 'thinking', endedAt: null })
    store.setRunStatus('A', runId, 'done', true)
    expect(store.lastRun('A', agentId)?.status).toBe('done')
    expect(store.lastRun('A', agentId)?.endedAt).not.toBeNull()
  })

  it('setRunTotals con workspace ajeno no modifica nada', () => {
    store.setRunTotals('B', runId, TOTALS)
    expect(store.lastRun('A', agentId)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      contextUsedPct: null,
    })
    store.setRunTotals('A', runId, TOTALS)
    expect(store.lastRun('A', agentId)).toMatchObject(TOTALS)
  })

  it('sessionRunCosts y lastRun no ven ejecuciones de otro workspace', () => {
    store.setRunTotals('A', runId, TOTALS)
    expect(store.sessionRunCosts('B', agentId)).toEqual([])
    expect(store.lastRun('B', agentId)).toBeUndefined()
    expect(store.sessionRunCosts('A', agentId)).toEqual([0.7])
  })
})
