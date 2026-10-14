# 2026-10-14 — Bootstrap SDD del Centro de Mando

## Qué se hizo
- Entrevista inicial: misión, stack, roadmap, MCPs, subagentes y seguridad.
- Se generó el scaffold SDD: constitución, CLAUDE.md, `.mcp.json`, 7 subagentes,
  checklist de seguridad y specs completas de 001, 002 y 003.
- Se descartó un prototipo inicial del bus en Python (detectaba sesiones con `ps`,
  que no existe en Windows). El bus se rehace en TypeScript dentro del motor (002).

## Qué quedó pendiente
- Nombre definitivo del producto.
- Capturas de referencia de diseño (Pryzm / Framer) y tipografía.
- Specs completas de 004 en adelante.
- Confirmar comandos del monorepo al crearlo.
- Antes de cobrar (Fase 3): revisar con los términos de Anthropic cómo conectan
  otros usuarios su acceso a Claude.

## Decisiones tomadas
- **Stack:** TypeScript + Claude Agent SDK + Fastify/WebSocket + React/Vite +
  Framer Motion + WebGL + SQLite/Drizzle + Tauri. Vitest + Playwright.
- **Plataforma inicial:** Windows nativo.
- **Modelos flexibles:** el rol da un modelo por defecto; el enrutador lo ajusta por
  tamaño/riesgo, escala tras 2 fallos y nunca baja de Sonnet en temas sensibles.
- **Monitoreo verificado:** la status line de Claude Code recibe `context_window`
  (`used_percentage`), `cost.total_cost_usd` y, en Pro/Max, `rate_limits`
  (`five_hour` / `seven_day`, `used_percentage`, `resets_at`). No hay API externa
  de límites del plan; se leen desde el mod (feature 007).
- **Cuentas:** se cambiarán con `CLAUDE_CODE_OAUTH_TOKEN` (de `claude setup-token`)
  por cuenta, pasado en `env` al SDK. Para separar contextos, no para evadir límites.
- **MCP en Windows:** Playwright se lanza con `cmd /c npx` (práctica comunitaria
  para Windows nativo, no requisito oficial); si `/mcp` lo muestra fallando,
  probar con `npx` directo.
- Aislamiento por cliente se asume "sí aplica" para la fase de producto.
