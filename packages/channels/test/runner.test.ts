import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope, HarnessMeta } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { MessageEvent, MessageRef } from '../src/adapter.js'
import type { RunnerConfig } from '../src/runner/config.js'
import { startHealthz } from '../src/runner/health.js'
import { RefStore } from '../src/runner/ref-store.js'
import { createRunner, type RunnerDeps } from '../src/runner/runner.js'
import { createFakeClient, FAKE_MANIFEST, FakeChannel } from '../testkit/index.js'

const config: RunnerConfig = {
  channel: 'fake',
  connect: { kind: 'unix', path: '/tmp/agnes.sock' },
  tenant: 'tenant',
  agent: 'agent',
  credentialsFile: '/dev/null',
  allowFrom: [],
  requireMention: true,
  ackReaction: 'group-mentions',
  workspace: '/workspace',
  outbound: { costLine: true },
  directory: { sync: false },
  healthz: { enabled: false, port: 9877 },
}

const inboundMessage: MessageEvent = {
  kind: 'message',
  eventId: 'event-1',
  messageId: 'message-1',
  accountId: 'account',
  at: '2026-09-11T00:00:00.000Z',
  text: '@bot hello',
  attachments: [],
  chat: { id: 'chat-1', type: 'group' },
  sender: { userId: 'user-1', raw: { staffId: 'staff-1' } },
  mentions: { bot: true, replyToBot: false, quoteBot: false },
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function ledgerEvent(seq: number, type: string): EventEnvelope & { _meta: HarnessMeta } {
  return {
    seq,
    ts: '2026-09-12T00:00:00.000Z',
    id: `ledger-${seq}`,
    type,
    data: {},
    actor: { id: 'user-1', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
    _meta: {
      promptTurnId: 'turn-1',
      eventSequence: seq,
      generation: 1,
      lane: 'main',
      phase: 'event',
    },
  } as EventEnvelope & { _meta: HarnessMeta }
}

describe('createRunner', () => {
  it('accepts the current SDK Client without adding imaginary convenience APIs', () => {
    expectTypeOf<Client>().toMatchTypeOf<RunnerDeps['client']>()
  })

  it('garbage-collects stale outbound refs while the runner remains live', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agnes-runner-refs-')), 'refs.sqlite')
    let now = 100
    const seed = new RefStore(path, { clock: () => now })
    seed.put('k', 'old-node', { chatId: 'c', messageId: 'm' }, 'hash')
    seed.retireSession('k', 'k')
    seed.close()
    const runner = createRunner({
      adapter: new FakeChannel(),
      cfg: config,
      secrets: {},
      client: createFakeClient(),
      log: logger(),
      refsPath: path,
      refMaxAgeMs: 50,
      refGcIntervalMs: 5,
      now: () => now,
    })
    await runner.start()
    now = 1_000
    await new Promise((resolve) => setTimeout(resolve, 20))
    await runner.stop()

    const inspect = new RefStore(path)
    expect(inspect.get('k', 'old-node')).toBeUndefined()
    inspect.close()
  })

  it('evicts cache entries and outbound lanes with the bounded tracked-session set', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client,
      log: logger(),
      maxTrackedSessions: 2,
    })
    await runner.start()
    for (let index = 1; index <= 3; index++) {
      adapter.emit({
        ...inboundMessage,
        eventId: `event-${index}`,
        messageId: `message-${index}`,
        chat: { id: `chat-${index}`, type: 'group' },
      })
      await vi.waitFor(() => {
        expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(index)
      })
    }

    expect(runner.cache.keys()).toHaveLength(2)
    expect(runner.cache.keys()).not.toContain('agnes:tenant:agent:fake:group:chat-1')
    expect(client.calls.filter((call) => call.method === 'detach')).toHaveLength(1)
    await runner.stop()
  })

  it('bounds unique-key inbound work before slow session attach', async () => {
    const client = createFakeClient()
    const originalAttach = client.session.attach.bind(client.session)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    client.session.attach = vi.fn(async (key, options) => {
      await gate
      return originalAttach(key, options)
    })
    const adapter = new FakeChannel()
    const log = logger()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client,
      log,
      maxTrackedSessions: 2,
      inboundSettleMs: 5,
    })
    await runner.start()

    for (let index = 0; index < 20; index++) {
      adapter.emit({
        ...inboundMessage,
        eventId: `flood-event-${index}`,
        messageId: `flood-message-${index}`,
        chat: { id: `flood-chat-${index}`, type: 'group' },
      })
    }
    await vi.waitFor(() => expect(client.session.attach).toHaveBeenCalledTimes(2))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('capacity'), expect.any(Object))

    const stopping = runner.stop()
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'channel inbound drain exceeded its grace window; cancelling admitted work',
        { pending: 2 },
      ),
    )
    await stopping
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.session.attach).toHaveBeenCalledTimes(2)
    expect(runner.cache.keys()).toEqual([])
  })

  it('warns after the inbound grace window and cancels a claimed late session open', async () => {
    const client = createFakeClient()
    const originalAttach = client.session.attach.bind(client.session)
    const lateSession = await originalAttach('agnes:tenant:agent:fake:group:chat-1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    client.session.attach = vi.fn(async () => {
      await gate
      return lateSession
    })
    const adapter = new FakeChannel()
    const log = logger()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client,
      log,
      inboundSettleMs: 5,
    })
    await runner.start()
    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(client.session.attach).toHaveBeenCalledOnce())
    const stopping = runner.stop()
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'channel inbound drain exceeded its grace window; cancelling admitted work',
        { pending: 1 },
      ),
    )
    await stopping
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runner.cache.keys()).toEqual([])
    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(0)
    expect(adapter.sent).toHaveLength(0)
  })

  it('drains a fresh claim through one durable dispatch before tearing down its cache', async () => {
    const client = createFakeClient()
    let resolveClaim!: (fresh: boolean) => void
    client.claim.once = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveClaim = resolve
        }),
    )
    const adapter = new FakeChannel()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client,
      log: logger(),
      inboundSettleMs: 500,
    })
    await runner.start()
    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(client.claim.once).toHaveBeenCalledOnce())

    let stopped = false
    const stopping = runner.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stopped).toBe(false)
    resolveClaim(true)
    await stopping

    expect(client.calls.filter((call) => call.method === 'followUp')).toHaveLength(1)
    expect(client.calls.at(-1)?.method).toBe('close')
  })

  it('initializes, checks APIs, connects, and pumps events into stable sessions', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })

    await runner.start()
    expect(client.calls.slice(0, 2).map((call) => call.method)).toEqual(['initialize', 'apis'])
    expect(adapter.connected).toBe(true)

    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(client.calls.some((call) => call.method === 'followUp')).toBe(true))
    expect(runner.status()).toMatchObject({
      channel: 'connected',
      daemon: 'connected',
      sessions: 1,
    })
    expect(runner.status().lastEventAt).toEqual(expect.any(String))
    expect(runner.directorySupported).toBe(true)

    client.emit('connectionStateChanged', 'reconnecting')
    expect(runner.status().daemon).toBe('reconnecting')
    client.emit('connectionStateChanged', 'connected')
    expect(runner.status().daemon).toBe('connected')
    client.emit('connectionStateChanged', 'closed')
    expect(runner.status().daemon).toBe('closed')

    await runner.stop()
    expect(adapter.connected).toBe(false)
    expect(client.calls.at(-1)?.method).toBe('close')
    expect(runner.status()).toMatchObject({ channel: 'stopped', daemon: 'closed' })
  })

  it('serves live readiness during startup and releases the health port on stop', async () => {
    const reservation = await startHealthz(
      {
        status: () => ({ channel: 'stopped', daemon: 'closed', sessions: 0, degraded: [] }),
      },
      0,
    )
    const port = reservation.port
    await reservation.close()

    const client = createFakeClient()
    const initialize = client.initialize.bind(client)
    let releaseInitialize!: () => void
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve
    })
    client.initialize = vi.fn(async () => {
      await initializeGate
      return initialize()
    })
    const adapter = new FakeChannel()
    const runner = createRunner({
      adapter,
      cfg: { ...config, healthz: { enabled: true, port } },
      secrets: {},
      client,
      log: logger(),
    })

    const starting = runner.start()
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ channel: 'stopped', daemon: 'connecting' })
    })
    releaseInitialize()
    await starting
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)

    adapter.emit(inboundMessage)
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(await response.json()).toMatchObject({ sessions: 1, lastEventAt: expect.any(String) })
    })

    await runner.stop()
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
    const replacement = await startHealthz({ status: runner.status }, port)
    await replacement.close()
  })

  it('fails runner startup cleanly when the configured health port is occupied', async () => {
    const owner = await startHealthz(
      {
        status: () => ({ channel: 'connected', daemon: 'connected', sessions: 0, degraded: [] }),
      },
      0,
    )
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({
      adapter,
      cfg: { ...config, healthz: { enabled: true, port: owner.port } },
      secrets: {},
      client,
      log: logger(),
    })
    try {
      await expect(runner.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(client.calls.some((call) => call.method === 'initialize')).toBe(false)
      expect(client.calls.at(-1)?.method).toBe('close')
      expect(adapter.connected).toBe(false)
      expect(runner.status()).toMatchObject({ channel: 'stopped', daemon: 'closed' })
    } finally {
      await owner.close()
    }
  })

  it('routes daemon notices to their session chat and broadcasts maintenance without job noise', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    await runner.start()

    adapter.emit(inboundMessage)
    adapter.emit({
      ...inboundMessage,
      eventId: 'event-2',
      messageId: 'message-2',
      chat: { id: 'chat-2', type: 'group' },
    })
    await vi.waitFor(() => expect(runner.cache.keys()).toHaveLength(2))

    client.emitNotice({
      kind: 'resumed',
      sessionId: 'agnes:tenant:agent:fake:group:chat-1',
      detail: { lastStep: 7 },
      at: '2026-09-12T00:00:00.000Z',
    })
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
    expect(adapter.sent[0]).toMatchObject({
      target: { chatId: 'chat-1' },
      msg: { blocks: [{ kind: 'text', markdown: '上次停在第 7 步，已续跑' }] },
    })

    client.emitNotice({
      kind: 'job_dispatched',
      detail: {},
      at: '2026-09-12T00:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(adapter.sent).toHaveLength(1)

    client.emitNotice({
      kind: 'shutting_down',
      detail: {},
      at: '2026-09-12T00:00:02.000Z',
    })
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(3))
    expect(
      adapter.sent
        .slice(1)
        .map(({ target }) => target.chatId)
        .sort(),
    ).toEqual(['chat-1', 'chat-2'])
    expect(adapter.sent.slice(1).map(({ msg }) => msg.blocks)).toEqual([
      [{ kind: 'text', markdown: '服务维护中，稍后自动恢复' }],
      [{ kind: 'text', markdown: '服务维护中，稍后自动恢复' }],
    ])

    await runner.stop()
  })

  it('bounds stop around an in-flight notice and waits when the adapter send can settle', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    await runner.start()
    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(runner.cache.keys()).toHaveLength(1))

    let release!: () => void
    adapter.send = vi.fn(
      () =>
        new Promise<MessageRef>((resolve) => {
          release = () => resolve({ chatId: 'chat-1', messageId: 'notice' })
        }),
    )
    client.emitNotice({
      kind: 'shutting_down',
      detail: {},
      at: '2026-09-12T01:00:00.000Z',
    })
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledOnce())

    let stopped = false
    const stopping = runner.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(adapter.connected).toBe(false)
  })

  it('rate-limits a broadcast across session targets through the outbound account bucket', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel({
      manifest: {
        ...FAKE_MANIFEST,
        limits: { ...FAKE_MANIFEST.limits, rate: { perAccountPerSec: 1 } },
      },
    })
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    await runner.start()
    for (const [index, chatId] of ['chat-1', 'chat-2'].entries()) {
      adapter.emit({
        ...inboundMessage,
        eventId: `broadcast-${index}`,
        messageId: `broadcast-${index}`,
        chat: { id: chatId, type: 'group' },
      })
    }
    await vi.waitFor(() => expect(runner.cache.keys()).toHaveLength(2))
    adapter.sent.length = 0

    client.emitNotice({
      kind: 'shutting_down',
      detail: {},
      at: '2026-09-12T02:00:00.000Z',
    })
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(adapter.sent).toHaveLength(1)
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(2), { timeout: 1_500 })
    await runner.stop()
  })

  it('removes notice targets and outbound lanes when the session cache evicts them', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    await runner.start()
    adapter.emit(inboundMessage)
    adapter.emit({
      ...inboundMessage,
      eventId: 'cache-lifecycle-2',
      messageId: 'cache-lifecycle-2',
      chat: { id: 'chat-2', type: 'group' },
    })
    await vi.waitFor(() => expect(runner.cache.keys()).toHaveLength(2))
    const removedKey = 'agnes:tenant:agent:fake:group:chat-1'
    await runner.cache.evict(removedKey)

    client.emitNotice({
      kind: 'shutting_down',
      detail: {},
      at: '2026-09-12T03:00:00.000Z',
    })
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
    expect(adapter.sent[0]?.target.chatId).toBe('chat-2')
    expect(runner.cache.keys()).not.toContain(removedKey)
    await runner.stop()
  })

  it('wires /new to an append-only replacement session for the same channel route', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    await runner.start()

    adapter.emit({ ...inboundMessage, text: '/new' })

    await vi.waitFor(() => expect(client.calls.some((call) => call.method === 'session.new')).toBe(true))
    const active = await runner.cache.get('agnes:tenant:agent:fake:group:chat-1')
    expect(active.session.id).toMatch(/^agnes:tenant:agent:fake:group:chat-1:thread:[0-9a-f-]{36}$/)
    expect(adapter.sent[0]?.msg.blocks).toEqual([{ kind: 'text', markdown: '已开始新会话' }])
    await runner.stop()
  })

  it('uses the SDK call surface for participant binding only when the daemon advertises it', async () => {
    const client = createFakeClient({
      apis: {
        families: [
          {
            name: 'session',
            methods: ['_agnes/v1/session.attach', '_agnes/v1/participant.join'],
            guidance: '',
          },
        ],
      },
    })
    const call = vi.fn(async () => ({ seq: 1 })) as unknown as Client['call']
    const clientWithCall = Object.assign(client, { call })
    const adapter = new FakeChannel()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client: clientWithCall,
      log: logger(),
    })
    await runner.start()

    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(call).toHaveBeenCalled())

    expect(call).toHaveBeenCalledWith('_agnes/v1/participant.join', {
      sessionId: 'agnes:tenant:agent:fake:group:chat-1',
      credential: expect.objectContaining({
        kind: 'channel',
        userId: 'user-1',
        raw: { staffId: 'staff-1' },
      }),
    })
    await runner.stop()
  })

  it('wires session events through projectUI and gap recovery without duplicate sends', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    const key = 'agnes:tenant:agent:fake:group:chat-1'
    await runner.start()

    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(client.calls.some((call) => call.method === 'followUp')).toBe(true))
    client.setTimeline(key, {
      sessionId: key,
      upto: 2,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [{ kind: 'assistant', id: 'assistant-1', seq: 2, text: 'done' }],
    })
    client.pushEvent(key, ledgerEvent(2, 'assistant/message'))
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))

    const before = client.calls.filter((call) => call.method === 'projectUI').length
    client.emit('gap', { sessionId: key, earliestSeq: 1 })
    await vi.waitFor(() => {
      expect(client.calls.filter((call) => call.method === 'projectUI').length).toBeGreaterThan(before)
    })
    expect(adapter.sent).toHaveLength(1)
    await runner.stop()
  })

  it('records capability degradation in status without writing it to the session', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel({ caps: { card: false } })
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })
    const key = 'agnes:tenant:agent:fake:group:chat-1'
    await runner.start()

    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(client.calls.some((call) => call.method === 'followUp')).toBe(true))
    client.setTimeline(key, {
      sessionId: key,
      upto: 2,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [
        {
          kind: 'slot',
          id: 'notification-1',
          seq: 2,
          fill: {
            slot: 'notification',
            extId: 'reports',
            payload: { title: '日报', body: '完成' },
          },
        },
      ],
    })
    client.pushEvent(key, ledgerEvent(2, 'ext/ui'))
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))

    expect(runner.status().degraded).toEqual([`${key}:card`])
    expect(client.calls.some((call) => call.method === 'steer')).toBe(false)
    await runner.stop()
  })

  it('fails closed and cleans up when the required attach API is absent', async () => {
    const client = createFakeClient({
      apis: { families: [{ name: 'other', methods: [], guidance: '' }] },
    })
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log: logger() })

    await expect(runner.start()).rejects.toMatchObject({ code: 'E_CAPABILITY_MISSING' })
    expect(adapter.connected).toBe(false)
    expect(client.calls.at(-1)?.method).toBe('close')
    expect(runner.status()).toMatchObject({ channel: 'stopped', daemon: 'closed' })
  })

  it('tries channel connect three times serially and never logs the backend error payload', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    let attempts = 0
    let active = 0
    let maxActive = 0
    adapter.connect = vi.fn(async () => {
      attempts++
      active++
      maxActive = Math.max(maxActive, active)
      active--
      throw new Error('app-secret from backend')
    })
    const log = logger()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: { clientSecret: 'app-secret' },
      client,
      log,
      backoff: { baseMs: 1, maxMs: 2, jitter: () => 0.5 },
    })

    await expect(runner.start()).rejects.toMatchObject({ code: 'E_CONNECT_FAILED' })
    expect(attempts).toBe(3)
    expect(maxActive).toBe(1)
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('app-secret')
    expect(client.calls.at(-1)?.method).toBe('close')
  })

  it('cancels a retry delay promptly when stopped and never reconnects afterward', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    let attempts = 0
    adapter.connect = vi.fn(async () => {
      attempts++
      throw new Error('offline')
    })
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client,
      log: logger(),
      backoff: { baseMs: 10_000, maxMs: 10_000, jitter: () => 0.5 },
    })
    const started = runner.start()
    await vi.waitFor(() => expect(attempts).toBe(1))

    await runner.stop()
    await expect(started).rejects.toMatchObject({ code: 'E_CONNECT_FAILED' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(attempts).toBe(1)
    expect(runner.status()).toMatchObject({ channel: 'stopped', daemon: 'closed' })
  })
})
