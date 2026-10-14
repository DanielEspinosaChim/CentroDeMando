# Tasks — Enrutador de modelos

Checklist de tareas atómicas y verificables. Marcar `[x]` solo cuando esté
implementado Y verificado, no solo escrito.

## Backend

- [ ] Esquemas Zod del enrutador y eventos `router.decision` / `router.warning`
- [ ] `default-config.ts` con palabras clave en español e inglés y modelos por rol
- [ ] `classifier.ts`: normalización de texto y `RuleClassifier` (tamaño y riesgo)
- [ ] `route.ts`: override → tamaño → piso de riesgo → escalamiento
- [ ] `config-store.ts`: leer/escribir `router-config.json` con validación
- [ ] Columnas nuevas en `runs` + migración
- [ ] Integrar `route()` en `AgentManager` (lanzar y reintentar)
- [ ] Rutas `/router/config`, `/router/stats` y `.../retry`

## Frontend

- [ ] No aplica en esta feature (las decisiones se muestran en 006)

## Tests unitarios

- [ ] Tarea trivial de cualquier rol → `haiku`, `small` (criterio 2)
- [ ] Tarea de arquitectura → `opus`, `large` (criterio 3)
- [ ] Sin señales → modelo por defecto de cada uno de los 7 roles (criterio 4)
- [ ] Tarea chica con "token" o "pago" → nunca `haiku` (criterio 5)
- [ ] Override por debajo del piso → se respeta y genera advertencia (criterio 6)
- [ ] Escalamiento haiku → sonnet → opus → opus (criterio 7)
- [ ] Determinismo: 100 llamadas con la misma entrada dan la misma salida (criterio 10)
- [ ] Normalización: "Contraseña" y "contrasena" se detectan igual

## Tests de integración

- [ ] Lanzar tarea sin modelo: el runner fake recibe el modelo decidido y se emite `router.decision` (criterio 1)
- [ ] Dos fallos + reintento → el runner recibe el modelo escalado
- [ ] `PUT /router/config` cambia la siguiente decisión (criterio 8)
- [ ] `GET /router/stats` suma ejecuciones y costo por modelo (criterio 9)

## Tests de seguridad

- [ ] Validación de inputs cubierta con test: config inválida o con `riskKeywords` vacío → 400
- [ ] Control de acceso cubierto con test: `/router/*` sin token → 401
- [ ] Test de aislamiento multi-tenant: `/router/stats` no incluye ejecuciones de otro `workspaceId`
- [ ] Revisar contra `spec/features/000-seguridad-transversal/spec.md`
      antes de mergear

## E2E

- [ ] Script de humo: tres tareas (trivial, normal, grande) con `FakeAgentRunner` producen haiku, rol por defecto y opus respectivamente

---

*Al completar una tarea, márcala con `[x]`. Si surge una tarea nueva no
prevista, agrégala al final de su sección correspondiente en vez de
modificar las ya existentes. Si una tarea queda parcial, déjala en `[ ]`
con una nota `<!-- parcial: falta X -->`.*
