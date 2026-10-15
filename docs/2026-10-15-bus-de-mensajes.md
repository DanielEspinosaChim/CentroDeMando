# 2026-10-15 — Bus de mensajes (feature 002)

Trabajo directo en `main` (el fundador pidió no usar rama/PR para esta feature).

## Qué se hizo
- Esquemas Zod de mensaje y eventos `bus.message` / `bus.limit`; tabla `messages` (migración 7).
- `bus/limits.ts` (20 msg/min y profundidad 10), `bus/bus.ts`, `bus/delivery.ts` (bloque marcado como datos), `bus/tools.ts` (MCP en proceso: `send_message`, `read_inbox`, `list_agents`).
- `AgentManager` entrega pendientes al iniciar y atiende la cola de `wake`; `SdkAgentRunner` registra el servidor del bus.
- Rutas `POST /messages` y `GET /agents/:id/messages`, con tests por HTTP/WS (`test/bus-http.test.ts`) incluido el flujo E2E usuario → coordinador → implementador.
- Trazabilidad C002-1..11 cubierta.

## Qué quedó pendiente
- **Auditoría independiente de seguridad (`auditor-seguridad`) NO se corrió.** La feature es de nivel crítico: debe pasar antes de darla por cerrada del todo.
- Un test de ACL del token (`local-token.test.ts`) se pasó de 5 s una vez bajo carga; pasó solo al repetirlo.

## Decisiones
- El remitente lo fija el motor; `POST /messages` usa esquema estricto, así que el cuerpo no puede elegirlo.
- Las rutas del bus usan las guardas globales (token, Origin, Host); el POST usa el límite de escrituras.
