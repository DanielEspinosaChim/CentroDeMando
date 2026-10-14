---
description: "Implementa una feature que ya dice LISTO PARA IMPLEMENTAR, tarea por tarea con test primero. Uso: /implementar spec/features/NNN-nombre"
argument-hint: "<carpeta de la feature>"
---

Implementa la feature en `$ARGUMENTS`.

1. Lee `spec.md`, `plan.md` y `tasks.md` de esa carpeta y la última nota de `docs/`. Si la spec no dice LISTO PARA IMPLEMENTAR o tiene `<!-- REVISAR -->`, para y dilo.
2. Rama: si no existe, sal de `main` limpio y crea `feat/<carpeta>` (mismo nombre que la carpeta de la spec); si ya existe, cámbiate a ella. Todo el trabajo de la feature va ahí, nunca en `main`.
3. Lee el nivel de riesgo de `spec.md`. **Chico:** haz tú las tareas. **Mediano o crítico:** pide al `coordinador` el orden y la asignación, y delega las tareas al `implementador` (varios en paralelo solo para tareas `[P]` independientes y largas). En ambos casos, por cada tarea:
   - Escribe el test, córrelo y confirma que falla por la razón correcta.
   - Implementa lo mínimo para que pase.
   - Corre solo los tests de lo que tocaste; la suite completa una vez al final.
   - Marca `[x]` en `tasks.md` solo si está implementado y verificado.
   - Haz commit cuando completes un avance lógico que ya funciona (puede abarcar una o varias tareas), nunca con tests en rojo, en Conventional Commits.
4. Si el plan resulta estar mal, para y propone el cambio a `plan.md`. No improvises un diseño distinto en silencio.
5. Al final:
   - Corre los comandos de "Terminado significa" del `CLAUDE.md` y pega la salida real.
   - Revisa contra `spec/features/000-seguridad-transversal/spec.md` los puntos que la feature toca.
   - Según el nivel de riesgo de `spec.md` (ver "Proporcionalidad" en `CLAUDE.md`): chico, tu verificación con la salida de los comandos basta; mediano y crítico, `tester` + `auditor-seguridad` en paralelo (en crítico, el auditor revisa el checklist completo y puede sumarse un especialista del paquete). Un P0 o un criterio sin probar bloquea el cierre.
6. Deja la nota en `docs/`. Para integrar sigue «Una rama por feature» del `CLAUDE.md`: trae `main` a la rama (`git merge main`) y vuelve a correr todos los tests; luego **pide mi OK para el merge** (con remoto: `/pr`; local: `git merge --no-ff`). Nunca integres por tu cuenta.
