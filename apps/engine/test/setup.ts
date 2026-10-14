import { vi } from 'vitest'

/**
 * Los tests nunca llaman al SDK real ni gastan tokens (CLAUDE.md). Si algún código
 * llega a `query()` durante la suite, falla en voz alta en vez de gastar dinero.
 * Las demás exportaciones del SDK (tipos, helpers) siguen siendo las reales.
 */
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...real,
    query: () => {
      throw new Error('Llamada real al SDK de Claude dentro de los tests: usa FakeAgentRunner')
    },
  }
})
