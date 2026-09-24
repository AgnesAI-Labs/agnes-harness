import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { MessageRef } from '../src/adapter.js'
import { loadConfig, type RunnerConfig } from '../src/runner/config.js'
import { createRunner } from '../src/runner/runner.js'
import { installShutdown } from '../src/runner/shutdown.js'
import { createFakeClient, FakeChannel } from '../testkit/index.js'

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

const inboundMessage = {
  kind: 'message' as const,
  eventId: 'event-1',
  messageId: 'message-1',
  accountId: 'account',
  at: '2026-09-12T00:00:00.000Z',
  text: '@bot hello',
  attachments: [],
  chat: { id: 'chat-1', type: 'group' as const },
  sender: { userId: 'user-1', raw: { staffId: 'staff-1' } },
  mentions: { bot: true, replyToBot: false, quoteBot: false },
}

const log = { info() {}, warn() {}, error() {} }

describe('installShutdown', () => {
  it('stops intake, drains, and exits zero once', async () => {
    const calls: string[] = []
    const exits: number[] = []
    const signals = new EventEmitter()
    const shutdown = installShutdown(
      {
        stopIntake() {
          calls.push('intake')
        },
        async stop(options) {
          calls.push(`stop:${options?.drainMs}`)
        },
      },
      { drainMs: 50, exit: (code) => exits.push(code), signalSource: signals },
    )

    signals.emit('SIGTERM')
    await vi.waitFor(() => expect(exits).toEqual([0]))
    signals.emit('SIGINT')

    expect(calls).toEqual(['intake', 'stop:50'])
    expect(exits).toEqual([0])
    shutdown.dispose()
    expect(signals.listenerCount('SIGTERM')).toBe(0)
    expect(signals.listenerCount('SIGINT')).toBe(0)
  })

  it('exits 130 immediately on a second signal and suppresses the late zero exit', async () => {
    const calls: string[] = []
    const exits: number[] = []
    let resolveStop!: () => void
    const shutdown = installShutdown(
      {
        stopIntake() {
          calls.push('intake')
        },
        stop() {
          calls.push('stop')
          return new Promise<void>((resolve) => {
            resolveStop = resolve
          })
        },
      },
      { drainMs: 5_000, exit: (code) => exits.push(code), signals: [] },
    )

    shutdown.trigger('SIGTERM')
    await vi.waitFor(() => expect(calls).toEqual(['intake', 'stop']))
    shutdown.trigger('SIGTERM')
    expect(exits).toEqual([130])
    resolveStop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(exits).toEqual([130])
    shutdown.dispose()
  })

  it('bounds a stuck runner and clears its timer', async () => {
    vi.useFakeTimers()
    try {
      const exits: number[] = []
      const shutdown = installShutdown(
        { stopIntake() {}, stop: () => new Promise<void>(() => undefined) },
        { drainMs: 10, exit: (code) => exits.push(code), signals: [] },
      )

      shutdown.trigger('SIGINT')
      await vi.advanceTimersByTimeAsync(10)
      expect(exits).toEqual([0])
      expect(vi.getTimerCount()).toBe(0)
      shutdown.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runner shutdown drain', () => {
  it('rejects new intake but flushes work admitted before shutdown', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log })
    await runner.start()
    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(runner.cache.keys()).toHaveLength(1))
    const key = runner.cache.keys()[0] as string
    client.setTimeline(key, {
      sessionId: key,
      upto: 1,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [{ kind: 'assistant', id: 'answer', seq: 1, text: 'accepted answer' }],
    })

    runner.stopIntake()
    adapter.emit({ ...inboundMessage, eventId: 'late', messageId: 'late' })
    await runner.stop({ drainMs: 100 })

    expect(client.calls.filter(({ method }) => method === 'followUp')).toHaveLength(1)
    expect(adapter.sent.map(({ msg }) => msg.blocks)).toContainEqual([
      { kind: 'text', markdown: 'accepted answer' },
    ])
    expect(adapter.connected).toBe(false)
    expect(client.calls.at(-1)?.method).toBe('close')
  })

  it('disconnects and closes after a bounded outbound drain', async () => {
    const client = createFakeClient()
    const adapter = new FakeChannel()
    const runner = createRunner({ adapter, cfg: config, secrets: {}, client, log })
    await runner.start()
    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(runner.cache.keys()).toHaveLength(1))
    const key = runner.cache.keys()[0] as string
    client.setTimeline(key, {
      sessionId: key,
      upto: 1,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [{ kind: 'assistant', id: 'blocked', seq: 1, text: 'blocked answer' }],
    })
    adapter.send = vi.fn(() => new Promise<MessageRef>(() => undefined))

    const started = performance.now()
    await runner.stop({ drainMs: 40 })

    expect(performance.now() - started).toBeLessThan(150)
    expect(adapter.connected).toBe(false)
    expect(client.calls.at(-1)?.method).toBe('close')
  })

  it('does not let stuck admitted inbound consume the close attempts or exceed the deadline', async () => {
    const client = createFakeClient()
    client.claim.once = vi.fn(() => new Promise<boolean>(() => undefined))
    const adapter = new FakeChannel()
    const runner = createRunner({
      adapter,
      cfg: config,
      secrets: {},
      client,
      log,
      inboundSettleMs: 1_000,
    })
    await runner.start()
    adapter.emit(inboundMessage)
    await vi.waitFor(() => expect(client.claim.once).toHaveBeenCalledOnce())

    const started = performance.now()
    await runner.stop({ drainMs: 40 })

    expect(performance.now() - started).toBeLessThan(150)
    expect(adapter.connected).toBe(false)
    expect(client.calls.at(-1)?.method).toBe('close')
  })
})

describe('deployment samples', () => {
  it('ships a hardened service whose state and workspace paths are writable', () => {
    const service = readFileSync(new URL('../deploy/agnes-channel@.service', import.meta.url), 'utf8')
    expect(service).toContain('KillSignal=SIGTERM')
    expect(service).toContain('TimeoutStopSec=10')
    expect(service).toContain('NoNewPrivileges=true')
    expect(service).toContain('ProtectSystem=strict')
    expect(service).toContain('StateDirectory=agnes/channels agnes/workspaces')
    expect(service).toContain('ReadWritePaths=/var/lib/agnes/channels /var/lib/agnes/workspaces')
    expect(service).toContain('AGNES_CHANNEL_STATE_DIR=/var/lib/agnes/channels')
    expect(service).toContain('--config /etc/agnes/channels/%i.yaml')
  })

  it('ships a schema-valid example without inline credentials and documents secure ownership', async () => {
    const examplePath = new URL('../deploy/dingtalk.example.yaml', import.meta.url)
    const text = readFileSync(examplePath, 'utf8')
    const parsed = await loadConfig(fileURLToPath(examplePath))

    expect(parsed).toMatchObject({
      channel: 'dingtalk',
      connect: { kind: 'unix', path: '/var/lib/agnes/daemon/agnesd.sock' },
      workspace: '/var/lib/agnes/workspaces/example-tenant',
      healthz: { enabled: true, port: 9877 },
    })
    expect(text).toMatch(/0600.*owned by the service user/i)
    expect(text).not.toMatch(/clientSecret\s*:/i)
    expect(text).not.toMatch(/clientId\s*:/i)
  })
})
