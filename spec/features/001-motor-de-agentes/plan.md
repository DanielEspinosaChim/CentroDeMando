# Plan — Motor de agentes

## Enfoque técnico

Un servicio Fastify que solo escucha en `127.0.0.1`. El acceso al SDK queda
aislado tras una interfaz `AgentRunner` (implementación real `SdkAgentRunner`
sobre `query()` de `@anthropic-ai/claude-agent-sdk`, y `FakeAgentRunner` para
tests). Un `AgentManager` mantiene la máquina de estados de cada agente, persiste
en SQLite con Drizzle y publica eventos en un `EventHub` que reenvía a los
clientes WebSocket. Así el resto del sistema (bus, enrutador, UI) solo conoce
eventos tipados, no el SDK.

## Archivos a crear/modificar

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.workspace.ts` — monorepo inicial
- `packages/shared/src/schemas/agent.ts` — esquemas Zod: `AgentRole`, `AgentStatus`, `CreateAgentInput`, `Agent`
- `packages/shared/src/schemas/project.ts` — `CreateProjectInput`, `Project`
- `packages/shared/src/schemas/events.ts` — unión discriminada `EngineEvent` (`agent.status`, `agent.output`, `agent.tool`, `agent.usage`, `agent.error`)
- `packages/shared/src/index.ts` — exportaciones
- `apps/engine/src/config.ts` — puerto, origen permitido, `MAX_CONCURRENT_AGENTS`, ruta de datos (`%APPDATA%/centro-de-mando`)
- `apps/engine/src/security/local-token.ts` — genera/lee el token local (archivo con permisos solo del usuario)
- `apps/engine/src/security/guards.ts` — hooks de Fastify: token y `Origin`
- `apps/engine/src/db/schema.ts` — tablas Drizzle `projects`, `agents`, `runs`
- `apps/engine/src/db/client.ts` — conexión better-sqlite3 (WAL) + migraciones
- `apps/engine/src/agents/runner.ts` — interfaz `AgentRunner` y tipos de evento del runner
- `apps/engine/src/agents/sdk-runner.ts` — `SdkAgentRunner` (traduce mensajes del SDK a eventos)
- `apps/engine/src/agents/fake-runner.ts` — `FakeAgentRunner` programable para tests
- `apps/engine/src/agents/manager.ts` — `AgentManager`: estados, concurrencia, pausa/reanudar/detener
- `apps/engine/src/events/hub.ts` — `EventHub` (pub/sub en memoria)
- `apps/engine/src/projects/paths.ts` — validación de rutas de proyecto y `cwd`
- `apps/engine/src/routes/projects.ts`, `apps/engine/src/routes/agents.ts`, `apps/engine/src/routes/ws.ts` — rutas
- `apps/engine/src/errors/index.ts` — `AppError`, `ValidationError`, `NotFoundError`, `ConflictError`, `LimitError` y manejador global
- `apps/engine/src/server.ts` — arma la app (inyectando el runner) y `apps/engine/src/main.ts` — arranque

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| GET | `/health` | `{ ok: true }`, sin token, sin datos internos |
| POST | `/projects` | Registra un proyecto `{ name, path }` (la ruta debe existir) |
| GET | `/projects` | Lista proyectos |
| POST | `/agents` | Crea agente `{ name, role, projectId, defaultModel? }` |
| GET | `/agents` | Lista agentes con su estado |
| GET | `/agents/:id` | Detalle del agente y su última ejecución |
| DELETE | `/agents/:id` | Elimina un agente que no esté ejecutando (`409` si lo está) |
| POST | `/agents/:id/tasks` | Lanza tarea `{ prompt, model? }` → `202 { runId }` |
| POST | `/agents/:id/pause` | Interrumpe y guarda la sesión |
| POST | `/agents/:id/resume` | Reanuda la sesión `{ prompt? }` |
| POST | `/agents/:id/stop` | Detiene definitivamente la ejecución actual |
| GET | `/ws` | WebSocket de eventos; token en el subprotocolo `cdm.<token>` |

## Modelo de datos

`projects`

| Campo | Tipo | Notas |
|---|---|---|
| id | text | ULID, PK |
| workspaceId | text | requerido, por defecto `local`, índice |
| name | text | requerido, 1–80 caracteres |
| path | text | requerido, ruta absoluta normalizada, única por workspace |
| createdAt | integer | epoch ms |

`agents`

| Campo | Tipo | Notas |
|---|---|---|
| id | text | ULID, PK |
| workspaceId | text | requerido, índice |
| projectId | text | FK → projects.id |
| name | text | requerido, 1–40 caracteres |
| role | text | enum: `coordinador`, `planeador`, `implementador`, `qa`, `seguridad`, `disenador`, `documentador` |
| defaultModel | text | enum: `haiku`, `sonnet`, `opus`; por defecto según rol |
| status | text | enum: `idle`, `thinking`, `running_tool`, `paused`, `stopped`, `done`, `error`, `interrupted` |
| sdkSessionId | text | nullable |
| createdAt / updatedAt | integer | epoch ms |

`runs`

| Campo | Tipo | Notas |
|---|---|---|
| id | text | ULID, PK |
| agentId | text | FK → agents.id, índice |
| prompt | text | requerido, máx. 20 000 caracteres |
| model | text | modelo usado |
| status | text | mismo enum que agentes (estado final) |
| inputTokens / outputTokens | integer | del mensaje `result` |
| costUsd | real | `total_cost_usd` del SDK (estimación, no facturación) |
| contextUsedPct | real | 0–100 |
| startedAt / endedAt | integer | epoch ms; `endedAt` nullable |

## Flujo técnico paso a paso

1. `main.ts` carga config, abre SQLite, marca ejecuciones `thinking`/`running_tool`
   como `interrupted`, genera/lee el token y arranca Fastify en `127.0.0.1`.
2. `guards.ts` valida token (cabecera `Authorization: Bearer` o subprotocolo WS) y `Origin`.
3. `POST /agents/:id/tasks` valida con Zod, comprueba límites (409/429), crea el `run`
   y llama a `manager.start(agent, run)`; responde `202`.
4. `AgentManager` llama a `runner.run({ prompt, model, cwd: project.path, resume?,
   abortSignal })` y consume el iterador de eventos del runner.
5. `SdkAgentRunner` llama a `query()` con `model`, `cwd`, `systemPrompt` preset
   `claude_code` + texto del rol, `canUseTool` que deniega lo no permitido,
   `maxTurns`, y traduce: mensaje de asistente → `output`, uso de herramienta →
   `tool`, `result` → `usage` (`total_cost_usd`, `usage`) y guarda `session_id`.
   El % de contexto se obtiene con el método de uso de contexto del SDK
   (confirmar firma con Context7 al implementar).
6. Cada evento se persiste cuando cambia el estado y se publica en `EventHub`;
   `routes/ws.ts` lo reenvía a los clientes autenticados.
7. `pause` → `query.interrupt()` + estado `paused`; `resume` → nueva ejecución con
   `resume: sdkSessionId`; `stop` → `interrupt()` + `close()`, estado `stopped`, y
   el manager descarta eventos tardíos de ese run.

## Consideraciones de seguridad específicas de esta feature

- El motor solo escucha en `127.0.0.1`; el token local se regenera si el archivo
  no existe y nunca se registra en logs.
- `projects/paths.ts` normaliza y resuelve enlaces: el `cwd` debe estar dentro de
  una ruta de proyecto registrada (punto C del checklist).
- `env` del SDK se construye a partir de `process.env` sin agregar secretos del motor.
- Nunca se usa `bypassPermissions`; `canUseTool` deniega por defecto.
- `maxTurns` por ejecución (por defecto 40) como tope de gasto (punto D).
- `maxBudgetUsd` por tarea (`CDM_MAX_COST_USD_PER_TASK`, por defecto 2 USD); al alcanzar
  un tope el agente queda en `error` con un aviso específico (añadido tras la auditoría).
- Herramientas: `tools` limitado a la lista permitida + hook `PreToolUse` + `canUseTool`;
  sin MCP (`strictMcpConfig`, `disallowedTools: ['mcp__*']`, conectores de claude.ai apagados).
