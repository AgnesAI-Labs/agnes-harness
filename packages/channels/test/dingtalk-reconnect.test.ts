import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelMessage, ChatTarget, ConnectOptions, MessageRef } from '../src/adapter.js'
import { FakeDingtalkGateway } from '../src/adapters/dingtalk/gateway-fake.js'
import { createDingtalkAdapter, DingtalkAdapter } from '../src/adapters/dingtalk/index.js'
import { loadManifest } from '../src/manifest.js'
import { backoffDelays } from '../src/runner/backoff.js'

const manifestPath = fileURLToPath(new URL('../src/adapters/dingtalk/channel.json', import.meta.url))
const message: ChannelMessage = { blocks: [{ kind: 'text', markdown: 'queued' }] }

class SendingAdapter extends DingtalkAdapter {
  readonly delivered: string[] = []

  protected override async sendNow(target: ChatTarget, _message: ChannelMessage): Promise<MessageRef> {
    this.delivered.push(target.chatId)
    return { chatId: target.chatId, messageId: `message-${this.delivered.length}` }
  }
}

class OrderedEpochAdapter extends DingtalkAdapter {
  readonly delivered: string[] = []
  onFirstAttempt?: () => void
  private failed = false

  protected override async sendNow(_target: ChatTarget, message: ChannelMessage): Promise<MessageRef> {
    const text = message.blocks[0]?.kind === 'text' ? message.blocks[0].markdown : ''
    if (!this.failed) {
      this.failed = true
      this.onFirstAttempt?.()
      throw new Error('old connection rejected the send')
    }
    this.delivered.push(text)
    return { chatId: _target.chatId, messageId: text }
  }
}

function options(
  controller: AbortController,
  log: ConnectOptions['log'] = { info() {}, warn() {}, error() {} },
): ConnectOptions {
  return {
    credentials: { clientId: 'app-key', clientSecret: 'app-secret' },
    signal: controller.signal,
    onEvent: () => {},
    log,
  }
}

describe('backoffDelays', () => {
  it('doubles to the cap and applies bounded deterministic jitter', () => {
    const delays = backoffDelays({ baseMs: 10, maxMs: 40, jitter: () => 0.5 })
    expect(Array.from({ length: 5 }, () => delays.next().value)).toEqual([10, 20, 40, 40, 40])
    expect(backoffDelays({ baseMs: 100, maxMs: 100, jitter: () => 0 }).next().value).toBe(80)
    expect(backoffDelays({ baseMs: 100, maxMs: 100, jitter: () => 1 }).next().value).toBe(120)
  })
})

