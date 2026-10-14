---
description: "Depuración sistemática de un error o comportamiento raro, sin adivinar. Uso: /depurar <síntoma o error>"
argument-hint: "<síntoma, error o test que falla>"
---

Depura este problema: $ARGUMENTS

Usa la skill `systematic-debugging`. En resumen:

1. **Reproduce.** Consigue un comando o test que muestre el fallo de forma confiable. Si no se reproduce, dilo y pide datos; no sigas.
2. **Recolecta evidencia** antes de teorizar: mensaje de error completo, stack trace, logs, qué cambió recientemente (`git log -p --since=...`), entradas exactas.
3. **Hipótesis.** Lista 2 o 3 causas posibles ordenadas por probabilidad, cada una con la observación que la confirmaría o descartaría.
4. **Prueba una a la vez** con el experimento más barato (un print temporal, un test mínimo, una bisección con `git bisect`). Anota el resultado.
5. Cuando encuentres la causa raíz, escribe un test que falle por ella, arréglala, y confirma que el test pasa y nada más se rompió.
6. Quita prints y código temporal.

Reporta: síntoma, causa raíz con evidencia, arreglo, y cómo se verificó. Si después de 3 hipótesis descartadas no hay causa, para y resume lo que sabes en vez de seguir probando a ciegas.
