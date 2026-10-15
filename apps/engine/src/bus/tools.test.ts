import { EmptyToolInput, SendMessageInput } from '@cdm/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openDb } from '../db/client.ts'
import { createStore, type Store } from '../db/store.ts'
import { EventHub } from '../events/hub.ts'
import { MessageBus } from './bus.ts'
import { DATA_NOTICE } from './delivery.ts'
import {
  BUS_MCP_TOOL_NAMES,
  type BusTools,
  busToolDefinitions,
  createBusMcpServer,
  createBusTools,
} from './tools.ts'

describe('herramientas del bus', () => {
  let store: Store
  let bus: MessageBus
  let a: string
  let b: string
  let toolsA: BusTools
  let toolsB: BusTools

  beforeEach(() => {
    store = createStore(openDb(':memory:').db)
    bus = new MessageBus({ store, hub: new EventHub() })
    const project = store.createProject('local', 'P', 'C:/p')
    const mk = (name: string) =>
      store.createAgent('local', {
        projectId: project.id,
        name,
        role: 'qa',
        defaultModel: 'sonnet',
      }).id
    a = mk('Ana')
    b = mk('Beto')
    const state = () => ({ runId: null, context: null })
    toolsA = createBusTools(bus, 'local', a, state)
    toolsB = createBusTools(bus, 'local', b, state)
  })

  it('C002-1 send_message desde la herramienta guarda con el agente dueño como remitente', () => {
    const res = toolsA.call('send_message', { to: 'Beto', body: 'hola' })
    expect(res.ok).toBe(true)
    const [sent] = JSON.parse(res.text).enviados
    expect(store.getMessage('local', sent.id)).toMatchObject({ fromAgentId: a, toAgentId: b })
  })

  it('C002-3 errores de validación o destinatario vuelven a la herramienta sin detalles internos', () => {
    expect(toolsA.call('send_message', { to: 'Nadie', body: 'x' })).toEqual({
      ok: false,
      text: 'Destinatario no encontrado',
    })
    const empty = toolsA.call('send_message', { to: 'Beto', body: '' })
    expect(empty.ok).toBe(false)
    expect(empty.text).toMatch(/body/)
    expect(toolsA.call('send_message', null).ok).toBe(false)
    expect(toolsA.call('read_inbox', { extra: 1 }).ok).toBe(false)
  })

  it('C002-11 read_inbox devuelve los mensajes propios marcados como datos y los marca read', () => {
    toolsA.call('send_message', { to: 'Beto', body: 'para Beto' })
    expect(toolsA.call('read_inbox', {}).text).toBe('No tienes mensajes sin leer.')
    const inbox = toolsB.call('read_inbox', {})
    expect(inbox.ok).toBe(true)
    expect(inbox.text).toContain(DATA_NOTICE)
    expect(inbox.text).toContain('para Beto')
    expect(store.readInbox('local', b)).toEqual([])
  })

  it('list_agents lista nombre, rol y estado', () => {
    const { agentes } = JSON.parse(toolsA.call('list_agents', {}).text)
    expect(agentes).toEqual([
      expect.objectContaining({ id: a, name: 'Ana', role: 'qa', status: 'idle', self: true }),
      expect.objectContaining({ id: b, name: 'Beto', self: false }),
    ])
  })

  it('servidor MCP en proceso con las tres herramientas y esquemas convertibles a JSON Schema', async () => {
    const defs = busToolDefinitions(toolsA)
    expect(defs.map((d) => `mcp__bus__${d.name}`)).toEqual([...BUS_MCP_TOOL_NAMES])
    // Si un esquema no se puede convertir, el SDK deja la herramienta fuera en silencio.
    expect(() => z.toJSONSchema(z.object(SendMessageInput.shape))).not.toThrow()
    expect(() => z.toJSONSchema(EmptyToolInput)).not.toThrow()
    const send = defs[0]
    const out = await send?.handler({ to: 'Beto', body: 'por MCP' }, {})
    expect(out?.isError).toBe(false)
    const bad = await send?.handler({ to: 'Beto', body: '' }, {})
    expect(bad?.isError).toBe(true)
    const server = createBusMcpServer(toolsA)
    expect(server).toMatchObject({ type: 'sdk', name: 'bus' })
  })
})
