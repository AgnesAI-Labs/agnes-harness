import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetChildAgentAllowlists } from '@agnes/core'
import type { ChildAgentEvent, ChildAgentStartOptions } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { codexChildAgentProvider, codexChildAgentsPlugin } from '../src/provider.js'

const fixture = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))

function config(extra: string[] = []) {
  return {
    enabled: true,
    command: process.execPath,
    args: [fixture, ...extra],
    allow: [process.execPath],
  }
}

function startOptions(over: Partial<ChildAgentStartOptions> = {}): ChildAgentStartOptions {
  return { signal: new AbortController().signal, sessionKey: 'parent', cwd: tmpdir(), ...over }
}

async function until(events: ChildAgentEvent[], done: () => boolean): Promise<void> {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > 2000) throw new Error(`timed out: ${JSON.stringify(events)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('streams Codex text and does not pass the parent environment', async () => {
  process.env.CODEX_CHILD_SECRET = 'super-secret'
  const provider = codexChildAgentProvider(config())
  const handle = await provider.start('hello', startOptions())
  const events: ChildAgentEvent[] = []
  const reading = (async () => {
    for await (const event of handle.events()) events.push(event)
  })()
  try {
    await until(events, () => events.some((event) => event.type === 'text'))
    expect(events.some((event) => event.type === 'text' && event.text === 'echo:hello')).toBe(true)
    expect(events.some((event) => event.type === 'text' && event.text.includes('super-secret'))).toBe(false)
    await expect(handle.result()).resolves.toMatchObject({ status: 'completed', text: 'echo:hello' })
    await expect(handle.sendMessage('again', new AbortController().signal)).rejects.toThrow('not continuable')
    const listed = await provider.list?.('parent')
    expect(listed?.some((child) => child.id === handle.id && child.text === 'echo:hello')).toBe(true)
  } finally {
    delete process.env.CODEX_CHILD_SECRET
    await handle.dispose()
    await reading
    resetChildAgentAllowlists()
  }
})

it('interrupts a running Codex process', async () => {
  const provider = codexChildAgentProvider(config(['--block']))
  const handle = await provider.start('wait', startOptions())
  const events: ChildAgentEvent[] = []
  const reading = (async () => {
    for await (const event of handle.events()) events.push(event)
  })()
  try {
    await until(events, () => events.some((event) => event.type === 'text'))
    await expect(handle.interrupt()).resolves.toEqual({ accepted: true })
    await expect(handle.result()).resolves.toMatchObject({ status: 'interrupted' })
    await expect(handle.interrupt()).resolves.toEqual({ accepted: false })
  } finally {
    await handle.dispose()
    await reading
  }
})

it('refuses capabilities it does not have and stays disabled until allowlisted', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'agh-codex-')), 'spawned')
  const disabled = codexChildAgentProvider({ ...config([`--marker=${marker}`]), enabled: false })
  await expect(disabled.start('nope', startOptions())).rejects.toThrow('disabled')
  const blocked = codexChildAgentProvider({ ...config([`--marker=${marker}`]), allow: [] })
  await expect(blocked.start('nope', startOptions())).rejects.toThrow('not allowlisted')
  const provider = codexChildAgentProvider(config())
  await expect(provider.start('nope', startOptions({ model: 'gpt' }))).rejects.toThrow('model')
  await expect(provider.start('nope', startOptions({ fork: true }))).rejects.toThrow('parent context')
  await expect(provider.start('nope', startOptions({ isolation: 'worktree' }))).rejects.toThrow('worktree')
  await expect(provider.start('nope', startOptions({ budget: 1 }))).rejects.toThrow('budget')
  await expect(provider.start('nope', startOptions({ toolFilter: { deny: ['shell'] } }))).rejects.toThrow(
    'tools',
  )
  const { existsSync } = await import('node:fs')
  expect(existsSync(marker)).toBe(false)
  let registered = false
  codexChildAgentsPlugin.apply(
    {
      childAgents: {
        register() {
          registered = true
          return async () => undefined
        },
      },
    } as never,
    { enabled: false, command: 'codex', args: [], allow: [] },
  )
  expect(registered).toBe(false)
})
