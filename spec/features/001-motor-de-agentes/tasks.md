# Tasks — Motor de agentes

Checklist de tareas atómicas y verificables. Marcar `[x]` solo cuando esté
implementado Y verificado, no solo escrito.

## Backend

- [x] Crear monorepo: `pnpm-workspace.yaml`, `tsconfig.base.json` (strict), Biome, Vitest workspace
- [x] `packages/shared`: esquemas Zod de agente, proyecto y eventos (`EngineEvent`)
- [x] `config.ts` con valores por defecto y ruta de datos en `%APPDATA%`
- [x] `db/schema.ts` + `db/client.ts` con WAL y migración inicial (`projects`, `agents`, `runs`)
- [x] `security/local-token.ts`: generar, guardar y leer el token local
- [x] `security/guards.ts`: validar token (HTTP y subprotocolo WS) y `Origin`
- [x] `errors/index.ts` + manejador global con respuesta `{ error: { code, message } }`
- [x] `projects/paths.ts`: normalizar ruta, verificar existencia y contención del `cwd`
- [x] `agents/runner.ts`: interfaz `AgentRunner` y tipos de evento
- [x] `agents/fake-runner.ts`: runner programable (secuencia de eventos, error, espera)
- [x] `agents/sdk-runner.ts`: integración con `query()` y traducción de mensajes
- [x] `events/hub.ts`: pub/sub en memoria con desuscripción
- [x] `agents/manager.ts`: máquina de estados, límites 409/429, pausa/reanudar/detener
- [x] Rutas `projects`, `agents` y `ws`; `server.ts` con inyección del runner
- [x] `main.ts`: arranque y marcado de ejecuciones `interrupted`

- [x] `db/store.ts`: acceso a datos con filtro por `workspaceId` (no previsto en el plan)
- [x] Guard WebSocket: cerrar el socket del upgrade al rechazar `Origin` (si no, quedaba colgado)
- [x] Política de herramientas en tres capas: `tools`, hook `PreToolUse` y `canUseTool` (Claude Code auto-aprobaba Bash de solo lectura sin consultar `canUseTool`)
- [x] Bloquear todo MCP en agentes del motor (los conectores de claude.ai del usuario llegaban al agente)
- [x] Tope de costo por tarea (`CDM_MAX_COST_USD_PER_TASK`, `maxBudgetUsd`) y aviso específico al alcanzar tope de turnos/costo (auditoría, P1)
- [x] Glob/Grep: rechazar patrones absolutos, con unidad, `~` o `..` (auditoría, P2)
- [x] Proyectos: rechazar raíz de unidad, carpeta de usuario y carpetas que contengan `dataDir` (auditoría, P2)
- [x] Pausa/stop esperan a que el proceso termine antes de liberar el hueco de concurrencia (auditoría, P2)
- [x] Validar cabecera `Host` contra DNS rebinding (auditoría, P2)
- [x] Columna `workspace_id` en `runs` (migración 2) (auditoría, P2)
- [x] `scripts/live-check.ts`: prueba manual con el SDK real (gasta tokens)
- [x] Repo git y CI (`.github/workflows/ci.yml`, `windows-latest`)

## Frontend

- [x] No aplica en esta feature (la interfaz llega en 006)

## Tests unitarios

- [x] Máquina de estados: transiciones válidas e inválidas del `AgentManager`
- [x] `paths.ts`: rechaza rutas inexistentes, `..` y enlaces fuera del proyecto
- [x] `SdkAgentRunner`: traducción de mensajes del SDK a eventos (con mensajes de ejemplo grabados) — `sdk-recording.fixture.json`, grabado con `live-check` el 2026-10-14
- [x] Esquemas Zod: límites de longitud y enums

## Tests de integración

- [x] Flujo completo con `FakeAgentRunner`: crear proyecto → agente → tarea → eventos en orden por WS (criterio 5)
- [x] Pausa y reanudación pasan `resume = sdkSessionId` (criterio 6)
- [x] `stop` no emite eventos posteriores (criterio 7)
- [x] Límites: 409 en agente ocupado y 429 al exceder concurrencia (criterio 8)
- [x] Error del runner → estado `error` y evento genérico (criterio 9)
- [x] Reinicio: ejecuciones en curso quedan `interrupted` (criterio 10)

## Tests de seguridad

- [x] Validación de inputs cubierta con test (400 con `VALIDATION_ERROR`, sin stack trace)
- [x] Control de acceso cubierto con test: sin token → 401; WS sin token → cierre 4401
- [x] `Origin` ajeno → 403
- [x] Test de aislamiento multi-tenant: un agente de `workspaceId` A no es visible ni operable desde B
- [x] El token local no aparece en ningún log (captura del logger en test)
- [x] Revisar contra `spec/features/000-seguridad-transversal/spec.md`
      antes de mergear — APROBADO CON OBSERVACIONES (2026-10-14); P1 de tope de costo corregido

## E2E

- [x] Script de humo (`pnpm --filter engine smoke`) que arranca el motor con `FakeAgentRunner`, ejecuta una tarea por HTTP y verifica los eventos por WS

---

*Al completar una tarea, márcala con `[x]`. Si surge una tarea nueva no
prevista, agrégala al final de su sección correspondiente en vez de
modificar las ya existentes. Si una tarea queda parcial, déjala en `[ ]`
con una nota `<!-- parcial: falta X -->`.*
