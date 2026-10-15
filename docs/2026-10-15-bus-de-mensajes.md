# 2026-10-15 — Bus de mensajes (feature 002)

Trabajo directo en `main` (el fundador pidió no usar rama/PR para esta feature).

## Qué se hizo
- Esquemas Zod de mensaje y eventos `bus.message` / `bus.limit`; tabla `messages` (migración 7).
- `bus/limits.ts` (20 msg/min y profundidad 10), `bus/bus.ts`, `bus/delivery.ts` (bloque marcado como datos), `bus/tools.ts` (MCP en proceso: `send_message`, `read_inbox`, `list_agents`).
- `AgentManager` entrega pendientes al iniciar y atiende la cola de `wake`; `SdkAgentRunner` registra el servidor del bus.
- Rutas `POST /messages` y `GET /agents/:id/messages`, con tests por HTTP/WS (`test/bus-http.test.ts`) incluido el flujo E2E usuario → coordinador → implementador.
- Trazabilidad C002-1..11 cubierta.

## Qué quedó pendiente
- Auditoría independiente: APROBADO CON OBSERVACIONES (0 P0/P1). Los 4 P2 se corrigieron con tests (ver abajo). Quedan 3 P3: nombres de agente con Unicode en `CreateAgentInput` y reservar el nombre "usuario"; el modelo del despertar no pasa por el piso de riesgo (decisión de diseño); sin retención/purga de `messages` ni `bus.limit` una vez por ventana. Revisar antes de la feature 005.
- Falta un tope de gasto/despertares por `threadId` (más allá de profundidad y límite por minuto).
- Un test de ACL del token (`local-token.test.ts`) se pasó de 5 s una vez bajo carga; pasó solo al repetirlo.

## Decisiones
- El remitente lo fija el motor; `POST /messages` usa esquema estricto, así que el cuerpo no puede elegirlo.
- Las rutas del bus usan las guardas globales (token, Origin, Host); el POST usa el límite de escrituras.

## Hallazgos de la auditoría corregidos
- P2-1: `read_inbox` sube el contexto de hilo de la ejecución (ya no reinicia la profundidad).
- P2-2: una difusión cuenta un envío por destinatario en el límite por minuto.
- P2-3: `neutralizeTags` normaliza NFKC, quita caracteres invisibles y acepta `-`/`_`/espacios; el bloque cierra con una marca de fin aleatoria por entrega.
- P2-4: entregas topadas a 50 mensajes y 64 000 caracteres; el resto queda pendiente con aviso.
