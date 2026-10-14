import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { RunnerError } from './runner.ts'
import fixtures from './sdk-messages.fixture.json' with { type: 'json' }
import recording from './sdk-recording.fixture.json' with { type: 'json' }
import {
  createCanUseTool,
  createPreToolUseHook,
  createTranslateState,
  translateSdkMessage,
} from './sdk-runner.ts'

const messages = fixtures as unknown as Record<string, SDKMessage>
const msg = (key: string): SDKMessage => {
  const m = messages[key]
  if (!m) throw new Error(`falta fixture ${key}`)
  return m
}

describe('translateSdkMessage', () => {
  it('system/init → session', () => {
    expect(translateSdkMessage(msg('init'), createTranslateState())).toEqual([
      { type: 'session', sessionId: 'ses-abc' },
    ])
  })

  it('assistant con texto y tool_use → output + tool', () => {
    expect(translateSdkMessage(msg('assistantTextAndTool'), createTranslateState())).toEqual([
      { type: 'output', text: 'Voy a leer el README.' },
      { type: 'tool', tool: 'Read', toolUseId: 'toolu_01' },
    ])
  })

  it('ignora bloques de texto vacíos y de thinking', () => {
    expect(translateSdkMessage(msg('assistantThinking'), createTranslateState())).toEqual([])
  })

  it('user con tool_result → tool_result', () => {
    expect(translateSdkMessage(msg('toolResult'), createTranslateState())).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_01' },
    ])
  })

  it('result success → session + usage con costo y % de contexto', () => {
    const state = createTranslateState()
    translateSdkMessage(msg('assistantTextAndTool'), state) // 1000 + 9000 + 0 = 10 000 tokens
    const events = translateSdkMessage(msg('resultSuccess'), state)
    expect(events).toEqual([
      { type: 'session', sessionId: 'ses-abc' },
      {
        type: 'usage',
        inputTokens: 2000 + 15000 + 500,
        outputTokens: 800,
        costUsd: 0.0421,
        contextUsedPct: 5,
      },
    ])
  })

  it('los mensajes de subagentes no cuentan para el contexto principal', () => {
    const state = createTranslateState()
    translateSdkMessage(msg('subagentAssistant'), state)
    expect(state.lastContextTokens).toBe(0)
  })

  it('result con error de ejecución → RunnerError', () => {
    expect(() => translateSdkMessage(msg('resultExecutionError'), createTranslateState())).toThrow(
      RunnerError,
    )
  })

  it('tope de turnos o de costo → usage + limit (no un fallo genérico)', () => {
    const turns = translateSdkMessage(msg('resultError'), createTranslateState())
    expect(turns.map((e) => e.type)).toEqual(['session', 'usage', 'limit'])
    expect(turns.at(-1)).toEqual({ type: 'limit', limit: 'turns' })
    expect(turns[1]).toMatchObject({ costUsd: 0.5 })
    const budget = translateSdkMessage(msg('resultBudget'), createTranslateState())
    expect(budget.at(-1)).toEqual({ type: 'limit', limit: 'budget' })
  })

  it('mensajes desconocidos no producen eventos', () => {
    expect(
      translateSdkMessage(
        { type: 'stream_event' } as unknown as SDKMessage,
        createTranslateState(),
      ),
    ).toEqual([])
  })
})

describe('createCanUseTool', () => {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-tool-')))
  const can = createCanUseTool(cwd)
  const opts = { signal: new AbortController().signal, toolUseID: 't' } as Parameters<typeof can>[2]

  it('deniega por defecto herramientas fuera de la lista', async () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'mcp__github__create_pr']) {
      expect((await can(tool, {}, opts))?.behavior).toBe('deny')
    }
  })

  it('permite lectura dentro del proyecto', async () => {
    const res = await can('Read', { file_path: path.join(cwd, 'a.ts') }, opts)
    expect(res?.behavior).toBe('allow')
    expect((await can('Grep', { pattern: 'x', path: 'src' }, opts))?.behavior).toBe('allow')
  })

  it('deniega lectura fuera del proyecto', async () => {
    expect(
      (await can('Read', { file_path: path.join(cwd, '..', 'secreto') }, opts))?.behavior,
    ).toBe('deny')
    expect((await can('Glob', { pattern: '*', path: os.homedir() }, opts))?.behavior).toBe('deny')
  })
})

