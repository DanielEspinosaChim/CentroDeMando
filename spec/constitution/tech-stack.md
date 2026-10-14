# Tech Stack

## Lenguaje

TypeScript (modo `strict`) en todo el proyecto: motor, interfaz y paquetes compartidos.

## Framework / runtime

Monorepo con **pnpm workspaces**:

- **`apps/engine` — el motor (el "cerebro").** Node.js 22+ con:
  - `@anthropic-ai/claude-agent-sdk`: lanza y controla agentes de Claude Code
    (`query()` con `model`, `cwd`, `systemPrompt`, `canUseTool`, `hooks`,
    `resume`, `setModel()`, `interrupt()`). Cada mensaje `result` trae
    `total_cost_usd`, `usage` y `modelUsage`.
  - **Fastify** para la API REST local y **@fastify/websocket** para eventos en
    tiempo real hacia la interfaz.
  - **Zod** para validar toda entrada.
- **`apps/ui` — la interfaz.** React 19 + Vite, con:
  - **Framer Motion (`motion`)** para transiciones entre secciones y animación de tarjetas.
  - **WebGL** (Three.js o shaders propios con OGL) para los fondos animados en vivo
    estilo Pryzm. <!-- REVISAR: decidir Three.js vs OGL al implementar el fondo -->
  - **Zustand** para el estado del cliente y **TanStack Query** para datos del motor.
- **`packages/shared`** — tipos y esquemas Zod compartidos (eventos, agentes, mensajes).
- **`packages/mod`** — mod de Claude Code (status line + hooks) para las sesiones externas.
- **`apps/desktop`** — empaquetado con **Tauri 2** (Fase 3).

## Base de datos

- **SQLite** local vía `better-sqlite3` + **Drizzle ORM**, archivo en
  `%APPDATA%/centro-de-mando/data.db`. Modo WAL.
- **PostgreSQL** cuando sea producto en la nube (Fase 3); Drizzle permite migrar
  sin reescribir el modelo.

## Testing

- **Vitest**: unitarias e integración (motor y lógica de UI).
- **Playwright**: E2E de la interfaz (también disponible como MCP para el agente de QA).
- El SDK de Claude se envuelve en un adaptador (`AgentRunner`) para poder usar un
  doble de prueba: los tests nunca gastan tokens reales.

## Otras herramientas relevantes

- Gestor de paquetes: **pnpm**.
- Lint y formato: **Biome**.
- Git + GitHub (MCP de GitHub disponible para los agentes).
- CI: GitHub Actions con runner `windows-latest` (lint + tests). <!-- REVISAR: confirmar al crear el repo -->

## Convenciones de versión

- Node 22 LTS o superior.
- Windows 10 1809+ con Git for Windows instalado (Claude Code usa Git Bash para
  su herramienta Bash y para los hooks).
- Claude Code instalado de forma nativa en Windows.

---

*Decidido en la entrevista inicial. Si se cambia algo del stack más adelante,
actualizar este archivo primero (nivel spec-anchored) antes de tocar código.*
