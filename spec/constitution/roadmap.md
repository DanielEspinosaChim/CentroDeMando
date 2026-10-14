# Roadmap

Orden de construcción de las features, de la más fundacional a la más
opcional. Los números de feature (00X) corresponden a las carpetas en
`spec/features/`.

## MVP — Fase 1: el núcleo (construir primero)

1. **[001-motor-de-agentes]** — Servicio local que lanza, pausa, reanuda y detiene
   agentes de Claude Code con el Agent SDK, y emite sus eventos en tiempo real.
   Todo lo demás se monta encima.
2. **[002-bus-de-mensajes]** — Mensajería entre agentes (directa y a todos), con
   bandeja por agente. Base de la coordinación y de lo que se dibuja en la UI.
3. **[003-enrutador-de-modelos]** — Elige Haiku / Sonnet / Opus por tarea según
   tamaño y riesgo, con escalamiento automático y piso de seguridad. Explica cada
   decisión.
4. **[004-flujo-sdd]** — Orquestación con tus skills de SDD: coordinador → planeador
   → implementador → QA → seguridad → documentador, leyendo `spec/features/`.
   Requiere 001-003.
5. **[005-aprobaciones]** — Antes de una acción riesgosa (borrar, publicar, instalar,
   push, comandos destructivos) el agente se detiene y pide tu OK en la app. Va
   temprano porque es seguridad.
6. **[006-centro-de-mando-visual]** — Interfaz en tiempo real: agentes como
   tarjetas de vidrio con halo animado, líneas de luz para los mensajes, medidor
   de contexto por agente, transiciones animadas entre secciones.
7. **[007-mod-monitoreo]** — Mod de Claude Code (status line + hooks): contexto
   usado, costo por sesión, uso de límites de 5 h y semanal, sugerencias de
   cuándo compactar; reporta al motor.
8. **[008-personalizacion-agentes]** — Nombre, cara/avatar, colores y
   personalidad de cada agente.

## Siguiente etapa — Fase 2: conexiones

9. **[009-sesiones-externas]** — Conectar proyectos y sesiones de Claude Code que
   ya tengas abiertas (vía el mod de 007) para que hablen con tus agentes.
10. **[010-perfiles-de-cuenta]** — Varias cuentas de Claude (p. ej. personal y
    trabajo), cada una con sus agentes, y cambio entre ellas.
11. **[011-repeticion-de-sesiones]** — Reproducir la "película" de una sesión:
    qué hizo cada agente, en orden.
12. **[012-notificaciones-movil]** — Avisos al celular cuando un agente termina,
    se atora o espera una aprobación.

## Fase 3: producto

13. **[013-app-escritorio]** — Instalador con Tauri, actualizaciones automáticas.
14. **[014-usuarios-y-aislamiento]** — Registro, login y aislamiento total de datos
    entre clientes.
15. **[015-planes-y-pagos]** — Planes de pago. Antes: revisar con los términos de
    Anthropic cómo conecta cada cliente su acceso a Claude (API key propia vs.
    suscripción). <!-- REVISAR: requisito legal antes de cobrar -->

## Backlog / ideas futuras — Fase 4: "Jarvis" (sin priorizar todavía)

- Correo: leer, resumir, redactar respuestas (con aprobación antes de enviar).
- Calendario: agenda, recordatorios, sugerir horarios.
- Seguimiento de vida: hábitos, pendientes personales, metas.
- Pedirle cosas en lenguaje natural (texto o voz) y que despliegue los agentes adecuados.

---

*Este roadmap se ajusta con el tiempo. Antes de reordenar prioridades,
actualízalo aquí primero.*
