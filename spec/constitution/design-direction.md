# Dirección de diseño

Referencias dadas por el fundador:

- **Pryzm** — https://pryzm.design/ (vía https://godly.design/website/pryzm/)
- **Framer** — https://www.framer.com/

<!-- REVISAR: estas notas salen del contenido de las páginas, no de ver las capturas.
Agregar capturas o detalles concretos que gusten (pegarlos en docs/design-refs/). -->

## Qué tomamos de cada referencia

**De Pryzm — el ambiente:**
- Fondo casi negro `#0a0a0a`.
- Degradados que brillan: violeta, magenta, índigo, azul frío.
- Vidrio esmerilado y acanalado (barras verticales finas).
- Grano tipo película sobre todo.
- Fondos animados en **WebGL en vivo** (no video), con leve aberración cromática en bordes.

**De Framer — la estructura:**
- Vistas grandes del producto, jerarquía tipográfica fuerte y aire generoso.
- La demo del agente "pensando" en vivo, con estados de texto ("Pensando…",
  "Escribiendo pruebas…"). Es el corazón de nuestra vista de agentes.

## Traducción a la app

- **Agentes** = tarjetas de vidrio con avatar, nombre, rol y modelo en uso. Un halo
  de su color pulsa mientras piensa; se apaga cuando espera.
- **Mensajes** = líneas de luz que viajan de una tarjeta a otra.
- **Contexto** = anillo o barra por agente: verde → ámbar (70%) → rojo (90%).
- **Aprobaciones** = la tarjeta se ilumina en ámbar y aparece un panel de vidrio
  con "Aprobar / Rechazar".

## Transiciones (requisito explícito)

- Tablero → detalle de agente: la tarjeta se expande y se convierte en la vista
  completa (shared layout de Framer Motion), sin cortes ni recargas.
- Cambio de sección: el fondo WebGL se desplaza y cambia de tono por zona
  (violeta = agentes, índigo = consumo, magenta = mensajes).
- Entrada de secciones: desenfoque que se aclara, como vidrio enfocándose.
- Respetar `prefers-reduced-motion`: misma información, sin movimiento.

## Tokens iniciales

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#0a0a0a` | fondo base |
| `--glass` | `rgba(255,255,255,0.06)` + blur 24px | tarjetas |
| `--violet` | `#8b5cf6` | agentes |
| `--magenta` | `#d946ef` | mensajes |
| `--indigo` | `#6366f1` | consumo |
| `--warn` | `#f59e0b` | contexto 70% / aprobaciones |
| `--danger` | `#ef4444` | contexto 90% / errores |

<!-- REVISAR: tipografía pendiente de elegir con las capturas de referencia. -->
