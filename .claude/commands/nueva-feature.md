---
description: "Especifica una feature nueva con el formato SDD del proyecto (spec.md, plan.md, tasks.md) antes de escribir código. Uso: /nueva-feature <descripción>"
argument-hint: "<qué quieres construir>"
---

Especifica esta feature antes de tocar código: $ARGUMENTS

1. Revisa `docs/` (contexto de sesiones previas), `spec/constitution/` (misión, stack, roadmap) y las features existentes en `spec/features/` para seguir el mismo formato. No vuelvas a preguntar lo que ya está documentado.
2. Si hay ambigüedades que cambian el diseño, haz como máximo 3 preguntas concretas, cada una con tu recomendación.
3. Crea `spec/features/NNN-<nombre-corto>/` (NNN = siguiente número libre) con:
   - `spec.md`: qué hace, módulos que toca, de qué depende, fuera de alcance, y al menos 5 criterios de aceptación verificables, cada uno con un ejemplo concreto de entrada y resultado esperado.
   - `plan.md`: archivos exactos, endpoints (método, path, descripción), modelo de datos (campos y tipos), flujo técnico, consideraciones de seguridad, y una tabla criterio → test que lo verifica.
   - `tasks.md`: tareas atómicas por sección, cada una con su test primero, más los checks de `spec/features/000-seguridad-transversal/spec.md`.
4. Si la feature está en `spec/constitution/roadmap.md`, enlázala; si no, agrégala ahí.
5. Haz la revisión de spec: 5+ criterios verificables, archivos exactos, endpoints, modelo de datos, tareas atómicas, test de aislamiento si aplica, y sin `<!-- REVISAR -->`. Termina con **LISTO PARA IMPLEMENTAR** o con la lista de lo que falta.
6. Deja una nota en `docs/` como indica `CLAUDE.md`.

No escribas código de producción en este comando.
