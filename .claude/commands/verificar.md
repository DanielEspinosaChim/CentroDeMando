---
description: "Verifica que el trabajo cumple sus criterios de aceptación, con evidencia. Uso: /verificar [carpeta de spec]"
argument-hint: "[spec/features/NNN-nombre]"
---

Verifica el trabajo actual contra: $ARGUMENTS (si está vacío, la feature de la rama actual en `spec/features/`).

1. Corre los comandos de "Terminado significa" del `CLAUDE.md`. Pega la salida real.
2. Tabla: criterio de aceptación | test o comando que lo prueba | estado.
3. Si la feature es mediana o crítica, lanza en paralelo `tester` y `auditor-seguridad` con `spec.md` y el diff contra `main` (sin tu razonamiento).
4. Veredicto. Si algo falla, reporta qué y el siguiente paso; no lo arregles aquí.
