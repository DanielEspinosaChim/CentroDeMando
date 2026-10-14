# Revisión proporcional

El esfuerzo de revisión depende del tamaño y del riesgo del cambio, no de que "haya código". Los hooks ya bloquean lo peligroso y corren lint y tests gratis; los subagentes cuestan tokens y tiempo, así que se usan solo donde pagan.

| Nivel | Ejemplos | Qué se hace |
| --- | --- | --- |
| **Chico** | Endpoint CRUD simple, bug evidente, cambio en un archivo, ajuste de texto o config | Test + lint + tipos. Revisión propia con el checklist de abajo. **Sin subagentes**: el agente principal cubre los 4 roles. |
| **Mediano** | Feature de varios archivos, refactor, lógica de negocio nueva | Los 4 roles: `coordinador` → `implementador` → `tester` + `auditor-seguridad` en paralelo al final. |
| **Crítico** | Auth y permisos, pagos, datos personales, multi-tenant, migraciones de BD, subida de archivos, ML o LLM a producción | Los 4 roles, con auditoría del checklist completo, + un especialista del paquete si aplica (ML, RAG, BD). |

Si dudas entre dos niveles, elige el mayor y dilo en el resumen. Un endpoint simple que toca auth, permisos, pagos o datos personales ya no es chico: es crítico.

## Checklist de revisión propia (todos los niveles)

- Cada criterio de aceptación tocado tiene un test que pasa.
- Entradas externas validadas; nada de concatenar input en SQL, shell o prompts.
- Sin secretos en código, sin `print`/`console.log` de depuración.
- Errores manejados explícitamente; nada de `except: pass` ni catch vacíos.
- El diff solo contiene lo que pidió la tarea.
- Los puntos de `spec/features/000-seguridad-transversal/spec.md` que el cambio toca están cubiertos.

## Severidad de hallazgos

CRÍTICO (bloquea: seguridad o pérdida de datos) · ALTO (bug real) · MEDIO (mantenibilidad) · BAJO (estilo, opcional). Reporta con `archivo:línea` y el arreglo sugerido.
