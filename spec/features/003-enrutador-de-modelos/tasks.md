# Tasks — Enrutador de modelos

Checklist de tareas atómicas y verificables. Marcar `[x]` solo cuando esté
implementado Y verificado, no solo escrito.

## Backend

- [x] Esquemas Zod del enrutador y eventos `router.decision` / `router.warning`
- [x] `default-config.ts` con palabras clave en español e inglés y modelos por rol
- [x] `classifier.ts`: normalización de texto y `RuleClassifier` (tamaño y riesgo)
- [x] `route.ts`: override → tamaño → piso de riesgo → escalamiento
- [x] `config-store.ts`: leer/escribir `router-config.json` con validación
- [x] Columnas nuevas en `runs` + migración
- [x] Integrar `route()` en `AgentManager` (lanzar y reintentar)
- [x] Rutas `/router/config`, `/router/stats` y `.../retry`
- [x] Piso de riesgo por subcadena (camelCase/snake_case) y lista base ampliada; normalización NFKC + caracteres invisibles
- [x] Resume con prompt sensible aplica el piso de riesgo
- [x] Reintento de una ejecución cortada por tope de turnos/costo responde 409 (columna runs.end_reason, migración 6)
- [x] Escritura atómica de router-config.json con temporal aleatorio y flag wx
- [ ] Deuda Fase 3: la configuración del router es global del motor; guardarla por `workspaceId` antes de multi-tenant

## Frontend

- [x] No aplica en esta feature (las decisiones se muestran en 006)

## Tests unitarios

- [x] Tarea trivial de cualquier rol → `haiku`, `small` (criterio 2)
- [x] Tarea de arquitectura → `opus`, `large` (criterio 3)
- [x] Sin señales → modelo por defecto de cada uno de los 7 roles (criterio 4)
- [x] Tarea chica con "token" o "pago" → nunca `haiku` (criterio 5)
- [x] Override por debajo del piso → se respeta y genera advertencia (criterio 6)
- [x] Escalamiento haiku → sonnet → opus → opus (criterio 7)
- [x] Determinismo: 100 llamadas con la misma entrada dan la misma salida (criterio 10)
- [x] Normalización: "Contraseña" y "contrasena" se detectan igual

## Tests de integración

- [x] Lanzar tarea sin modelo: el runner fake recibe el modelo decidido y se emite `router.decision` (criterio 1)
- [x] Dos fallos + reintento → el runner recibe el modelo escalado
- [x] `PUT /router/config` cambia la siguiente decisión (criterio 8)
- [x] `GET /router/stats` suma ejecuciones y costo por modelo (criterio 9)

## Tests de seguridad

- [x] Validación de inputs cubierta con test: config inválida o con `riskKeywords` vacío → 400
- [x] Control de acceso cubierto con test: `/router/*` sin token → 401
- [x] Test de aislamiento multi-tenant: `/router/stats` no incluye ejecuciones de otro `workspaceId`
- [x] Revisar contra `spec/features/000-seguridad-transversal/spec.md`
      antes de mergear — auditoría 2026-10-14: APROBADO CON OBSERVACIONES, P2 corregidos

## E2E

- [x] Script de humo: tres tareas (trivial, normal, grande) con `FakeAgentRunner` producen haiku, rol por defecto y opus respectivamente — `pnpm --filter engine smoke` imprime `humo OK` para haiku, sonnet y opus

---

*Al completar una tarea, márcala con `[x]`. Si surge una tarea nueva no
prevista, agrégala al final de su sección correspondiente en vez de
modificar las ya existentes. Si una tarea queda parcial, déjala en `[ ]`
con una nota `<!-- parcial: falta X -->`.*
