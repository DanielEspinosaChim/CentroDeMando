# Checklist de seguridad transversal

Referencia fija que se usa para auditar **cualquier** módulo del proyecto
antes de mergear. No es específico de una feature — aplica a todas.

## Los 11 puntos

1. **Validación de inputs**: todo input de usuario se valida en tipo,
   formato y longitud antes de usarse. Aquí "input" incluye: peticiones HTTP y
   WebSocket al motor, datos que envían los hooks y la status line, y mensajes
   entre agentes (esquemas Zod de `packages/shared`).
2. **Control de acceso**: cada endpoint verifica autenticación Y
   autorización (no basta con saber que el usuario está logueado). En Fase 1 el
   motor exige un token local aleatorio (generado al arrancar, guardado con
   permisos solo del usuario) en cada petición HTTP y WebSocket.
3. **Aislamiento multi-tenant**: **Aplica** (a partir de la Fase 3, cuando sea
   producto de pago). Un usuario/cliente nunca puede leer ni modificar datos de
   otro tenant. Desde la Fase 1, toda tabla lleva columna `workspaceId` y toda
   consulta filtra por ella, para no tener que reescribir el modelo después.
   <!-- REVISAR: confirmado por suposición en el bootstrap; validar al diseñar la Fase 3 -->
4. **Manejo de secrets**: ninguna credencial, token o llave está
   hardcodeada ni se sube al repositorio (`.env*` en `.gitignore`). Los tokens de
   cuentas de Claude (`CLAUDE_CODE_OAUTH_TOKEN`) viven en el almacén de credenciales
   del sistema (Windows Credential Manager), nunca en SQLite ni en logs.
5. **Protección contra inyecciones**: SQL, NoSQL, comandos de sistema —
   nunca se concatenan inputs directamente en queries o comandos. SQL solo vía
   Drizzle con parámetros; procesos solo con `spawn` y arreglo de argumentos.
6. **Protección XSS/CSRF**: en cualquier superficie web que renderice
   contenido generado por usuarios. La salida de los agentes se renderiza como
   texto/markdown saneado, nunca como HTML crudo. El motor rechaza peticiones cuyo
   `Origin` no sea la interfaz (protege contra páginas web que llamen a localhost).
7. **Rate limiting**: en endpoints públicos o sensibles (login, registro,
   recuperación de contraseña, APIs de escritura). En el motor: límite de agentes
   simultáneos y de mensajes por minuto por agente (evita bucles entre agentes).
8. **Logging seguro**: nunca se registran contraseñas, tokens, ni datos
   personales sensibles en texto plano en los logs.
9. **Manejo de errores**: los mensajes de error al cliente no filtran
   stack traces, rutas internas, ni versiones de librerías.
10. **Dependencias**: sin vulnerabilidades conocidas (CVEs) sin mitigar o
    justificar (`pnpm audit` en CI).
11. **Subida de archivos** (si aplica): validación por tipo real (no solo
    extensión), tamaño máximo, y almacenamiento fuera de rutas ejecutables.
    Hoy no aplica; aplicará cuando se adjunten archivos a tareas.

## Puntos específicos de este proyecto

Un sistema de agentes tiene riesgos propios. Revisar también:

- **A. Inyección de instrucciones:** texto que llega de herramientas, archivos,
  páginas web, correos o de otro agente es *dato*, no orden. Los mensajes entre
  agentes se entregan marcados con su remitente y nunca pueden aprobar acciones
  ni cambiar permisos.
- **B. Acciones riesgosas con aprobación:** borrar, publicar, `git push`, instalar
  dependencias y comandos destructivos pasan por `canUseTool` → cola de
  aprobación (feature 005). Prohibido `bypassPermissions` en agentes del motor.
- **C. Directorio de trabajo acotado:** cada agente se lanza con `cwd` dentro de
  un proyecto registrado; se rechazan rutas fuera de él (incluye `..` y enlaces).
- **D. Topes de gasto:** cada agente tiene `maxTurns` y un tope de costo por tarea;
  al alcanzarlo se detiene y avisa.

## Formato de auditoría

Al auditar un módulo contra este checklist, reportar en el siguiente
formato:

```
Módulo: [nombre]
Fecha: [fecha]

1. Validación de inputs — [OK / P0 / P1 / P2 / No aplica] — [detalle si hay hallazgo]
2. Control de acceso — [...]
...
11. Subida de archivos — [...]
A–D. Puntos específicos — [...]

Resultado final: APROBADO / APROBADO CON OBSERVACIONES / RECHAZADO
```

- **P0**: crítico, bloquea el merge.
- **P1**: importante, debe resolverse pronto pero no bloquea si hay plan.
- **P2**: menor, mejora recomendada.
