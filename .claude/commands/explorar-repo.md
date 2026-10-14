---
description: "Explica un repositorio desconocido y deja un mapa útil en docs/. Uso: /explorar-repo [área]"
argument-hint: "[área o pregunta, opcional]"
---

Explícame este repositorio. Enfoque: $ARGUMENTS

1. Si el repo es grande, usa un subagente `Explore` para no llenar el contexto; si es chico, léelo tú directo.
2. Identifica propósito, stack, puntos de entrada, módulos y cómo se comunican, cómo se corre, prueba y despliega. Verifica los comandos corriéndolos.
3. Señala riesgos: código sin tests, partes complejas, dependencias viejas, secretos mal manejados.
4. Entrega un mapa breve (Mermaid si ayuda) y una tabla "dónde está qué". Guárdalo en `docs/` como nota de sesión.
5. Si falta o está desactualizado `spec/constitution/` o el `CLAUDE.md`, propón el cambio y pregunta antes de escribirlo.
