# Misión

<!-- REVISAR: "Centro de Mando" es nombre de trabajo; falta el nombre definitivo del producto. -->

## Qué construimos

Un centro de mando visual para orquestar agentes de Claude Code. Desde una sola
app despliegas varios agentes —cada uno con nombre, cara, color y personalidad—
que trabajan sobre tus proyectos siguiendo tu metodología de Spec-Driven
Development (coordinador, planeador, implementador, QA, seguridad, diseño y
documentación), se comunican entre sí y con tus sesiones de Claude Code, y los
ves trabajar en tiempo real en una interfaz animada.

La app decide qué modelo usar en cada tarea (Opus, Sonnet o Haiku) según su
tamaño y riesgo, vigila el contexto y el consumo de cada sesión, y te sugiere
cuándo compactar antes de que sea un problema.

## Para quién

1. **Primero:** para el fundador, como herramienta personal de trabajo diario en Windows.
2. **Después:** para otros desarrolladores y equipos que trabajan con Claude Code,
   como producto de pago.

## Qué problema resuelve

Hoy, coordinar varias sesiones de Claude Code es manual: cada sesión es una caja
negra, no se hablan entre ellas, no sabes cuál está gastando más ni cuándo se le
va a llenar el contexto, y eliges el modelo a mano (normalmente el más caro, por
si acaso). Además, seguir una metodología como SDD depende de la disciplina de
quien escribe los prompts.

## Qué lo hace distinto

- No es "otro chat con agentes": es un **equipo de desarrollo visible** que sigue
  una metodología (SDD) y que ves trabajar en vivo.
- **Enrutamiento justo de modelos:** el rol define qué hace el agente; la tarea
  define con qué modelo (Haiku para cambiar un color, Opus para diseñar un módulo).
- **Gestión de contexto y consumo proactiva:** sugiere compactar al cerrar una fase,
  no a media implementación; muestra cuánto llevas de tus límites de 5 horas y semanal.
- **Personajes:** cada agente es "alguien", personalizable, no una terminal anónima.

## Visión a largo plazo

Evolucionar hacia un asistente personal tipo "Jarvis": leer y gestionar correo,
calendario, seguimiento de vida y tareas pedidas en lenguaje natural. La
arquitectura se diseña desde ya para conectar esas fuentes después, pero no se
construyen en esta etapa.

## Fuera de alcance (por ahora)

- Correo, calendario y cualquier integración de "vida personal" (Fase 4).
- Registro de usuarios, pagos y versión en la nube (Fase 3).
- Soporte Mac/Linux en el MVP (el MVP se prueba en Windows; no se usan APIs
  exclusivas de Windows sin necesidad, para no cerrar la puerta).
- Usar varias cuentas para rodear o multiplicar límites de uso: el cambio de
  cuentas es para separar contextos (personal / trabajo), no para evadir límites.
