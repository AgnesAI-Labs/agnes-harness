import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resetChildAgentAllowlists } from '@agnes/core'
import type { ChildAgentEvent, ChildAgentStartOptions } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { sdkChildAgentProvider } from '../src/provider.js'
import {
  childEnginePlugins,
  childEngineSettingsError,
  DISABLED_CHILD_ENGINES,
  parseChildEngineSettings,
} from '../src/settings.js'

const fixture = fileURLToPath(new URL('./fake-sdk.mjs', import.meta.url))
const acpFixture = fileURLToPath(new URL('../../subagent-acp/test/fixture-agent.mjs', import.meta.url))

function startOptions(): ChildAgentStartOptions {
  return { signal: new AbortController().signal, sessionKey: 'parent', cwd: tmpdir() }
}

async function until(events: ChildAgentEvent[], done: () => boolean): Promise<void> {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > 2000) throw new Error(`timed out: ${JSON.stringify(events)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('streams a generic SDK child and cancels it', async () => {
  process.env.SDK_CHILD_SECRET = 'super-secret'
  const provider = sdkChildAgentProvider({
    enabled: true,
    protocol: 'sdk',
    command: process.execPath,
    args: [fixture],
    allow: [process.execPath],
  })
  const handle = await provider.start('hello', startOptions())
  const events: ChildAgentEvent[] = []
  const reading = (async () => {
    for await (const event of handle.events()) events.push(event)
  })()
  try {
    await expect(handle.result()).resolves.toMatchObject({ status: 'completed', text: 'echo:hello' })
    expect(JSON.stringify(events)).not.toContain('super-secret')
    expect(provider.capabilities.continuable).toBe(false)
    expect(provider.capabilities.modelSelection).toBe(false)
  } finally {
    delete process.env.SDK_CHILD_SECRET
    await handle.dispose()
    await reading
    resetChildAgentAllowlists()
  }
  const blocked = sdkChildAgentProvider({
    enabled: true,
    protocol: 'sdk',
    command: process.execPath,
    args: [fixture, '--block'],
    allow: [process.execPath],
  })
  const running = await blocked.start('wait', startOptions())
  const live: ChildAgentEvent[] = []
  const follow = (async () => {
    for await (const event of running.events()) live.push(event)
  })()
  try {
    await until(live, () => live.some((event) => event.type === 'text'))
    await expect(running.interrupt()).resolves.toEqual({ accepted: true })
    await expect(running.result()).resolves.toMatchObject({ status: 'interrupted' })
  } finally {
    await running.dispose()
    await follow
  }
})

it('can speak ACP and refuses a disabled or unlisted command', async () => {
  const provider = sdkChildAgentProvider({
    enabled: true,
    protocol: 'acp',
    command: process.execPath,
    args: [acpFixture],
    allow: [process.execPath],
  })
  expect(provider.id).toBe('acp')
  expect(provider.capabilities.continuable).toBe(true)
  const handle = await provider.start('hello', startOptions())
  const events: ChildAgentEvent[] = []
  const reading = (async () => {
    for await (const event of handle.events()) events.push(event)
  })()
  try {
    await until(events, () =>
      events.some((event) => event.type === 'text' && event.text.includes('echo:hello')),
    )
    await handle.sendMessage('next', new AbortController().signal)
    await until(events, () =>
      events.some((event) => event.type === 'text' && event.text.includes('echo:next')),
    )
  } finally {
    await handle.dispose()
    await reading
    resetChildAgentAllowlists()
  }
  await expect(
    sdkChildAgentProvider({ ...DISABLED_CHILD_ENGINES.sdk, command: 'missing' }).start('x', startOptions()),
  ).rejects.toThrow('disabled')
  expect(childEngineSettingsError(DISABLED_CHILD_ENGINES)).toBeUndefined()
  expect(
    childEngineSettingsError({
      ...DISABLED_CHILD_ENGINES,
      codex: { enabled: true, command: 'codex', args: [], allow: [] },
    }),
  ).toBe('allow')
  expect(parseChildEngineSettings({ codex: { enabled: true } })).toEqual(DISABLED_CHILD_ENGINES)
  const plugins = childEnginePlugins(DISABLED_CHILD_ENGINES)
  let registered = 0
  for (const plugin of plugins) {
    plugin.apply({
      childAgents: {
        register() {
          registered += 1
          return async () => undefined
        },
      },
    } as never)
  }
  expect(registered).toBe(0)
})
