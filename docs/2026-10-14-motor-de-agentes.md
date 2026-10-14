# 2026-10-14 — Feature 001: motor de agentes

## Qué se hizo

- Monorepo pnpm creado: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
  (strict), `biome.json`, `vitest.config.ts` (proyectos `shared` y `engine`).
- `packages/shared`: esquemas Zod de agente, proyecto, ejecución y `EngineEvent`.
- `apps/engine` completo según `spec/features/001-motor-de-agentes/plan.md`:
  config, token local, guards (token + `Origin`), errores, SQLite (WAL) + Drizzle,
  `AgentRunner` / `FakeAgentRunner` / `SdkAgentRunner`, `EventHub`, `AgentManager`,
  rutas REST + WebSocket, `server.ts`, `main.ts` y `scripts/smoke.ts`.
- 71 tests en verde (`pnpm test`), `pnpm -r typecheck` limpio,
  `pnpm --filter engine smoke` OK. Ningún test usa el SDK real.
- Arranque real comprobado: escucha solo en `127.0.0.1:4317`, `/health` sin token,
  401 sin token, el token no aparece en el log.

### Segunda parte (mismo día)

- **Prueba real con el SDK** (`pnpm --filter engine live-check`, haiku, ~US$0.02 por corrida):
  tarea completa con `Read`, uso/costo/% de contexto y `sdkSessionId` correctos.
- **Hallazgo 1 (grave, corregido):** Claude Code auto-aprueba comandos Bash de solo lectura
  sin llamar a `canUseTool`; el agente ejecutó `echo hola`. Ahora hay tres capas:
  `tools` (solo las permitidas), hook `PreToolUse` (corre siempre) y `canUseTool`.
- **Hallazgo 2 (grave, corregido):** los conectores de claude.ai del usuario (Gmail,
  Drive, Calendar…) llegaban al agente. Ahora: `mcpServers: {}`, `strictMcpConfig`,
  `disallowedTools: ['mcp__*']` y `ENABLE_CLAUDEAI_MCP_SERVERS=false`. El live-check
  verifica que el agente solo vea `Glob, Grep, Read, TodoWrite`.
- Fixture grabado de una ejecución real (`sdk-recording.fixture.json`, sin rutas ni datos personales).
- **Auditoría** (`auditor-seguridad`): APROBADO CON OBSERVACIONES. Corregidos el P1
  (tope de costo) y los P2 de patrones Glob/Grep, carpetas peligrosas, pausa/concurrencia,
  `Host` y `workspace_id` en `runs`.
- Repo git inicializado (rama `main`) y CI en `.github/workflows/ci.yml`.
- 85 tests en verde.

### Tercera parte (mismo día, con subagentes)

- Flujo: coordinador (plan) → planeador (tasks.md) → 2 implementadores en paralelo → 2 QA en paralelo → auditor.
- Rate limit propio en memoria (`security/rate-limit.ts`, ventana deslizante de 60 s):
  escrituras 60/min por workspace (`CDM_RATE_LIMIT_WRITES_PER_MIN`), acciones por agente
  10/min (`CDM_RATE_LIMIT_AGENT_ACTIONS_PER_MIN`); 429 `RATE_LIMITED` + `Retry-After`.
- ACL del token en Windows: `whoami`/`icacls` por ruta absoluta de System32 vía `execFile`,
  por SID; el archivo se crea vacío, se protege y luego se escribe. Verificado con icacls real.
- 136 tests en verde (1 omitido: chmod POSIX en Windows).
- Re-auditoría: APROBADO CON OBSERVACIONES, sin P0/P1; dejó 7 P2 nuevos (ver tasks.md).
- Repo publicado en https://github.com/DanielEspinosaChim/CentroDeMando

### Cuarta parte (mismo día, cierre)

- Correcciones de los 7 P2 de la re-auditoría:
  - pause/stop quedan fuera del rate limit (detener siempre disponible).
  - Rechazo de rutas UNC y de dispositivo al registrar proyectos.
  - Revalidación del proyecto al lanzar un agente.
  - Tope de costo al reanudar = tope − gastado en la sesión (migración 3, `runs.resumed`).
  - Drenaje con cierre forzado a los 5 s; stop y shutdown cubren lo que drena; `idle()` con tope.
  - Escrituras del store filtradas por `workspaceId`.
  - ACL de la carpeta `dataDir` completa (`icacls` con `(OI)(CI)F`).
