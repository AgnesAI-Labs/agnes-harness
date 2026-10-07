import { fileURLToPath } from 'node:url'
import { resetChildAgentAllowlists, setChildAgentAllowlist } from '@agnes/core'
import type { ChildAgentEvent } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { acpChildAgentProvider } from '../src/provider.js'

const fixture = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url))
const cwd = '/tmp'

function provider(env?: Record<string, string>, agnesWorkspace?: boolean) {
  return acpChildAgentProvider({
    command: process.execPath,
    args: [fixture],
    ...(env ? { env } : {}),
    ...(agnesWorkspace ? { agnesWorkspace: true } : {}),
  })
}

async function readUntil(events: ChildAgentEvent[], done: () => boolean): Promise<void> {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > 2000) throw new Error(`timed out: ${JSON.stringify(events)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('runs an ACP child, continues it, and rejects a permission request', async () => {
  process.env.ACP_CHILD_SECRET = 'super-secret'
  const child = provider({ ACP_REQUIRE_WORKSPACE: '1' }, true)
  const handle = await child.start('hello', {
    signal: new AbortController().signal,
    sessionKey: 's',
    cwd,
  })
  const events: ChildAgentEvent[] = []
  const reading = (async () => {
    for await (const event of handle.events()) events.push(event)
  })()
  try {
    await readUntil(events, () =>
      events.some((event) => event.type === 'text' && event.text.includes('echo:hello:hidden')),
    )
    expect(events.some((event) => event.type === 'text' && event.text.includes('super-secret'))).toBe(false)
    await handle.sendMessage('permit', new AbortController().signal)
    await readUntil(events, () => events.some((event) => event.type === 'text' && event.text === 'perm:no'))
    await handle.sendMessage('unknown', new AbortController().signal)
    await readUntil(events, () =>
      events.some((event) => event.type === 'text' && event.text === 'unknown-ok'),
    )
    const listed = await child.list?.('s')
    expect(listed?.some((entry) => entry.id === handle.id && entry.continuable)).toBe(true)
  } finally {
    delete process.env.ACP_CHILD_SECRET
    await handle.dispose()
    await reading
    resetChildAgentAllowlists()
  }
  await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
})

it('interrupts an in-flight ACP turn and refuses capabilities it does not have', async () => {
  const child = provider()
  const handle = await child.start('block', {
    signal: new AbortController().signal,
    sessionKey: 's',
    cwd,
  })
  const events: ChildAgentEvent[] = []
  const reading = (async () => {
    for await (const event of handle.events()) events.push(event)
  })()
  try {
    await readUntil(events, () =>
      events.some((event) => event.type === 'status' && event.status === 'running'),
    )
    await expect(handle.interrupt()).resolves.toEqual({ accepted: true })
    await readUntil(events, () =>
      events.some((event) => event.type === 'status' && event.status === 'interrupted'),
    )
    await expect(
      child.start('x', { signal: new AbortController().signal, sessionKey: 's', cwd, model: 'fast' }),
    ).rejects.toThrow('cannot select a child model')
    await expect(
      child.start('x', { signal: new AbortController().signal, sessionKey: 's', cwd, fork: true }),
    ).rejects.toThrow('cannot inherit parent context')
    await expect(
      child.start('x', { signal: new AbortController().signal, sessionKey: 's', cwd, budget: 1 }),
    ).rejects.toThrow('cannot enforce a child budget')
    await expect(
      child.start('x', {
        signal: new AbortController().signal,
        sessionKey: 's',
        cwd,
        toolFilter: { deny: ['shell'] },
      }),
    ).rejects.toThrow('cannot filter child tools')
    setChildAgentAllowlist('s', { providers: [] })
    await expect(
      child.start('x', { signal: new AbortController().signal, sessionKey: 's', cwd }),
    ).rejects.toThrow('E_UNSUPPORTED')
  } finally {
    await handle.dispose()
    await reading
    resetChildAgentAllowlists()
  }
})

it('drains the fixture process when the parent lifetime aborts', async () => {
  const lifetime = new AbortController()
  const child = provider()
  const handle = await child.start('hello', { signal: lifetime.signal, sessionKey: 'abort-parent', cwd })
  lifetime.abort()
  await handle.dispose()
  await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
  expect(await child.list?.('abort-parent')).toEqual([])
  await expect(handle.sendMessage('late', new AbortController().signal)).rejects.toThrow('closed')
})
