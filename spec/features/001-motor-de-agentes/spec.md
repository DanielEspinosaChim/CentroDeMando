# Spec — Motor de agentes

Estado: LISTO PARA IMPLEMENTAR

## Qué hace

Servicio local (`apps/engine`) que crea, lanza, pausa, reanuda y detiene agentes
de Claude Code usando el Claude Agent SDK, cada uno trabajando dentro de un
proyecto registrado. Expone una API REST y un WebSocket en `127.0.0.1` protegidos
por un token local, y emite en tiempo real el estado, la salida, el uso de
herramientas y el consumo (tokens, costo, % de contexto) de cada agente. Es la
base de todas las demás features.

## Módulos que toca

- [x] Backend (`apps/engine`, `packages/shared`)
- [ ] Frontend

## Depende de

- Ninguna (es la primera). Requiere el monorepo inicial (pnpm, TypeScript, Vitest, Biome).

## Fuera de alcance

- Mensajería entre agentes (002) y elección automática de modelo (003): aquí el
  modelo se recibe explícito o se usa el por defecto del rol.
- Aprobaciones de acciones riesgosas (005): en esta feature `canUseTool` deniega
  por defecto todo lo que no esté en la lista de herramientas permitidas.
- Interfaz visual (006), perfiles de cuenta (010), sesiones externas (009).

## Criterios de aceptación

1. Cualquier petición HTTP (salvo `GET /health`) o conexión WebSocket sin el token
   local válido se rechaza: HTTP `401`, WebSocket se cierra con código `4401`.
2. Una petición con cabecera `Origin` distinta de la interfaz configurada se
   rechaza con `403`.
3. `POST /agents` con datos válidos crea un agente con estado `idle` y lo devuelve;
   con datos inválidos responde `400` con `{ error: { code: "VALIDATION_ERROR" } }`
   sin stack trace.
4. Registrar un proyecto con una ruta que no existe, o crear un agente con un
   `projectId` inexistente, responde `400`.
5. `POST /agents/:id/tasks` lanza una ejecución: por WebSocket se emiten, en orden,
   `agent.status` = `thinking`, cero o más `agent.output` / `agent.tool`, y al final
   `agent.usage` (tokens, `costUsd`, `contextUsedPct`) y `agent.status` = `done`.
6. `POST /agents/:id/pause` interrumpe la ejecución, deja el estado en `paused` y
   guarda el `sdkSessionId`; `POST /agents/:id/resume` continúa la misma sesión
   (el runner recibe `resume = sdkSessionId`).
7. `POST /agents/:id/stop` deja el estado en `stopped` y no se emite ningún evento
   posterior de esa ejecución.
8. Lanzar una tarea cuando ya hay `MAX_CONCURRENT_AGENTS` (por defecto 5)
   ejecutando responde `429`; lanzar en un agente que ya está ejecutando responde `409`.
9. Si una ejecución falla, el estado pasa a `error`, se emite `agent.error` con un
   mensaje genérico y el detalle solo queda en el log local (sin tokens).
10. Al reiniciar el motor, los agentes y ejecuciones persisten en SQLite; las que
    estaban en curso quedan marcadas como `interrupted`.
11. Toda la suite de tests corre con `FakeAgentRunner` y no realiza llamadas reales.
