# CentroDeMando

Centro de mando visual para orquestar agentes de Claude Code con Spec-Driven Development.

- `apps/engine` — motor local (Fastify + WebSocket en 127.0.0.1, Claude Agent SDK, SQLite).
- `packages/shared` — esquemas Zod compartidos.
- `spec/` — constitución y specs de features; `docs/` — memoria de sesión.

```bash
pnpm install
pnpm test                       # tests (sin llamadas reales al SDK)
pnpm --filter engine start      # motor en 127.0.0.1:4317
pnpm --filter engine live-check # prueba manual con el SDK real (gasta tokens)
```

El token local está en `%APPDATA%/centro-de-mando/local-token`.
