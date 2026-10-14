import path from 'node:path'
import { SdkAgentRunner } from './agents/sdk-runner.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/client.ts'
import { createStore } from './db/store.ts'
import { getOrCreateLocalToken, TOKEN_FILE_NAME } from './security/local-token.ts'
import { buildServer } from './server.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  const handle = openDb(path.join(config.dataDir, 'data.db'))
  const store = createStore(handle.db)
  const interrupted = store.markInterrupted()
  const token = getOrCreateLocalToken(config.dataDir)

  const { app } = await buildServer({ config, store, runner: new SdkAgentRunner(), token })
  app.addHook('onClose', async () => handle.close())

  if (interrupted.runs > 0) {
    app.log.warn({ ...interrupted }, 'ejecuciones en curso marcadas como interrupted')
  }
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