describe('DingTalk reconnect', () => {
  it('queues outbound sends during reconnect and flushes them in order after recovery', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let starts = 0
    let releaseReconnect: (() => void) | undefined
    gateway.start = vi.fn(async (handlers, signal) => {
      starts++
      if (starts === 2) await new Promise<void>((resolve) => (releaseReconnect = resolve))
      return originalStart(handlers, signal)
    })
    const controller = new AbortController()
    const adapter = new SendingAdapter(await loadManifest(manifestPath), gateway, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
      rate: { perChatPerMin: 6_000 },
    })
    await adapter.connect(options(controller))

    gateway.emitDisconnect(new Error('offline'))
    await vi.waitFor(() => expect(releaseReconnect).toBeTypeOf('function'))
    const first = adapter.send({ chatId: 'chat-1' }, message)
    const second = adapter.send({ chatId: 'chat-1' }, message)
    await Promise.resolve()
    expect(adapter.delivered).toEqual([])

    releaseReconnect?.()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { chatId: 'chat-1' },
      { chatId: 'chat-1' },
    ])
    expect(adapter.delivered).toEqual(['chat-1', 'chat-1'])
    await adapter.disconnect()
  })

  it('requeues an in-flight send when its connection epoch is lost', async () => {
    const gateway = new FakeDingtalkGateway()
    const controller = new AbortController()
    const adapter = new SendingAdapter(await loadManifest(manifestPath), gateway, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
      rate: { perChatPerMin: 6_000 },
    })
    let attempts = 0
    adapter.delivered.push = ((...items: string[]): number => {
      attempts++
      if (attempts === 1) {
        gateway.emitDisconnect(new Error('connection lost while sending'))
        throw new Error('old connection rejected the send')
      }
      return Array.prototype.push.apply(adapter.delivered, items) as number
    }) as typeof adapter.delivered.push
    await adapter.connect(options(controller))

    await expect(adapter.send({ chatId: 'chat-1' }, message)).resolves.toMatchObject({
      chatId: 'chat-1',
    })
    expect(attempts).toBe(2)
    expect([...adapter.delivered]).toEqual(['chat-1'])
    await adapter.disconnect()
  })

  it('preserves per-chat order when concurrent sends cross a lost connection epoch', async () => {
    const gateway = new FakeDingtalkGateway()
    const controller = new AbortController()
    const adapter = new OrderedEpochAdapter(await loadManifest(manifestPath), gateway, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
      rate: { perChatPerMin: 6_000, perAccountPerSec: 1_000 },
    })
    adapter.onFirstAttempt = () => gateway.emitDisconnect(new Error('old epoch lost'))
    await adapter.connect(options(controller))

    const first = adapter.send({ chatId: 'chat-1' }, { blocks: [{ kind: 'text', markdown: 'first' }] })
    const second = adapter.send({ chatId: 'chat-1' }, { blocks: [{ kind: 'text', markdown: 'second' }] })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(adapter.delivered).toEqual(['first', 'second'])
    await adapter.disconnect()
  })

  it('bounds the reconnect queue at 100 and rejects parked sends on shutdown', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let starts = 0
    gateway.start = vi.fn(async (handlers, signal) => {
      starts++
      if (starts > 1) return new Promise<{ botUserId: string }>(() => undefined)
      return originalStart(handlers, signal)
    })
    const controller = new AbortController()
    const adapter = new SendingAdapter(await loadManifest(manifestPath), gateway, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
      rate: { perChatPerMin: 6_000 },
    })
    await adapter.connect(options(controller))
    gateway.emitDisconnect(new Error('offline'))
    await vi.waitFor(() => expect(starts).toBe(2))

    const parked = Array.from({ length: 100 }, () => adapter.send({ chatId: 'chat-1' }, message))
    await expect(adapter.send({ chatId: 'chat-1' }, message)).rejects.toMatchObject({
      code: 'E_CONNECT_FAILED',
    })
    const settled = Promise.allSettled(parked)
    await adapter.disconnect()
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true)
  })

  it('rate-limits each chat independently through the public send path', async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeDingtalkGateway()
      const adapter = new SendingAdapter(await loadManifest(manifestPath), gateway, {
        gateway,
        rate: { perChatPerMin: 60 },
      })

      const firstChat = Array.from({ length: 6 }, () => adapter.send({ chatId: 'chat-1' }, message))
      const secondChat = adapter.send({ chatId: 'chat-2' }, message)
      await vi.advanceTimersByTimeAsync(0)
      expect(adapter.delivered.filter((chatId) => chatId === 'chat-1')).toHaveLength(5)
      await expect(secondChat).resolves.toMatchObject({ chatId: 'chat-2' })

      await vi.advanceTimersByTimeAsync(999)
      expect(adapter.delivered.filter((chatId) => chatId === 'chat-1')).toHaveLength(5)
      await vi.advanceTimersByTimeAsync(1)
      await expect(Promise.all(firstChat)).resolves.toHaveLength(6)
      expect(adapter.delivered.filter((chatId) => chatId === 'chat-1')).toHaveLength(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts sends waiting for a rate token and bounds per-chat limiter state on disconnect', async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeDingtalkGateway()
      const adapter = new SendingAdapter(await loadManifest(manifestPath), gateway, {
        gateway,
        rate: { perChatPerMin: 60, perAccountPerSec: 100_000 },
      })
      const controller = new AbortController()
      await adapter.connect(options(controller))
      const sends = Array.from({ length: 6 }, () => adapter.send({ chatId: 'chat-1' }, message))
      await vi.advanceTimersByTimeAsync(0)
      await adapter.disconnect()
      await expect(Promise.all(sends)).rejects.toMatchObject({ code: 'E_CONNECT_FAILED' })

      const fresh = new SendingAdapter(await loadManifest(manifestPath), gateway, {
        gateway,
        rate: { perChatPerMin: 60_000, perAccountPerSec: 100_000 },
      })
      for (let index = 0; index < 1_100; index++) {
        await fresh.send({ chatId: `chat-${index}` }, message)
      }
      expect((fresh as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(1_024)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh gateway epoch after disconnect and resumes inbound delivery', async () => {
    const gateway = new FakeDingtalkGateway()
    const start = vi.spyOn(gateway, 'start')
    const events: string[] = []
    const controller = new AbortController()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
    })
    await adapter.connect({
      ...options(controller),
      onEvent: (event) => events.push(event.eventId),
    })

    gateway.emitDisconnect(new Error('socket closed with app-secret'))
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(gateway.started).toBe(true)
    gateway.emitMessage({
      msgId: 'after-reconnect',
      conversationId: 'conversation-1',
      conversationType: '2',
      senderStaffId: 'staff-1',
      msgtype: 'text',
      text: { content: 'hello' },
      createAt: 1_700_000_000_000,
    })
    await vi.waitFor(() => expect(events).toEqual(['after-reconnect']))
    await adapter.disconnect()
  })

  it('retries failed starts serially and never logs the backend error payload', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let calls = 0
    let active = 0
    let maxActive = 0
    gateway.start = vi.fn(async (handlers, signal) => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (calls === 2 || calls === 3) throw new Error('app-secret from backend')
        return await originalStart(handlers, signal)
      } finally {
        active--
      }
    })
    const warn = vi.fn()
    const info = vi.fn()
    const controller = new AbortController()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
    })
    await adapter.connect(options(controller, { info, warn, error() {} }))

    gateway.emitDisconnect(new Error('app-secret from disconnect'))
    await vi.waitFor(() => expect(calls).toBe(4))

    expect(maxActive).toBe(1)
    expect(info).toHaveBeenCalledWith('Dingtalk stream reconnected', { attempt: 3 })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('app-secret')
    await adapter.disconnect()
  })

  it('coalesces repeated disconnect callbacks into one reconnect loop', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let releaseReconnect: (() => void) | undefined
    let calls = 0
    gateway.start = vi.fn(async (handlers, signal) => {
      calls++
      if (calls === 2) await new Promise<void>((resolve) => (releaseReconnect = resolve))
      return originalStart(handlers, signal)
    })
    const controller = new AbortController()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 1, maxMs: 2 },
    })
    await adapter.connect(options(controller))

    gateway.emitDisconnect(new Error('first'))
    await vi.waitFor(() => expect(releaseReconnect).toBeTypeOf('function'))
    gateway.emitDisconnect(new Error('second'))
    releaseReconnect?.()
    await vi.waitFor(() => expect(gateway.started).toBe(true))

    expect(calls).toBeLessThanOrEqual(3)
    await adapter.disconnect()
  })

  it('stops a failing retry loop promptly when the external signal aborts', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let calls = 0
    gateway.start = vi.fn(async (handlers, signal) => {
      calls++
      if (calls > 1) throw new Error('offline')
      return originalStart(handlers, signal)
    })
    const controller = new AbortController()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 5, maxMs: 10 },
    })
    await adapter.connect(options(controller))
    gateway.emitDisconnect(new Error('offline'))
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))

    controller.abort()
    const stoppedAt = calls
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(calls).toBe(stoppedAt)
    expect(gateway.started).toBe(false)
  })

  it('stops retrying after explicit disconnect even when the caller signal remains live', async () => {
    const gateway = new FakeDingtalkGateway()
    const originalStart = gateway.start.bind(gateway)
    let calls = 0
    gateway.start = vi.fn(async (handlers, signal) => {
      calls++
      if (calls > 1) throw new Error('offline')
      return originalStart(handlers, signal)
    })
    const controller = new AbortController()
    const adapter = await createDingtalkAdapter(manifestPath, {
      gateway,
      backoff: { baseMs: 5, maxMs: 10 },
    })
    await adapter.connect(options(controller))
    gateway.emitDisconnect(new Error('offline'))
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))

    await adapter.disconnect()
    const stoppedAt = calls
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(calls).toBe(stoppedAt)
  })
})
