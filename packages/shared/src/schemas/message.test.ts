import { describe, expect, it } from 'vitest'
import {
  BusLimitEvent,
  BusMessageEvent,
  EngineEvent,
  MAX_MESSAGE_BODY_LENGTH,
  MessageHistoryQuery,
  PostMessageInput,
  SendMessageInput,
} from '../index.ts'

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0'

describe('SendMessageInput', () => {
  it('acepta destinatario por nombre, id o "*"', () => {
    for (const to of ['Ana', ID, '*']) {
      expect(SendMessageInput.safeParse({ to, body: 'hola' }).success).toBe(true)
    }
  })

  it('C002-8 rechaza un body vacío (o solo espacios) y uno de más de 8 000 caracteres', () => {
    expect(MAX_MESSAGE_BODY_LENGTH).toBe(8000)
    expect(SendMessageInput.safeParse({ to: 'Ana', body: '' }).success).toBe(false)
    expect(SendMessageInput.safeParse({ to: 'Ana', body: '   \n ' }).success).toBe(false)
    expect(SendMessageInput.safeParse({ to: 'Ana', body: 'x'.repeat(8000) }).success).toBe(true)
    expect(SendMessageInput.safeParse({ to: 'Ana', body: 'x'.repeat(8001) }).success).toBe(false)
  })

  it('rechaza campos desconocidos: el remitente nunca viene del agente', () => {
    expect(SendMessageInput.safeParse({ to: 'Ana', body: 'hola', from: 'usuario' }).success).toBe(
      false,
    )
  })

  it('valida replyToId como id y wake como booleano', () => {
    expect(SendMessageInput.safeParse({ to: 'Ana', body: 'x', replyToId: 'no' }).success).toBe(
      false,
    )
    expect(SendMessageInput.safeParse({ to: 'Ana', body: 'x', wake: 'si' }).success).toBe(false)
    expect(
      SendMessageInput.safeParse({ to: 'Ana', body: 'x', replyToId: ID, wake: true }).success,
    ).toBe(true)
  })
})

describe('PostMessageInput', () => {
  it('C002-8 aplica los mismos límites de body', () => {
    expect(PostMessageInput.safeParse({ to: ID, body: '' }).success).toBe(false)
    expect(PostMessageInput.safeParse({ to: ID, body: 'x'.repeat(8001) }).success).toBe(false)
  })

  it('solo acepta id de agente o "*"', () => {
    expect(PostMessageInput.safeParse({ to: ID, body: 'hola' }).success).toBe(true)
    expect(PostMessageInput.safeParse({ to: '*', body: 'hola', wake: true }).success).toBe(true)
    expect(PostMessageInput.safeParse({ to: 'Ana', body: 'hola' }).success).toBe(false)
    expect(PostMessageInput.safeParse({ to: ID, body: 'hola', replyToId: ID }).success).toBe(false)
  })
})

describe('MessageHistoryQuery', () => {
  it('limit por defecto 50, máximo 100, cursor opcional', () => {
    expect(MessageHistoryQuery.parse({})).toEqual({ limit: 50 })
    expect(MessageHistoryQuery.parse({ limit: '100', cursor: ID })).toEqual({
      limit: 100,
      cursor: ID,
    })
    expect(MessageHistoryQuery.safeParse({ limit: '101' }).success).toBe(false)
    expect(MessageHistoryQuery.safeParse({ limit: '0' }).success).toBe(false)
    expect(MessageHistoryQuery.safeParse({ cursor: 'x' }).success).toBe(false)
  })
})

describe('eventos del bus', () => {
  it('bus.message y bus.limit forman parte de EngineEvent', () => {
    const message = {
      type: 'bus.message',
      agentId: ID,
      runId: null,
      at: 1,
      id: ID,
      from: ID,
      to: ID,
      threadId: ID,
      replyToId: null,
      wake: false,
      depth: 0,
    }
    expect(BusMessageEvent.safeParse(message).success).toBe(true)
    expect(EngineEvent.safeParse(message).success).toBe(true)
    expect(EngineEvent.safeParse({ ...message, agentId: null, from: 'usuario' }).success).toBe(true)
    const limit = {
      type: 'bus.limit',
      agentId: ID,
      runId: null,
      at: 1,
      reason: 'max_depth',
      threadId: ID,
      message: 'x',
    }
    expect(BusLimitEvent.safeParse(limit).success).toBe(true)
    expect(EngineEvent.safeParse({ ...limit, reason: 'otro' }).success).toBe(false)
  })
})
