import {
  type Agent,
  BROADCAST_TARGET,
  type EngineEvent,
  type Message,
  PostMessageInput,
  SendMessageInput,
  USER_SENDER,
} from '@cdm/shared'
import { monotonicFactory } from 'ulid'
import type { NewMessage, Store } from '../db/store.ts'
import { LimitError, NotFoundError, parseInput, ValidationError } from '../errors/index.ts'
import type { EventHub } from '../events/hub.ts'
import type { SenderInfo } from './delivery.ts'
import {
  BusLimits,
  MAX_DELIVERY_CHARS,
  MAX_DELIVERY_MESSAGES,
  nextDepth,
  type ThreadContext,
} from './limits.ts'

/**
 * Remitente de un envío. Lo fija el motor (el servidor MCP del agente o la ruta HTTP),
 * nunca el contenido del mensaje: un agente no puede hacerse pasar por otro ni por el
 * usuario (anti-suplantación).
 */
export type Sender =
  | { kind: 'user' }
  | {
      kind: 'agent'
      agentId: string
      /** Ejecución desde la que envía (para el evento). */
      runId: string | null
      /** Hilo y profundidad que hereda la ejecución (si la lanzó un mensaje). */
      context?: ThreadContext | null
    }

export type WakeHandler = (workspaceId: string, agentIds: readonly string[]) => void

export interface MessageBusDeps {
  store: Store
  hub: EventHub
  limits?: BusLimits
}

export interface Delivery {
  messages: Message[]
  senders: Map<string, SenderInfo>
  /** Contexto de hilo que hereda la ejecución que recibe estos mensajes. */
  context: ThreadContext | null
  /** Mensajes que quedaron sin entregar por el tope de la entrega (siguen pendientes). */
  remaining: number
}

export interface AgentSummary {
  id: string
  name: string
  role: Agent['role']
  status: Agent['status']
  /** Es el agente que pregunta. */
  self: boolean
}

const DELIVERY_CAP = { messages: MAX_DELIVERY_MESSAGES, chars: MAX_DELIVERY_CHARS }

function deepestContext(messages: readonly Message[]): ThreadContext {
  let deepest = messages[0] as Message
  for (const m of messages) if (m.depth >= deepest.depth) deepest = m
  return { threadId: deepest.threadId, depth: deepest.depth }
}

/** Ids monótonos: dentro del mismo milisegundo el orden por id es el orden de envío. */
const messageId = monotonicFactory()

export const RATE_LIMIT_MESSAGE =
  'Límite de mensajes por minuto alcanzado; espera antes de enviar más'
export const MAX_DEPTH_MESSAGE =
  'El hilo alcanzó el máximo de despertares encadenados: el mensaje se guardó pero no despierta a nadie'

/**
 * Bus de mensajes entre agentes (feature 002). Toda consulta filtra por `workspaceId`
 * (checklist de seguridad, punto 3) y toda entrada se valida con Zod (punto 1).
 */
export class MessageBus {
  readonly limits: BusLimits
  private wakeHandler: WakeHandler | undefined

  constructor(private readonly deps: MessageBusDeps) {
    this.limits = deps.limits ?? new BusLimits()
  }

  /** El `AgentManager` se registra aquí para lanzar las tareas de los despertares. */
  onWake(handler: WakeHandler): void {
    this.wakeHandler = handler
  }

  /**
   * Valida, aplica el límite por minuto (solo agentes), resuelve destinatarios, guarda una
   * fila por destinatario, emite `bus.message` y, si corresponde, pide los despertares.
   * Si algo falla no se guarda nada.
   */
  send(workspaceId: string, sender: Sender, raw: unknown): Message[] {
    const input =
      sender.kind === 'user'
        ? { ...parseInput(PostMessageInput, raw), replyToId: undefined }
        : parseInput(SendMessageInput, raw)

    if (sender.kind === 'agent' && !this.limits.tryConsume(workspaceId, sender.agentId)) {
      this.emitLimit(workspaceId, sender, 'rate_limit', null, RATE_LIMIT_MESSAGE)
      throw new LimitError(RATE_LIMIT_MESSAGE)
    }

    const recipients = this.resolveRecipients(workspaceId, sender, input.to)
    // Una difusión cuesta una unidad de cupo por destinatario (la primera ya se consumió).
    if (
      sender.kind === 'agent' &&
      recipients.length > 1 &&
      !this.limits.tryConsume(workspaceId, sender.agentId, recipients.length - 1)
    ) {
      this.emitLimit(workspaceId, sender, 'rate_limit', null, RATE_LIMIT_MESSAGE)
      throw new LimitError(RATE_LIMIT_MESSAGE)
    }
    const parent = input.replyToId
      ? this.requireParent(workspaceId, sender, input.replyToId)
      : undefined
    const context = sender.kind === 'agent' ? (sender.context ?? undefined) : undefined
    const wakeRequested = input.wake === true
    const depth = nextDepth([parent, context], wakeRequested)
    const ids = recipients.map(() => messageId())
    const threadId = parent?.threadId ?? context?.threadId ?? (ids[0] as string)

    const rows: NewMessage[] = recipients.map((to, i) => ({
      id: ids[i] as string,
      threadId,
      fromKind: sender.kind,
      fromAgentId: sender.kind === 'agent' ? sender.agentId : null,
      toAgentId: to.id,
      body: input.body,
      replyToId: parent?.id ?? null,
      wake: wakeRequested,
      depth,
    }))
    const saved = this.deps.store.insertMessages(workspaceId, rows)

    const base = this.eventBase(sender)
    for (const m of saved) {
      this.emit(workspaceId, {
        type: 'bus.message',
        ...base,
        id: m.id,
        from: m.fromAgentId ?? USER_SENDER,
        to: m.toAgentId,
        threadId: m.threadId,
        replyToId: m.replyToId,
        wake: m.wake,
        depth: m.depth,
      })
    }

    if (wakeRequested) {
      if (this.limits.canWake(depth)) {
        this.wakeHandler?.(
          workspaceId,
          saved.map((m) => m.toAgentId),
        )
      } else {
        this.emitLimit(workspaceId, sender, 'max_depth', threadId, MAX_DEPTH_MESSAGE)
      }
    }
    return saved
  }

