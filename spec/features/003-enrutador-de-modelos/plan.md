# Plan — Enrutador de modelos

## Enfoque técnico

Un módulo puro `route(input, config)` que recibe el texto de la tarea, el rol, el
modelo pedido (si hay) y el historial de fallos de la tarea, y devuelve la
decisión con sus razones. Se basa en reglas configurables (palabras clave en
español e inglés para tamaño y riesgo, longitud del prompt, rol) en tres pasos:
tamaño → modelo base; riesgo → piso; reintentos → escalamiento. Al ser puro es
fácil de probar y, más adelante, se puede añadir un clasificador con Haiku detrás
de la misma interfaz `Classifier` sin tocar al resto.

## Archivos a crear/modificar

- `packages/shared/src/schemas/router.ts` — `ModelTier`, `TaskSize`, `RiskLevel`, `RoutingDecision`, `RouterConfig`
- `packages/shared/src/schemas/events.ts` — agregar `router.decision` y `router.warning`
- `apps/engine/src/router/route.ts` — función pura `route()`
- `apps/engine/src/router/classifier.ts` — interfaz `Classifier` + `RuleClassifier` (tamaño y riesgo por reglas)
- `apps/engine/src/router/default-config.ts` — palabras clave y modelos por rol por defecto
- `apps/engine/src/router/config-store.ts` — lee/escribe `router-config.json` en la carpeta de datos, validado con Zod
- `apps/engine/src/db/schema.ts` — columnas nuevas en `runs` + migración
- `apps/engine/src/agents/manager.ts` — llamar a `route()` antes de lanzar y al reintentar
- `apps/engine/src/routes/router.ts` — `GET/PUT /router/config`, `GET /router/stats`
- `apps/engine/src/routes/agents.ts` — `POST /agents/:id/tasks/:runId/retry`

## Endpoints

| Método | Path | Descripción |
|---|---|---|
| GET | `/router/config` | Configuración actual del enrutador |
| PUT | `/router/config` | Reemplaza la configuración (validada con Zod) |
| GET | `/router/stats` | Ejecuciones y costo estimado por modelo del workspace |
| POST | `/agents/:id/tasks/:runId/retry` | Reintenta una ejecución fallida aplicando escalamiento |

## Modelo de datos

Columnas nuevas en `runs`:

| Campo | Tipo | Notas |
|---|---|---|
| taskSize | text | enum: `small`, `medium`, `large`, `unknown` |
| risk | text | enum: `normal`, `high` |
| routingSource | text | enum: `rule`, `role_default`, `override`, `escalation` |
| routingReasons | text | JSON: arreglo de strings legibles |
| retryOfRunId | text | nullable, FK → runs.id |
| consecutiveFailures | integer | fallos seguidos de la cadena de reintentos, inicia en 0 |

`RouterConfig` (archivo `router-config.json`):

| Campo | Tipo | Notas |
|---|---|---|
| roleDefaults | record<rol, ModelTier> | modelo por defecto de cada rol |
| smallKeywords | string[] | p. ej. color, texto, typo, renombrar, copy, margen |
| largeKeywords | string[] | p. ej. arquitectura, diseñar módulo, refactor, migración, desde cero |
| riskKeywords | string[] | p. ej. contraseña, token, secret, .env, pago, stripe, permiso, auth |
| smallMaxChars | number | prompts más cortos que esto suman a "small" (por defecto 200) |
| escalateAfterFailures | number | por defecto 2 |

## Flujo técnico paso a paso

1. `AgentManager` arma `RouteInput { prompt, role, requestedModel?, consecutiveFailures }`.
2. `RuleClassifier` normaliza el texto (minúsculas, sin acentos) y calcula `size`
   (large si hay palabra grande; small si hay palabra chica y el prompt es corto;
   si no, `unknown`) y `risk`.
3. `route()`:
   a. Si hay `requestedModel` → ese modelo, `source = override`; si está bajo el piso, agrega advertencia.
   b. Si no: `small → haiku`, `large → opus`, `unknown → roleDefaults[role]` (`source = rule` o `role_default`).
   c. Piso: si `risk = high` y el modelo es `haiku` → `sonnet`, con razón.
   d. Escalamiento: si `consecutiveFailures >= escalateAfterFailures` → sube un nivel, `source = escalation`.
4. El manager guarda la decisión en el `run`, emite `router.decision` (y `router.warning` si aplica) y lanza con ese modelo.
5. Al fallar una ejecución, el reintento copia `consecutiveFailures + 1`; al tener éxito, la cadena se reinicia.

## Consideraciones de seguridad específicas de esta feature

- `PUT /router/config` exige token, valida con Zod (listas con máximo 200 palabras de
  máximo 60 caracteres) y no permite que `riskKeywords` quede vacío.
- El piso de riesgo no se puede desactivar desde la configuración; solo un override
  explícito del usuario lo salta, y siempre deja advertencia.
- `router/stats` filtra por `workspaceId`.
