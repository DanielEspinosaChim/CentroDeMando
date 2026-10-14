# Plan — Bus de mensajes

## Enfoque técnico

El bus vive dentro del motor. A cada agente se le da un servidor MCP en proceso
(mecanismo de servidores MCP del Agent SDK, pasado en `mcpServers`; confirmar la
API exacta con Context7) con tres herramientas: `send_message`, `read_inbox` y
`list_agents`. La identidad del remitente la pone el motor (no el agente), así que
un agente no puede hacerse pasar por otro. Los mensajes se guardan en SQLite; la
entrega es "al iniciar la siguiente tarea" o, con `wake`, lanzando una tarea
nueva a través del `AgentManager`. Límite por minuto y profundidad por hilo evitan
bucles infinitos y gasto descontrolado.

## Archivos a crear/modificar

- `packages/shared/src/schemas/message.ts` — `SendMessageInput`, `Message`, `MessageStatus`
- `packages/shared/src/schemas/events.ts` — agregar `bus.message` y `bus.limit`
- `apps/engine/src/db/schema.ts` — tabla `messages` + migración
- `apps/engine/src/bus/bus.ts` — `MessageBus`: enviar, difundir, bandeja, marcar entregado/leído
- `apps/engine/src/bus/tools.ts` — servidor MCP en proceso con `send_message`, `read_inbox`, `list_agents`
- `apps/engine/src/bus/delivery.ts` — arma el bloque de mensajes que se antepone al prompt
- `apps/engine/src/bus/limits.ts` — límite por minuto (ventana deslizante) y profundidad por hilo
- `apps/engine/src/agents/manager.ts` — al iniciar: drenar bandeja; al terminar: atender cola de `wake`
- `apps/engine/src/agents/sdk-runner.ts` — registrar el servidor MCP del bus por agente
- `apps/engine/src/routes/messages.ts` — `POST /messages`, `GET /agents/:id/messages`

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| POST | `/messages` | El usuario envía `{ to, body, wake? }` (`to` = id de agente o `*`) |
| GET | `/agents/:id/messages` | Historial paginado `?cursor=&limit=` (máx. 100) |

Herramientas MCP expuestas a los agentes (no HTTP):

| Herramienta | Entrada | Descripción |
|---|---|---|
| `send_message` | `{ to, body, replyToId?, wake? }` | Envía a un agente (por nombre o id) o a `*` |
| `read_inbox` | `{}` | Devuelve y marca como leídos los mensajes pendientes |
| `list_agents` | `{}` | Lista nombre, rol y estado de los agentes del workspace |

## Modelo de datos

`messages`

| Campo | Tipo | Notas |
|---|---|---|
| id | text | ULID, PK |
| workspaceId | text | requerido, índice |
| threadId | text | requerido; = id del primer mensaje del hilo |
| fromKind | text | enum: `agent`, `user` |
| fromAgentId | text | nullable (null si `user`) |
| toAgentId | text | requerido, índice (`toAgentId`, `status`) |
| body | text | 1–8 000 caracteres |
| replyToId | text | nullable, FK → messages.id |
| wake | integer | 0/1 |
| depth | integer | despertares encadenados en el hilo, inicia en 0 |
| status | text | enum: `pending`, `delivered`, `read` |
| createdAt / deliveredAt | integer | epoch ms; `deliveredAt` nullable |

## Flujo técnico paso a paso

1. `send_message` (o `POST /messages`) valida con Zod; el motor fija `fromAgentId`
   según el agente dueño del servidor MCP.
2. `limits.ts` comprueba el límite por minuto; si se excede → error + `bus.limit`.
3. `bus.ts` resuelve `to` (nombre o id, solo dentro del `workspaceId`; `*` = todos
   menos el remitente), calcula `threadId` y `depth` (= depth del mensaje al que
   responde + 1 si es `wake`), guarda una fila por destinatario y emite `bus.message`.
4. Si `wake` y `depth <= 10`: si el destinatario está libre, `manager.start()` con
   un prompt "Tienes mensajes nuevos; atiéndelos" ; si está ocupado, queda pendiente
   y el manager lo atiende al terminar. Si `depth > 10`: no despierta y emite `bus.limit`.
5. Al iniciar cualquier tarea, `delivery.ts` toma los `pending` del agente y antepone
   el bloque marcado como datos; los marca `delivered`.

## Consideraciones de seguridad específicas de esta feature

- El remitente lo asigna el motor, nunca el contenido del mensaje (anti-suplantación).
- El bloque entregado deja explícito que son datos de otros agentes, no órdenes del
  usuario (punto A del checklist); un mensaje no puede aprobar acciones ni cambiar
  permisos.
- Límite por minuto y profundidad máxima por hilo (puntos 7 y D) contra bucles y gasto.
- Todas las consultas filtran por `workspaceId` (punto 3).
