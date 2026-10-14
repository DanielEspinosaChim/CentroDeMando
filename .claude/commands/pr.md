---
description: "Prepara y abre un pull request limpio de la rama actual. Uso: /pr"
---

Abre un PR de la rama actual.

1. Confirma que no estás en `main` y que la rama es `feat/NNN-...` o `fix/NNN-...`. Si hay cambios sin commit, agrúpalos en commits por avance lógico con mensajes en imperativo (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
2. Corre los comandos de verificación del `CLAUDE.md`. Si algo falla, para y repórtalo; no abras un PR rojo.
3. Trae `main` a la rama (`git fetch origin && git merge origin/main`), resuelve conflictos ahí y vuelve a correr todos los tests.
4. Lee todo el historial de la rama (`git log main..HEAD`, `git diff main...HEAD`), no solo el último commit.
5. `git push -u origin <rama>` y `gh pr create` con esta descripción:
   - **Qué hace** (2 a 4 líneas, lo que hace el código ahora).
   - **Por qué** (enlace al issue o a la spec en `spec/features/`).
   - **Cómo se verificó** (comandos y su resultado).
   - **Riesgos o pendientes**, si los hay.
6. Devuelve el enlace del PR. El merge lo aprueba el humano en GitHub, sin squash; después se corren los tests en `main`, se borra la rama y se marca la feature en `spec/constitution/roadmap.md`.
