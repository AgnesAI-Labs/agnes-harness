import { type ChildAgentResult, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import {
  assertChildAgentAllowed,
  resetChildAgentAllowlists,
  setChildAgentAllowlist,
} from '../src/child/allowlist.js'
import { externalChildren, trackExternalChild } from '../src/child/directory.js'
import { type InProcessChildBackend, inProcessChildAgentProvider } from '../src/child/provider.js'
import { ChildToolRegistry } from '../src/child/tool-filter.js'
import { Kernel } from '../src/kernel.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { hangingProvider, scripted, setupWith } from './helpers/child-traces.js'

function backend(): InProcessChildBackend & { messages: string[]; forked: number; resident: number } {
  const messages: string[] = []
  return {
    messages,
    forked: 0,
    resident: 0,
    async startResident() {
      this.resident += 1
      return { id: 'c1' }
    },
    async startFork(input) {
      this.forked += 1
      return { id: 'f1', text: `fork:${input.task}` }
    },
    async sendMessage(_id, text) {
      messages.push(text)
      return { messageId: 'm1' }
    },
    async interrupt() {
      return { accepted: true }
    },
    async cancel() {},
    async list() {
      return [{ id: 'c1', providerId: 'in-process', status: 'idle', continuable: true }]
    },
    onTurn() {
      return () => undefined
    },
    completion: () => new Promise<ChildAgentResult>(() => undefined),
  }
}

it('returns a continuable background fork handle without waiting for its answer', async () => {
  const local = backend()
  const provider = inProcessChildAgentProvider(() => local)
  const signal = new AbortController().signal
  const handle = await provider.start('task', { signal, sessionKey: 's', cwd: '/tmp', fork: true })
  await expect(handle.sendMessage('more', signal)).resolves.toEqual({ messageId: 'm1' })
  expect(handle.capabilities.continuable).toBe(true)
  expect(local.messages).toEqual(['more'])
  expect(local.forked).toBe(0)
  expect(local.resident).toBe(1)
  await handle.dispose()
  await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
})

it('continues a resident child and honors the session allowlist', async () => {
  const local = backend()
  const provider = inProcessChildAgentProvider(() => local)
  const signal = new AbortController().signal
  const handle = await provider.start('task', { signal, sessionKey: 's', cwd: '/tmp' })
  await expect(handle.sendMessage('more', signal)).resolves.toEqual({ messageId: 'm1' })
  await expect(handle.interrupt()).resolves.toEqual({ accepted: true })
  expect(local.messages).toEqual(['more'])
  expect(await provider.list?.('s')).toEqual([
    { id: 'c1', providerId: 'in-process', status: 'idle', continuable: true },
  ])
  setChildAgentAllowlist('s', { models: ['fast'], providers: ['in-process'] })
  try {
    await expect(provider.start('task', { signal, sessionKey: 's', cwd: '/tmp' })).rejects.toThrow(
      'E_MODEL_UNKNOWN',
    )
    setChildAgentAllowlist('s', { providers: [] })
    await expect(
      provider.start('named', { signal, sessionKey: 's', cwd: '/tmp', model: 'fast' }),
    ).rejects.toThrow('E_UNSUPPORTED')
    assertChildAgentAllowed('other', { providerId: 'in-process' })
  } finally {
    resetChildAgentAllowlists()
    await handle.dispose()
  }
})

it('tracks an external child until it is released', () => {
  const untrack = trackExternalChild('s', {
    listing: { id: 'ext', providerId: 'acp', status: 'idle', continuable: true },
  })
  expect(externalChildren('s').map((child) => child.listing.id)).toEqual(['ext'])
  untrack()
  expect(externalChildren('s')).toEqual([])
})

it.each([false, true])('keeps a real background child open for another turn (fork=%s)', async (fork) => {
  const { k, parent } = await setupWith(scripted(['first answer', 'second answer']), Kernel.create)
  const provider = inProcessChildAgentProvider()
  const handle = await provider.start('task', {
    sessionKey: parent.key,
    cwd: '/w',
    signal: new AbortController().signal,
    fork,
    toolFilter: { deny: ['shell'] },
  })
  try {
    await expect
      .poll(async () => (await provider.list?.(parent.key))?.find((child) => child.id === handle.id)?.status)
      .toBe('idle')
    expect(k.get(handle.id)).toBeDefined()
    await handle.sendMessage('follow up', new AbortController().signal)
    await expect
      .poll(async () => (await k.get(handle.id)?.scan({ type: 'assistant/message', limit: 2 }))?.length)
      .toBe(2)
    await expect
      .poll(async () => (await provider.list?.(parent.key))?.find((child) => child.id === handle.id)?.status)
      .toBe('idle')
    await handle.dispose()
    expect(k.get(handle.id)).toBeUndefined()
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
  } finally {
    await handle.dispose()
    await k.close()
  }
})

it('filters exact tool names in live disclosure and execution lookup', () => {
  const tools = new ToolRegistry()
  const fakeTool = (name: string) =>
    defineTool({
      name,
      description: name,
      parameters: Type.Object({}),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        requiresApproval: 'never',
        costHint: undefined,
        deferLoading: false,
      },
      execute: async () => ({ content: [] }),
    })
  tools.add(fakeTool('read'), { source: 'test', trust: 'builtin' })
  const filtered = new ChildToolRegistry(tools, { allow: ['read', 'shell'], deny: ['shell'] })
  tools.add(fakeTool('shell'), { source: 'test', trust: 'builtin' })
  expect(filtered.list().map((tool) => tool.name)).toEqual(['read'])
  expect(filtered.snapshot(1).byName.has('shell')).toBe(false)
  expect(filtered.resolve('shell')).toBeUndefined()
  expect(filtered.resolve('read')?.name).toBe('read')
})

