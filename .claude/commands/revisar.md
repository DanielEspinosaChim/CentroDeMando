---
description: "Revisa los cambios de la rama con el esfuerzo proporcional a su tamaño y riesgo. Uso: /revisar [rama base]"
argument-hint: "[rama base, por defecto main]"
---

Revisa los cambios de esta rama. Rama base: `$ARGUMENTS` (si está vacío, `main`). Abajo la llamo BASE.

1. Mide: `git diff --stat BASE...HEAD`. Clasifica según "Proporcionalidad" en `CLAUDE.md`:
   - **Chico** (pocas líneas, sin auth, pagos, datos sensibles, migraciones ni modelos): revísalo tú mismo, sin subagentes, contra el checklist de `.claude/rules/revision.md`.
   - **Mediano**: `tester` + `auditor-seguridad` en paralelo.
   - **Crítico** (auth, permisos, pagos, datos personales, migraciones, ML o LLM a producción): `tester` + `auditor-seguridad` (checklist completo) + un especialista si aplica (`mle-reviewer`, `rag-pipeline-reviewer`, `database-reviewer`...).
2. Hallazgos ordenados CRÍTICO, ALTO, MEDIO, BAJO, con `archivo:línea`, por qué importa y el arreglo. Omite lo cosmético si hay problemas reales.
3. Veredicto en una línea: BLOQUEAR, APROBAR CON CAMBIOS o APROBAR.

No modifiques código. Pregunta antes de aplicar arreglos.
