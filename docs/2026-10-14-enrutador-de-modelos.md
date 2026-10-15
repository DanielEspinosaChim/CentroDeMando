# 2026-10-14 — Enrutador de modelos (feature 003)

Rama: `feat/003-enrutador-de-modelos`

## Qué se hizo
- Función pura `route()` y `RuleClassifier` que eligen el modelo por tarea.
- Config editable del router (`router-config.json` en dataDir), con lectura y escritura por `GET/PUT /router/config`.
- La decisión de enrutamiento se guarda en el run y se emite como `router.decision`; los avisos salen como `router.warning`.
- Reintentos con escalamiento de modelo: `POST /agents/:id/tasks/:runId/retry`.
- Estadísticas por modelo: `GET /router/stats`.
- Migración 5 (columnas del router en `runs`) y migración 6 (`runs.end_reason`).
- Resultado: 516 tests en verde y trazabilidad C003-1..10 completa.
- CI y auditoría: APROBADO CON OBSERVACIONES. Se corrigieron los 6 P2: piso de riesgo por subcadena con lista ampliada y normalización NFKC; `resume` con prompt sensible aplica el piso; retry de una ejecución cortada por tope responde 409; escritura atómica con `wx`.
- Se recuperó el trabajo parcial de un implementador interrumpido, que estaba en un stash. Se revisó y se completó.

## Qué quedó pendiente
- La config del router es global del motor. Guardarla por `workspaceId` queda para la Fase 3.
- Riesgo residual aceptado del piso de riesgo: homoglifos y leet ("pa$$word", letras cirílicas) no se detectan.
- Un test de reintento se colgó unos 510 s durante una corrida con varios agentes en paralelo. No se reprodujo en 10 corridas. Vigilar en CI.

## Decisiones tomadas
- El modelo por rol sale de la config del router, no de `agent.defaultModel`, que solo respalda al resume.
- El piso de riesgo (sonnet) no se puede desactivar por config. Solo un modelo explícito del usuario lo salta, y siempre con advertencia. Así una config no puede bajar la protección por error.
- Un resume sin prompt nuevo no re-enruta y conserva el modelo de la sesión.
- El reintento nunca baja del modelo que falló.
- La coincidencia de riesgo es por subcadena porque el error va al lado seguro. Falsos positivos como "apagar" → "pagar" suben a sonnet; se acepta.
- El orden de eventos es `thinking` → `router.decision` porque un test de la 001 exige que `thinking` vaya primero.