  /** Toma los pendientes del agente para anteponerlos al prompt; pasan a `delivered`. */
  deliverPending(workspaceId: string, agentId: string): Delivery {
    const messages = this.deps.store.takePendingMessages(workspaceId, agentId, DELIVERY_CAP)
    if (messages.length === 0) return { messages, senders: new Map(), context: null, remaining: 0 }
    return {
      messages,
      senders: this.senderInfo(workspaceId),
      context: deepestContext(messages),
      remaining: this.deps.store.countUnread(workspaceId, agentId, ['pending']),
    }
  }

  /** `read_inbox`: solo mensajes dirigidos al agente que llama; pasan a `read`. */
  readInbox(workspaceId: string, agentId: string): Delivery {
    const messages = this.deps.store.readInbox(workspaceId, agentId, DELIVERY_CAP)
    // El contexto es el hilo más profundo de lo leído: quien llama lo hereda, así leer la
    // bandeja no sirve para reiniciar el límite de despertares encadenados.
    return {
      messages,
      senders: this.senderInfo(workspaceId),
      context: messages.length ? deepestContext(messages) : null,
      remaining: this.deps.store.countUnread(workspaceId, agentId),
    }
  }

  /** `list_agents`: nombre, rol y estado de los agentes del workspace. */
  listAgents(workspaceId: string, selfId: string | null): AgentSummary[] {
    return this.deps.store.listAgents(workspaceId).map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
      self: a.id === selfId,
    }))
  }

  history(workspaceId: string, agentId: string, limit: number, cursor?: string) {
    if (!this.deps.store.getAgent(workspaceId, agentId)) {
      throw new NotFoundError('Agente no encontrado')
    }
    const page = this.deps.store.messageHistory(workspaceId, agentId, limit, cursor)
    if (!page) throw new ValidationError('cursor: mensaje no encontrado')
    return page
  }

  /** Agentes con despertares pendientes (cola de `wake` que aún no se atendió). */
  agentsWithPendingWake(workspaceId: string): string[] {
    return this.deps.store.agentsWithPendingWake(workspaceId, this.limits.maxWakeDepth)
  }

  // --- Interno ----------------------------------------------------------------

  private resolveRecipients(workspaceId: string, sender: Sender, to: string): Agent[] {
    const selfId = sender.kind === 'agent' ? sender.agentId : null
    if (to === BROADCAST_TARGET) {
      const others = this.deps.store.listAgents(workspaceId).filter((a) => a.id !== selfId)
      if (others.length === 0) throw new ValidationError('to: no hay otros agentes en el workspace')
      return others
    }
    // Solo se busca dentro del workspace: un agente de otro workspace "no existe".
    let target = this.deps.store.getAgent(workspaceId, to)
    if (!target && sender.kind === 'agent') {
      const wanted = to.trim().toLowerCase()
      const byName = this.deps.store
        .listAgents(workspaceId)
        .filter((a) => a.name.trim().toLowerCase() === wanted)
      if (byName.length > 1) {
        throw new ValidationError('to: hay varios agentes con ese nombre; usa su id')
      }
      target = byName[0]
    }
    if (!target) throw new NotFoundError('Destinatario no encontrado')
    if (target.id === selfId)
      throw new ValidationError('to: un agente no puede escribirse a sí mismo')
    return [target]
  }

  /** El mensaje al que se responde debe existir en el workspace y ser del remitente. */
  private requireParent(workspaceId: string, sender: Sender, replyToId: string): Message {
    const parent = this.deps.store.getMessage(workspaceId, replyToId)
    const participates =
      parent &&
      sender.kind === 'agent' &&
      (parent.toAgentId === sender.agentId || parent.fromAgentId === sender.agentId)
    if (!parent || !participates) throw new NotFoundError('replyToId: mensaje no encontrado')
    return parent
  }

  private senderInfo(workspaceId: string): Map<string, SenderInfo> {
    return new Map(
      this.deps.store.listAgents(workspaceId).map((a) => [a.id, { name: a.name, role: a.role }]),
    )
  }

  private eventBase(sender: Sender) {
    return {
      agentId: sender.kind === 'agent' ? sender.agentId : null,
      runId: sender.kind === 'agent' ? sender.runId : null,
      at: Date.now(),
    }
  }

  private emitLimit(
    workspaceId: string,
    sender: Sender,
    reason: 'rate_limit' | 'max_depth',
    threadId: string | null,
    message: string,
  ): void {
    this.emit(workspaceId, {
      type: 'bus.limit',
      ...this.eventBase(sender),
      reason,
      threadId,
      message,
    })
  }

  private emit(workspaceId: string, event: EngineEvent): void {
    this.deps.hub.publish(workspaceId, event)
  }
}