it('drains a running resident on disposal without treating cancellation as cleanup failure', async () => {
  const { k, parent } = await setupWith(hangingProvider(), Kernel.create)
  const provider = inProcessChildAgentProvider()
  const handle = await provider.start('task', {
    sessionKey: parent.key,
    cwd: '/w',
    signal: new AbortController().signal,
  })
  try {
    await expect.poll(() => k.get(handle.id)?.state.openTurn.size).toBe(1)
    await handle.dispose()
    expect(k.get(handle.id)).toBeUndefined()
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
  } finally {
    await handle.dispose()
    await k.close()
  }
})

it('joins deferred startup when disposed before the first turn', async () => {
  const { k, parent } = await setupWith(scripted(['answer']), Kernel.create)
  const provider = inProcessChildAgentProvider()
  const handle = await provider.start('task', {
    sessionKey: parent.key,
    cwd: '/w',
    signal: new AbortController().signal,
  })
  try {
    await handle.dispose()
    expect(k.get(handle.id)).toBeUndefined()
    await expect(handle.result()).resolves.toMatchObject({ status: 'cancelled' })
  } finally {
    await k.close()
  }
})

it('disposes resident descendants with their owning parent', async () => {
  const { k, parent } = await setupWith(scripted(['answer']), (options) =>
    Kernel.create({ ...options, preset: { ...options.preset, generationLimit: 2 } } as Parameters<
      typeof Kernel.create
    >[0]),
  )
  const provider = inProcessChildAgentProvider()
  const signal = new AbortController().signal
  const child = await provider.start('child', { sessionKey: parent.key, cwd: '/w', signal })
  await expect
    .poll(async () => (await provider.list?.(parent.key))?.find((row) => row.id === child.id)?.status)
    .toBe('idle')
  const grandchild = await provider.start('grandchild', { sessionKey: child.id, cwd: '/w', signal })
  try {
    await expect
      .poll(async () => (await provider.list?.(child.id))?.find((row) => row.id === grandchild.id)?.status)
      .toBe('idle')
    await child.dispose()
    expect(k.get(grandchild.id)).toBeUndefined()
    await expect(grandchild.result()).resolves.toMatchObject({ status: 'cancelled' })
  } finally {
    await grandchild.dispose()
    await child.dispose()
    await k.close()
  }
})