- QA: 209 tests en verde (1 omitido: chmod POSIX en Windows).
- Auditoría de verificación: APROBADO CON OBSERVACIONES, sin P0/P1; los 7 P2 cerrados.
- Código publicado en https://github.com/DanielEspinosaChim/CentroDeMando (rama `main`).

- CI de GitHub Actions en verde (windows-latest). Destapó que los runners crean archivos con entradas ACL explícitas de SYSTEM/Administradores; ahora también se quitan.

### Quinta parte (mismo día, cierre definitivo)

- N1 corregido: `runs.budget_usd` (migración 4); una ejecución sin costo reportado cuenta como su presupuesto completo al reanudar.
- N2 corregido: el motor no arranca si `CDM_DATA_DIR` es la raíz, la carpeta de usuario, un ancestro o UNC; la ACL de la carpeta solo se aplica si es del motor (nueva, vacía o solo con sus archivos).
- P1 N2-bis (encontrado por el auditor en la corrección de N2) corregido: se rechazan segmentos que terminan en `.`/espacio o con `:` (Windows los recorta: `C:\Users\u\. ` acababa cambiando permisos de la carpeta de usuario, y un proyecto `. ` lanzaba el agente en la carpeta padre). Aplica a `CDM_DATA_DIR`, proyectos y cwd.
- `stop` sobre una ejecución pausada deja el run en `stopped`.
- 276 tests en verde (1 omitido). Auditoría final: APROBADO, sin hallazgos.

## Qué quedó pendiente

- Avisos de Biome por `any` en tests.
- Siguiente feature: 002 (bus de mensajes).

## Decisiones tomadas

- Tope de costo por tarea por defecto: 2 USD (`CDM_MAX_COST_USD_PER_TASK`).
- `error_max_turns` / `error_max_budget_usd` del SDK no son fallos genéricos: el agente
  queda en `error` con "La tarea alcanzó el tope de turnos/costo".
- `live-check` es manual y nunca corre en CI (gasta tokens).

- **% de contexto**: se calcula con el `usage` del último paso del agente principal
  dividido entre `modelUsage[*].contextWindow` del `result`. No se usa
  `getContextUsage()` porque hace peticiones extra de conteo de tokens.
- **Herramientas permitidas** en esta feature: `Read`, `Glob`, `Grep`, `TodoWrite`,
  con rutas acotadas al `cwd` del proyecto. Todo lo demás se deniega hasta la feature 005.
  Esto significa que un `implementador` todavía no puede editar archivos.
- **`settingSources: []`** en el SDK: no se cargan los ajustes de usuario ni de proyecto
  para que sus reglas `allow` no se salten `canUseTool`. Consecuencia: el agente no lee
  el `CLAUDE.md` del proyecto. Revisarlo en la feature 005.
- Los modelos se pasan al SDK como alias (`haiku`, `sonnet`, `opus`).
- Se agregó `db/store.ts` (no estaba en el plan) para concentrar las consultas y
  forzar el filtro por `workspaceId`.
- `Origin` ausente se acepta (clientes que no son navegador); presente y ajeno → 403.
- Migraciones con SQL propio y `PRAGMA user_version` en vez de drizzle-kit.
- Puerto por defecto `4317`; variables: `CDM_PORT`, `CDM_UI_ORIGIN`, `CDM_DATA_DIR`,
  `MAX_CONCURRENT_AGENTS`, `CDM_MAX_TURNS`.
- `pnpm-workspace.yaml` usa `allowBuilds` (pnpm 11) para `better-sqlite3` y `esbuild`.
- Rate limit sin dependencias (limitador propio, ventana deslizante); pause/stop sin límite
  porque no lanzan procesos y detener debe estar siempre disponible.
- Sin saldo al reanudar → 409 (esperar no libera saldo).
- Ante la duda, el tope de costo sobrestima (cuenta el presupuesto completo si no hay costo reportado).
- Si `CDM_DATA_DIR` ya existe con archivos ajenos, el motor no toca su ACL (solo avisa); el token se protege igual.