describe('createPreToolUseHook', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-hook-')))
  const cwd = path.join(root, 'proyecto')
  const outside = path.join(root, 'fuera')
  fs.mkdirSync(cwd)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secreto.txt'), 'x')
  fs.symlinkSync(outside, path.join(cwd, 'enlace'), 'junction')
  const hook = createPreToolUseHook(cwd)
  const call = (tool_name: string, tool_input: unknown) =>
    hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name,
        tool_input,
        tool_use_id: 't',
        session_id: 's',
        transcript_path: '',
        cwd,
      } as Parameters<typeof hook>[0],
      't',
      { signal: new AbortController().signal },
    )
  const decision = async (tool: string, input: unknown) =>
    (
      (await call(tool, input)) as {
        hookSpecificOutput?: { permissionDecision?: string }
      }
    ).hookSpecificOutput?.permissionDecision

  it('deniega herramientas fuera de la lista aunque Claude Code las auto-apruebe', async () => {
    expect(await decision('Bash', { command: 'echo hola' })).toBe('deny')
    expect(await decision('mcp__x__y', {})).toBe('deny')
  })

  it('deja pasar lecturas dentro del proyecto', async () => {
    expect(await decision('Read', { file_path: path.join(cwd, 'a.ts') })).toBeUndefined()
  })

  it('deniega patrones de Glob/Grep absolutos, con unidad, ~ o ".."', async () => {
    expect(await decision('Glob', { pattern: 'C:/Users/*/**/*.env' })).toBe('deny')
    expect(await decision('Glob', { pattern: '../**' })).toBe('deny')
    expect(await decision('Glob', { pattern: 'src/../../x' })).toBe('deny')
    expect(await decision('Glob', { pattern: '~/.ssh/*' })).toBe('deny')
    expect(await decision('Glob', { pattern: '/etc/*' })).toBe('deny')
    expect(await decision('Grep', { pattern: 'x', glob: '../**/*.ts' })).toBe('deny')
    expect(await decision('Glob', { pattern: 'src/**/*.ts' })).toBeUndefined()
    // En Grep `pattern` es una regex del contenido: puede llevar "..".
    expect(await decision('Grep', { pattern: 'a\\.\\.b' })).toBeUndefined()
  })

  it('deniega rutas UNC pedidas por el agente sin tocar el disco (ni la red)', async () => {
    // Resolver `\\evil\share\x` con realpath hace que Windows se conecte a ese servidor:
    // un agente con inyección de prompt podría filtrar el hash NTLM del usuario.
    const spy = vi.spyOn(fs.realpathSync, 'native')
    try {
      for (const tool of ['Read', 'Glob', 'Grep']) {
        for (const key of ['file_path', 'path']) {
          expect(await decision(tool, { [key]: '\\\\evil\\share\\x' })).toBe('deny')
          expect(await decision(tool, { [key]: '//evil/share/x' })).toBe('deny')
          expect(await decision(tool, { [key]: '\\\\?\\C:\\Users' })).toBe('deny')
        }
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('deniega rutas absolutas fuera y enlaces que salen del proyecto', async () => {
    expect(await decision('Read', { file_path: path.join(outside, 'secreto.txt') })).toBe('deny')
    expect(await decision('Read', { file_path: path.join(cwd, 'enlace', 'secreto.txt') })).toBe(
      'deny',
    )
    expect(await decision('Grep', { pattern: 'x', path: 'enlace' })).toBe('deny')
  })
})

describe('ejecución real grabada (SDK 0.3.296, haiku, Read de README.md)', () => {
  it('produce session → tool → tool_result → output → session + usage', () => {
    const state = createTranslateState()
    const events = (recording as unknown as SDKMessage[]).flatMap((m) =>
      translateSdkMessage(m, state),
    )
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool',
      'tool_result',
      'output',
      'session',
      'usage',
    ])
    expect(events[1]).toMatchObject({ type: 'tool', tool: 'Read' })
    expect(events[3]).toMatchObject({ type: 'output', text: '# Proyecto de prueba' })
    expect(events.at(-1)).toEqual({
      type: 'usage',
      inputTokens: 4 + 7017 + 6866,
      outputTokens: 106,
      costUsd: 0.00165366,
      // último paso: 2 + 6866 + 151 = 7019 tokens de una ventana de 1 000 000
      contextUsedPct: 0.7,
    })
  })
})
