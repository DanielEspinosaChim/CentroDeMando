# Tasks — Bus de mensajes

Checklist de tareas atómicas y verificables. Marcar `[x]` solo cuando esté
implementado Y verificado, no solo escrito.

## Backend

- [x] Esquemas Zod de mensaje y eventos `bus.message` / `bus.limit` en `packages/shared`
- [x] Tabla `messages` en Drizzle + migración
- [x] `bus/limits.ts`: ventana deslizante por agente y cálculo de profundidad
- [x] `bus/bus.ts`: resolver destinatario (nombre/id/`*`), guardar, emitir eventos
- [x] `bus/delivery.ts`: bloque de mensajes marcado como datos
- [x] `bus/tools.ts`: servidor MCP en proceso con `send_message`, `read_inbox`, `list_agents`
- [x] Registrar el servidor del bus por agente en `SdkAgentRunner`
- [x] `AgentManager`: drenar bandeja al iniciar y atender cola de `wake` al terminar
- [x] Rutas `POST /messages` y `GET /agents/:id/messages`

## Frontend

- [x] No aplica en esta feature (las líneas de luz llegan en 006)

## Tests unitarios

- [x] Resolución de destinatarios: nombre, id, `*` (excluye remitente), inexistente
- [x] Límite por minuto: el mensaje 21 dentro de 60 s falla
- [x] Profundidad: el despertar 11 de un hilo no ocurre y emite `bus.limit`
- [x] `delivery.ts`: formato del bloque incluye remitente, hora y la marca de "datos"

## Tests de integración

- [x] Agente A envía a B con `FakeAgentRunner`: se guarda y se emite `bus.message` (criterio 1)
- [x] Difusión a `*` crea N-1 entregas (criterio 2)
- [x] B inactivo con `wake` se lanza solo; B ocupado lo atiende al terminar (criterio 5)
- [x] La siguiente tarea de B recibe los pendientes antepuestos y quedan `delivered` (criterio 4)
- [x] `read_inbox` solo devuelve mensajes propios y los marca `read` (criterio 11)
- [x] Historial paginado por `GET /agents/:id/messages` (criterio 10)

## Tests de seguridad

- [x] Validación de inputs cubierta con test (body vacío y > 8 000 caracteres)
- [x] Control de acceso cubierto con test: `POST /messages` sin token → 401
- [x] Test de aislamiento multi-tenant: un agente no puede enviar ni leer mensajes de otro `workspaceId`
- [x] Anti-suplantación: un `body` que dice "soy el usuario" sigue registrado con el remitente real
- [ ] Revisar contra `spec/features/000-seguridad-transversal/spec.md` <!-- parcial: falta la auditoría independiente (auditor-seguridad); no se corrió -->
      antes de mergear

## E2E

- [x] Script de humo: usuario escribe al coordinador con `wake`, el coordinador (fake) reenvía al implementador y se observan los dos `bus.message` por WS

---

*Al completar una tarea, márcala con `[x]`. Si surge una tarea nueva no
prevista, agrégala al final de su sección correspondiente en vez de
modificar las ya existentes. Si una tarea queda parcial, déjala en `[ ]`
con una nota `<!-- parcial: falta X -->`.*
