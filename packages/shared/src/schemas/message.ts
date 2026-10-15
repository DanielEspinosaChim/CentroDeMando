import { z } from 'zod'
import { Id } from './agent.ts'

/** Tamaño máximo del cuerpo de un mensaje entre agentes (feature 002, criterio 8). */
export const MAX_MESSAGE_BODY_LENGTH = 8000
/** Destinatario especial: todos los demás agentes del mismo workspace. */
export const BROADCAST_TARGET = '*'
/** Remitente que se muestra para los mensajes escritos por el usuario desde la app. */
export const USER_SENDER = 'usuario'

export const MessageBody = z.string().trim().min(1).max(MAX_MESSAGE_BODY_LENGTH)

export const MessageStatus = z.enum(['pending', 'delivered', 'read'])
export type MessageStatus = z.infer<typeof MessageStatus>

export const MessageFromKind = z.enum(['agent', 'user'])
export type MessageFromKind = z.infer<typeof MessageFromKind>

/**
 * Entrada de la herramienta `send_message` de un agente. `to` es el nombre o el id de un
 * agente del mismo workspace, o `*`. No hay campo de remitente: lo fija el motor.
 */
export const SendMessageInput = z.strictObject({
  to: z.string().trim().min(1).max(40),
  body: MessageBody,
  replyToId: Id.optional(),
  wake: z.boolean().optional(),
})
export type SendMessageInput = z.infer<typeof SendMessageInput>

/** `POST /messages`: el usuario escribe a un agente (por id) o a todos (`*`). */
export const PostMessageInput = z.strictObject({
  to: z.union([Id, z.literal(BROADCAST_TARGET)]),
  body: MessageBody,
  wake: z.boolean().optional(),
})
export type PostMessageInput = z.infer<typeof PostMessageInput>

/** Herramientas sin argumentos (`read_inbox`, `list_agents`). */
export const EmptyToolInput = z.strictObject({})

/** `GET /agents/:id/messages?cursor=&limit=` */
export const MessageHistoryQuery = z.strictObject({
  cursor: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type MessageHistoryQuery = z.infer<typeof MessageHistoryQuery>

export const Message = z.object({
  id: Id,
  threadId: Id,
  fromKind: MessageFromKind,
  /** `null` si lo escribió el usuario (o si el agente remitente ya se borró). */
  fromAgentId: Id.nullable(),
  toAgentId: Id,
  body: z.string(),
  replyToId: Id.nullable(),
  wake: z.boolean(),
  /** Despertares automáticos encadenados en el hilo hasta este mensaje. */
  depth: z.number().int().nonnegative(),
  status: MessageStatus,
  createdAt: z.number().int(),
  deliveredAt: z.number().int().nullable(),
})
export type Message = z.infer<typeof Message>
