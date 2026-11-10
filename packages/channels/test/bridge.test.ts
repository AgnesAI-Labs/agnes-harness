import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelInstance, ChannelProvider, ProfileManagedInit } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { channelBindingSnapshot, startChannelBridge } from '../src/bridge.js'
import { createFakeClient, FAKE_MANIFEST, FakeChannel } from '../testkit/index.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agh-channel-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const abort = new AbortController()
  const stored = new Map<string, import('@agnes/protocol').JsonValue>()
  let shutdown: Parameters<ProfileManagedInit['onShutdown']>[0] | undefined
  const init = {
    store: {
      scan: ({ prefix, limit, cursor }: { prefix: string; limit: number; cursor?: string }) => {
        const rows = [...stored]
          .filter(([key]) => key.startsWith(prefix) && (!cursor || key > cursor))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => ({ key, value }))
        return {
          rows: rows.slice(0, limit),
          ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.key } : {}),
        }
      },
      delete: (key: string) => stored.delete(key),
      transaction: <T>(work: () => T) => work(),
      get: (key: string) => stored.get(key),
      set: (key: string, value: import('@agnes/protocol').JsonValue) =>
        stored.set(key, structuredClone(value)),
    },
    signal: abort.signal,
    config: { instances: [] },
    assertCurrent: vi.fn(),
    ready: vi.fn(),
    onShutdown: (fn: typeof shutdown) => {
      shutdown = fn
    },
  } as unknown as ProfileManagedInit
  const adapters: FakeChannel[] = [],
    clients: ReturnType<typeof createFakeClient>[] = []
  const provider: ChannelProvider = {
    id: 'fake',
    version: '1.0.0',
    manifest: FAKE_MANIFEST,
    create() {
      const a = new FakeChannel()
      adapters.push(a)
      return a
    },
  }
  const options = {
    owner: 'plugin/example',
    stateDirectory: join(root, 'state'),
    resolveSecret: vi.fn(() => 'synthetic-secret'),
    createClient: vi.fn((_config: import('../src/runner/config.js').RunnerConfig) => {
      const client = createFakeClient()
      clients.push(client)
      return client
    }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  const instance: ChannelInstance = {
    id: 'first',
    workspace: root,
    agent: '@example/agent#main',
    credentialRefs: {},
    allowFrom: [],
    requireMention: true,
  }
  return {
    root,
    abort,
    init,
    options,
    instance,
    provider,
    adapters,
    clients,
    stop: async () => {
      await shutdown?.('disable')
    },
  }
}

it('owns two isolated instances, reuses inbound/outbound routing and stops them on retirement', async () => {
  const f = await fixture()
  Object.assign(f.init, {
    config: { instances: [f.instance, { ...f.instance, id: 'second', agent: 'default' }] } as never,
  })
  const runtime = await startChannelBridge(f.provider, f.init, f.options)
  cleanups.push(f.stop)
  expect(f.init.ready).toHaveBeenCalled()
  expect(f.options.createClient).toHaveBeenCalledWith(
    expect.objectContaining({ launchAgent: '@example/agent#main' }),
    expect.any(String),
  )
  expect(f.options.createClient).toHaveBeenCalledWith(
    expect.objectContaining({ agent: 'default' }),
    expect.any(String),
  )
  expect(f.options.createClient.mock.calls[1]?.[0]).not.toHaveProperty('launchAgent')
  expect(runtime.status()).toMatchObject({
    provider: 'fake',
    instances: [
      { id: 'first', connection: { channel: 'connected' } },
      { id: 'second', connection: { channel: 'connected' } },
    ],
  })
  for (const adapter of f.adapters)
    adapter.emit({
      kind: 'message',
      eventId: 'same-event',
      messageId: 'message',
      accountId: 'account',
      text: '@bot hello',
      attachments: [],
      at: '2026-11-05T00:00:00Z',
      chat: { id: 'same-chat', type: 'group' },
      sender: { userId: 'user', raw: {} },
      mentions: { bot: true, replyToBot: false, quoteBot: false },
    })
  expect(
    f.clients.every(
      (c) => !c.calls.some((call) => call.method === 'session.new' || call.method === 'followUp'),
    ),
  ).toBe(true)
  const session = { id: 'web-session', workspace: f.root }
  const view = (await runtime.session!(session)) as {
    instances: { id: string; version: number; targets: { id: string }[] }[]
  }
  expect(view.instances).toHaveLength(2)
  const first = view.instances[0]!
  await expect(
    runtime.binding!(
      'bind',
      { instanceId: first.id, targetId: first.targets[0]!.id, expectedVersion: first.version - 1 },
      session,
    ),
  ).rejects.toThrow('changed')
  await expect(
    runtime.binding!(
      'bind',
      { instanceId: first.id, targetId: first.targets[0]!.id, expectedVersion: first.version },
      { id: 'foreign', workspace: join(f.root, 'state') },
    ),
  ).rejects.toThrow('workspace')
  for (const row of view.instances) {
    f.clients[view.instances.indexOf(row)]!.setTimeline(session.id, {
      sessionId: session.id,
      upto: 5,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [
        { kind: 'assistant', id: 'old', seq: 2, text: 'private-history' },
        { kind: 'user', id: 'old-user', seq: 3, content: [{ type: 'text', text: 'private-user-history' }] },
      ],
    })
    await runtime.binding!(
      'bind',
      { instanceId: row.id, targetId: row.targets[0]!.id, expectedVersion: row.version },
      session,
    )
  }
  for (const adapter of f.adapters)
    adapter.emit({
      kind: 'message',
      eventId: 'after-binding',
      messageId: 'new-message',
      text: 'new task',
      attachments: [],
      accountId: 'account',
      at: new Date().toISOString(),
      chat: { id: 'same-chat', type: 'group' },
      sender: { userId: 'user', raw: {} },
      mentions: { bot: true, replyToBot: false, quoteBot: false },
    })
  await vi.waitFor(() =>
    expect(f.clients.every((c) => c.calls.some((call) => call.method === 'followUp'))).toBe(true),
  )
  expect(f.clients.every((c) => !c.calls.some((call) => call.method === 'session.new'))).toBe(true)
  const sessions = [session.id, session.id]
  for (let index = 0; index < 2; index++)
    f.clients[index]!.setTimeline(sessions[index]!, {
      sessionId: sessions[index]!,
      upto: 8,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [
        { kind: 'assistant', id: 'old', seq: 2, text: 'private-history' },
        {
          kind: 'user',
          id: 'channel-input',
          seq: 6,
          commandId: (
            f.clients[index]!.calls.find((call) => call.method === 'followUp')!.args[1] as {
              commandId: string
            }
          ).commandId,
          content: [{ type: 'text', text: 'new task' }],
        },
        {
          kind: 'user',
          id: 'web-input',
          seq: 7,
          commandId: 'web-input',
          content: [{ type: 'text', text: 'new task' }],
        },
        { kind: 'assistant', id: 'reply', seq: 8, text: 'result' },
      ],
    })
  // Shutdown drains pending output through the same durable runner rather than a new send path.
  await f.stop()
  expect(f.adapters.every((a) => JSON.stringify(a.sent).includes('result'))).toBe(true)
  expect(f.adapters.every((a) => !JSON.stringify(a.sent).includes('private-history'))).toBe(true)
  expect(f.adapters.every((a) => !JSON.stringify(a.sent).includes('private-user-history'))).toBe(true)
  for (const adapter of f.adapters) {
    const messages = adapter.sent
      .flatMap((row) => row.msg.blocks)
      .filter((block) => block.kind === 'text')
      .map((block) => block.markdown)
    expect(messages).toContain('来自 AGH 的用户消息：\n\nnew task')
    expect(messages.filter((text) => text.includes('new task'))).toHaveLength(1)
  }
  expect(f.adapters.every((a) => !a.connected)).toBe(true)
  expect(f.clients.every((c) => c.calls.some((call) => call.method === 'close'))).toBe(true)
  const restarted = await startChannelBridge(f.provider, f.init, f.options)
  expect(f.adapters.slice(2).every((a) => a.connected)).toBe(true)
  const recovered = (await restarted.session!(session)) as {
    instances: { id: string; version: number; bindings: { state: string }[] }[]
  }
  expect(recovered.instances.every((row) => row.bindings[0]?.state === 'waiting')).toBe(true)
  await restarted.binding!(
    'unbind',
    { instanceId: 'first', expectedVersion: recovered.instances[0]!.version },
    session,
  )
  expect(await restarted.session!(session)).toMatchObject({
    instances: [
      { id: 'first', bindings: [] },
      { id: 'second', bindings: [{ state: 'waiting' }] },
    ],
  })
  expect(restarted.status()).toMatchObject({
    instances: [
      { id: 'first', bindings: [] },
      { id: 'second', bindings: [{ sessionId: session.id, state: 'waiting' }] },
    ],
  })
  await f.stop()
  Object.assign(f.init, { config: { instances: [] } })
  await startChannelBridge(f.provider, f.init, f.options)
  await f.stop()
  Object.assign(f.init, { config: { instances: [f.instance] } })
  const replaced = await startChannelBridge(f.provider, f.init, f.options)
  expect(await replaced.session!(session)).toMatchObject({ instances: [{ bindings: [], targets: [] }] })
})

it('persists an interrupted bind as paused and requires an explicit unbind to reconcile', async () => {
  const f = await fixture()
  Object.assign(f.init, { config: { instances: [f.instance] } })
  const runtime = await startChannelBridge(f.provider, f.init, f.options)
  cleanups.push(f.stop)
  f.adapters[0]!.emit({
    kind: 'message',
    eventId: 'observe',
    messageId: 'observe',
    text: 'hello',
    attachments: [],
    accountId: 'account',
    at: new Date().toISOString(),
    chat: { id: 'chat', type: 'dm' },
    sender: { userId: 'user', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  })
  const session = { id: 'missing-session', workspace: f.root }
  const view = (await runtime.session!(session)) as {
    instances: { version: number; targets: { id: string }[] }[]
  }
  f.clients[0]!.fireNotFound(session.id)
  await expect(
    runtime.binding!(
      'bind',
      {
        instanceId: 'first',
        expectedVersion: view.instances[0]!.version,
        targetId: view.instances[0]!.targets[0]!.id,
      },
      session,
    ),
  ).rejects.toBeDefined()
  await f.stop()
  const stopped = channelBindingSnapshot(
    f.provider,
    { instances: [f.instance] },
    f.init.store,
    f.options.owner,
  )
  expect(stopped).toMatchObject({
    instances: [
      { connection: null, recovery: true, bindings: [{ sessionId: session.id, state: 'pending' }] },
    ],
  })
  expect(stopped.instances[0]).not.toHaveProperty('targets')
  const recovered = await startChannelBridge(f.provider, f.init, f.options)
  const pending = (await recovered.session!(session)) as { instances: { version: number }[] }
  expect(pending).toMatchObject({ instances: [{ bindings: [{ state: 'pending' }] }] })
  await recovered.binding!(
    'unbind',
    { instanceId: 'first', expectedVersion: pending.instances[0]!.version },
    session,
  )
  expect(await recovered.session!(session)).toMatchObject({ instances: [{ bindings: [] }] })
})

it.each(['raw-secret', 'secret://other/key'])(
  'refuses undeclared or literal credentials before connecting: %s',
  async (ref) => {
    const f = await fixture()
    Object.assign(f.init, {
      config: { instances: [{ ...f.instance, credentialRefs: { unreviewed: ref } }] } as never,
    })
    await expect(startChannelBridge(f.provider, f.init, f.options)).rejects.toThrow(
      'declared secret references',
    )
    expect(f.adapters).toHaveLength(0)
    expect(f.options.resolveSecret).not.toHaveBeenCalled()
  },
)

it('resolves only declared references and refuses SDK or platform revival after abort', async () => {
  const f = await fixture()
  f.provider = {
    ...f.provider,
    manifest: {
      ...FAKE_MANIFEST,
      credentials: {
        ...FAKE_MANIFEST.credentials,
        required: ['token'],
      },
    },
    create: () => {
      const a = new FakeChannel({ manifest: f.provider.manifest })
      f.adapters.push(a)
      return a
    },
  }
  Object.assign(f.init, {
    config: { instances: [{ ...f.instance, credentialRefs: { token: 'secret://channel/token' } }] } as never,
  })
  const runtime = await startChannelBridge(f.provider, f.init, f.options)
  cleanups.push(f.stop)
  expect(f.options.resolveSecret).toHaveBeenCalledWith('secret://channel/token')
  f.abort.abort()
  await f.stop()
  expect(() => runtime.status()).toThrow()
  expect(f.adapters[0]?.connected).toBe(false)
})

it('does not confirm an uncertain platform shutdown', async () => {
  const f = await fixture()
  Object.assign(f.init, { config: { instances: [f.instance] } as never })
  await startChannelBridge(f.provider, f.init, f.options)
  f.adapters[0]!.disconnect = async () => {
    throw Error('synthetic disconnect failure')
  }
  await expect(f.stop()).rejects.toThrow('shutdown could not be confirmed')
})

it.each(['credentials', 'adapter', 'backend'] as const)(
  'reports only the fixed %s startup phase and closes failed resources',
  async (phase) => {
    const f = await fixture()
    Object.assign(f.init, {
      config: { instances: [{ ...f.instance, credentialRefs: { token: 'secret://generic/token' } }] },
    })
    f.provider = {
      ...f.provider,
      manifest: {
        ...f.provider.manifest,
        credentials: { ...f.provider.manifest.credentials, required: ['token'], optional: [] },
      },
    }
    f.provider.create = () => new FakeChannel({ manifest: f.provider.manifest })
    const fail = () => {
      throw Error('private-token-and-platform-response')
    }
    if (phase === 'credentials') f.options.resolveSecret.mockImplementation(fail)
    if (phase === 'adapter') f.provider.create = fail
    if (phase === 'backend') f.options.createClient.mockImplementation(fail)
    await expect(startChannelBridge(f.provider, f.init, f.options)).rejects.toMatchObject({
      code: `channel-${phase}`,
      message: 'Channel startup failed',
    })
    expect(f.init.ready).not.toHaveBeenCalled()
    await f.stop()
  },
)
