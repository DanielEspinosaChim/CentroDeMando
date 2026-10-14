# Spec — Enrutador de modelos

Estado: LISTO PARA IMPLEMENTAR

## Qué hace

Decide con qué modelo (Haiku, Sonnet u Opus) corre cada tarea según su tamaño y
riesgo, no solo según el rol del agente: cambiar el color de un botón va con
Haiku, diseñar un módulo nuevo va con Opus. Si una tarea falla dos veces, sube un
nivel de modelo; nada que toque credenciales, pagos o permisos baja de Sonnet.
Cada decisión queda registrada con su explicación, para que el usuario vea por
qué se eligió ese modelo y pueda corregirlo.

## Módulos que toca

- [x] Backend (`apps/engine`, `packages/shared`)
- [ ] Frontend

## Depende de

- 001-motor-de-agentes (ejecuciones y `AgentManager`).

## Fuera de alcance

- Clasificación con un modelo de lenguaje (se puede agregar después detrás de la
  misma interfaz); esta versión usa reglas deterministas y configurables.
- Mostrar las decisiones en la interfaz (006) y estadísticas visuales.
- Ajuste automático por límites de plan restantes (requiere 007).

## Criterios de aceptación

1. Cada tarea lanzada sin `model` explícito recibe una decisión
   `{ model, size, risk, reasons[], source }` que se guarda en la ejecución y se
   emite como evento `router.decision`.
2. Una tarea trivial (p. ej. "cambia el color del botón a azul") de cualquier rol
   se enruta a `haiku` con `size = small`.
3. Una tarea grande (p. ej. "diseña la arquitectura del módulo de pagos") se enruta
   a `opus` con `size = large`.
4. Sin señales claras de tamaño, se usa el modelo por defecto del rol
   (coordinador/planeador/seguridad → opus; implementador/qa/diseñador → sonnet;
   documentador → haiku) con `source = role_default`.
5. Si la tarea menciona credenciales, tokens, contraseñas, `.env`, pagos o permisos,
   `risk = high` y el modelo nunca es `haiku`, aunque la tarea sea pequeña.
6. Si el usuario indica `model`, se respeta (`source = override`); si queda por
   debajo del piso de riesgo, se emite además `router.warning`.
7. Si una tarea se reintenta tras dos fallos consecutivos, el reintento sube un
   nivel (haiku → sonnet → opus; opus se mantiene) con `source = escalation`.
8. Las listas de palabras clave y los modelos por rol se leen de un archivo de
   configuración editable; `PUT /router/config` valida y guarda cambios y la
   siguiente decisión ya los usa.
9. `GET /router/stats` devuelve, por modelo, número de ejecuciones y costo total
   estimado del `workspaceId`.
10. La función de decisión es pura y determinista: misma entrada, misma salida.
