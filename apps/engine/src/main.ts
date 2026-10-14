import path from 'node:path'
import { SdkAgentRunner } from './agents/sdk-runner.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/client.ts'
import { createStore } from './db/store.ts'
import { getOrCreateLocalToken, restrictDataDir, TOKEN_FILE_NAME } from './security/local-token.ts'
import { buildServer } from './server.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  // El logger aún no existe: se acumulan los avisos y se registran tras crear la app.
  const aclWarnings: string[] = []
  const onWarning = (message: string) => aclWarnings.push(message)
  // Primero la carpeta: data.db (y sus -wal/-shm) y el token nacen ya con la ACL privada
  // heredada, aunque CDM_DATA_DIR apunte a una carpeta compartida.
  restrictDataDir(config.dataDir, { onWarning })
  const handle = openDb(path.join(config.dataDir, 'data.db'))
  const store = createStore(handle.db)
  const interrupted = store.markInterrupted()
  const token = getOrCreateLocalToken(config.dataDir, { onWarning })

  const { app } = await buildServer({ config, store, runner: new SdkAgentRunner(), token })
  app.addHook('onClose', async () => handle.close())

  if (interrupted.runs > 0) {
    app.log.warn({ ...interrupted }, 'ejecuciones en curso marcadas como interrupted')
  }
  for (const message of aclWarnings) app.log.warn(message)
  // Nunca se registra el token, solo dónde está.
  app.log.info({ tokenFile: path.join(config.dataDir, TOKEN_FILE_NAME) }, 'token local listo')

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0))
    })
  }

  await app.listen({ host: config.host, port: config.port })
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
