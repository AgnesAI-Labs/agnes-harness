import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ChildAgentEvent, ChildAgentStartOptions } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { claudeCodeChildAgentProvider } from '../src/provider.js'

const fixture = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))

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

it('streams Claude Code text once and interrupts the process', async () => {
  process.env.CLAUDE_CHILD_SECRET = 'super-secret'
  const provider = claudeCodeChildAgentProvider({
    enabled: true,
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
    const text = events.filter((event) => event.type === 'text')
    expect(text).toEqual([{ type: 'text', text: 'echo:hello' }])
    expect(JSON.stringify(events)).not.toContain('super-secret')
  } finally {
    delete process.env.CLAUDE_CHILD_SECRET
    await handle.dispose()
    await reading
  }
  const blocked = claudeCodeChildAgentProvider({
    enabled: true,
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
    await expect(blocked.start('x', startOptions({ model: 'opus' }))).rejects.toThrow('model')
  } finally {
    await running.dispose()
    await follow
  }
})
