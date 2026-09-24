import type { ChannelCapabilities, EventEnvelope, HarnessMeta, UITimeline } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { MessageRef } from '../src/adapter.js'
import { Outbound } from '../src/runner/outbound.js'
import { RefStore } from '../src/runner/ref-store.js'
import { SessionCache } from '../src/runner/session-cache.js'
import { chunkText } from '../src/runner/throttle.js'
import { createFakeClient, FAKE_MANIFEST, FakeChannel } from '../testkit/index.js'

const log = { info() {}, warn() {}, error() {} }
const meta: HarnessMeta = {
  promptTurnId: '1',
  eventSequence: 1,
  generation: 1,
  lane: 'main',
  phase: 'event',
}

function event(seq: number, type: string, data: unknown = {}): EventEnvelope & { _meta: HarnessMeta } {
  return {
    seq,
    ts: '2026-09-12T00:00:00.000Z',
    id: `event-${seq}`,
    type,
    data,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
    _meta: { ...meta, eventSequence: seq },
  } as EventEnvelope & { _meta: HarnessMeta }
}

function timeline(nodes: UITimeline['nodes'], upto = 1, generation = 1): UITimeline {
  return { sessionId: 'k', upto, generation, opState: null, nodes, turns: [] }
}

async function setup(
  options: {
    caps?: Partial<ChannelCapabilities>
    textChars?: number
    debounceMs?: number
    stopSettleMs?: number
    sessionPerSec?: number
    maxDetachedWork?: number
    noticeRetry?: { attempts?: number; baseMs?: number; maxMs?: number; jitter?: () => number }
  } = {},
) {
  const client = createFakeClient()
  const manifest = {
    ...FAKE_MANIFEST,
    limits: { ...FAKE_MANIFEST.limits, textChars: options.textChars ?? FAKE_MANIFEST.limits.textChars },
  }
  const adapter = new FakeChannel({
    manifest,
    ...(options.caps === undefined ? {} : { caps: options.caps }),
  })
  const cache = new SessionCache(client, { cwd: '/workspace', preset: 'channel' })
  const { session } = await cache.get('k')
  const refs = new RefStore(':memory:')
  const outbound = new Outbound({
    adapter,
    refs,
    cache,
    cfg: { outbound: { costLine: true } },
    caps: adapter.capabilities(),
    limits: manifest.limits,
    log,
    debounceMs: options.debounceMs ?? 5,
    rates: {
      sessionPerSec: options.sessionPerSec ?? 10_000,
    },
    ...(options.stopSettleMs === undefined ? {} : { stopSettleMs: options.stopSettleMs }),
    ...(options.maxDetachedWork === undefined ? {} : { maxDetachedWork: options.maxDetachedWork }),
    ...(options.noticeRetry === undefined ? {} : { noticeRetry: options.noticeRetry }),
  })
  outbound.attach('k', session, { chatId: 'chat-1' })
  return { adapter, cache, client, outbound, refs, session }
}

describe('Outbound', () => {
  it('retries a failed notice in its lane with one stable delivery identity', async () => {
    const { adapter, outbound } = await setup({
      noticeRetry: { attempts: 3, baseMs: 1, maxMs: 1, jitter: () => 0.5 },
    })
    const realSend = adapter.send.bind(adapter)
    const deliveryKeys: Array<string | undefined> = []
    let calls = 0
    adapter.send = vi.fn(async (target, message) => {
      deliveryKeys.push(target.deliveryKey)
      if (++calls === 1) throw new Error('transient')
      return realSend(target, message)
    })

    await outbound.sendNotice('k', { blocks: [{ kind: 'text', markdown: 'maintenance' }] }, 'stable-notice')

    expect(adapter.send).toHaveBeenCalledTimes(2)
    expect(deliveryKeys).toEqual(['stable-notice', 'stable-notice'])
  })

  it('bounds permanently failing notice retries', async () => {
    const { adapter, outbound } = await setup({
      noticeRetry: { attempts: 3, baseMs: 1, maxMs: 1, jitter: () => 0.5 },
    })
    adapter.send = vi.fn(async () => {
      throw new Error('permanent')
    })

    await expect(
      outbound.sendNotice('k', { blocks: [{ kind: 'text', markdown: 'maintenance' }] }, 'stable-notice'),
    ).rejects.toThrow('permanent')
    expect(adapter.send).toHaveBeenCalledTimes(3)
  })

  it('cancels a notice retry backoff on stop', async () => {
    const { adapter, outbound } = await setup({
      stopSettleMs: 100,
      noticeRetry: { attempts: 3, baseMs: 60_000, maxMs: 60_000, jitter: () => 0.5 },
    })
    adapter.send = vi.fn(async () => {
      throw new Error('offline')
    })
    const sending = outbound.sendNotice(
      'k',
      { blocks: [{ kind: 'text', markdown: 'maintenance' }] },
      'stable-notice',
    )
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalledOnce())

    await outbound.stop()

    await expect(sending).rejects.toMatchObject({ name: 'AbortError' })
    expect(adapter.send).toHaveBeenCalledOnce()
  })

  it('sends a new node once, updates changed content, and serializes concurrent flushes', async () => {
    const { adapter, client, outbound } = await setup()
    client.setTimeline(
      'k',
      timeline([
        {
          kind: 'tool',
          id: 'tool-1',
          seq: 2,
          toolUseId: 'x',
          name: 'query',
          status: 'running',
          summary: '',
        },
      ]),
    )
    await Promise.all([outbound.flush('k'), outbound.flush('k')])
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]?.msg.blocks[0]).toMatchObject({ markdown: '⚙ query · 运行中' })

    client.setTimeline(
      'k',
      timeline(
        [
          {
            kind: 'tool',
            id: 'tool-1',
            seq: 2,
            toolUseId: 'x',
            name: 'query',
            status: 'completed',
            summary: '',
          },
        ],
        3,
      ),
    )
    await outbound.flush('k')
    await outbound.flush('k')
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.updates).toHaveLength(1)
    expect(adapter.updates[0]?.msg.blocks[0]).toMatchObject({ markdown: '⚙ query · 完成' })
  })

  it('does not resend an unchanged active timeline after the retention horizon', async () => {
    const { adapter, client, outbound, refs } = await setup()
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'stable', seq: 2, text: 'same' }], 2))
    await outbound.flush('k')
    expect(refs.gc(Date.now() + 31 * 24 * 60 * 60 * 1_000)).toBe(0)
    await outbound.flush('k')
    expect(adapter.sent).toHaveLength(1)
  })

  it('re-sends without edit capability and reports each degraded capability once', async () => {
    const { adapter, client, outbound } = await setup({ caps: { edit: false } })
    const degraded: string[] = []
    outbound.onDegraded = (key, capability) => degraded.push(`${key}:${capability}`)

    for (const [index, text] of ['v1', 'v2', 'v3'].entries()) {
      client.setTimeline('k', timeline([{ kind: 'assistant', id: 'assistant-1', seq: 2, text }], index + 2))
      await outbound.flush('k')
    }

    expect(adapter.sent.map((sent) => sent.msg.blocks[0])).toEqual([
      { kind: 'text', markdown: 'v1' },
      { kind: 'text', markdown: '（更新）v2' },
      { kind: 'text', markdown: '（更新）v3' },
    ])
    expect(degraded).toEqual(['k:edit'])
  })

  it('preserves every character across chunks and records only the first reference', async () => {
    const { adapter, client, outbound, refs } = await setup({ textChars: 8 })
    const text = `alpha\n\nbeta\nline-two\n\n${'x'.repeat(17)}`
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'assistant-1', seq: 2, text }], 2))
    await outbound.flush('k')

    const chunks = adapter.sent.flatMap((sent) =>
      sent.msg.blocks.map((block) => {
        if (block.kind !== 'text') throw new Error('expected text chunk')
        return block.markdown
      }),
    )
    expect(chunks.join('')).toBe(text)
    expect(
      adapter.sent.every(
        ({ msg }) =>
          msg.blocks.reduce((sum, block) => sum + (block.kind === 'text' ? block.markdown.length : 0), 0) <=
          8,
      ),
    ).toBe(true)
    expect(refs.get('k', 'assistant-1')?.ref).toEqual(adapter.sent[0]?.ref)
  })

  it('limits cumulative text per payload across text, table, and card degradation on update retry', async () => {
    const { adapter, client, outbound } = await setup({
      textChars: 12,
      caps: { card: false, edit: false },
    })
    const node = (status: 'running' | 'completed'): UITimeline['nodes'][number] => ({
      kind: 'tool' as const,
      id: 'mixed',
      seq: 2,
      toolUseId: 'mixed-tool',
      name: 'long-tool',
      status,
      summary: '',
      slots: [
        {
          slot: 'tool.card.inline',
          extId: 'reports',
          payload: {
            title: 'table-title',
            table: { columns: ['alpha', 'beta'], rows: [['one', 'two']] },
            chart: { kind: 'bar' },
            actions: [{ id: 'open', label: 'open-report' }],
          },
        },
      ],
    })
    client.setTimeline('k', timeline([node('running')], 2))
    await outbound.flush('k')
    const initialCount = adapter.sent.length

    const realSend = adapter.send.bind(adapter)
    let updateSends = 0
    adapter.send = vi.fn(async (target, message) => {
      updateSends++
      if (updateSends === 2) throw new Error('mixed retry')
      return realSend(target, message)
    })
    client.setTimeline('k', timeline([node('completed')], 3))
    await expect(outbound.flush('k')).rejects.toThrow('mixed retry')
    await outbound.flush('k')

    expect(adapter.sent.length).toBeGreaterThan(initialCount)
    for (const { msg } of adapter.sent) {
      const cumulative = msg.blocks.reduce(
        (sum, block) => sum + (block.kind === 'text' ? block.markdown.length : 0),
        0,
      )
      expect(cumulative).toBeLessThanOrEqual(12)
    }
  })

  it('ignores stale projections while preserving refs across a generation change', async () => {
    const { adapter, client, outbound } = await setup()
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'new' }], 10, 2))
    await outbound.flush('k', { reason: 'generationChanged' })

    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'old' }], 99, 1))
    await outbound.flush('k')
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'older' }], 9, 2))
    await outbound.flush('k')

    expect(adapter.sent).toHaveLength(1)
    expect(adapter.updates).toHaveLength(0)
  })

  it('tracks turn state from the real event iterator and flushes turn/end immediately', async () => {
    const { adapter, cache, client } = await setup({ debounceMs: 60_000 })
    client.pushEvent('k', event(1, 'turn/start'))
    await vi.waitFor(() => expect(cache.busy('k')).toBe(true))

    client.setTimeline(
      'k',
      timeline([{ kind: 'cost', id: 'cost', seq: 2, credits: 3, source: 'estimated' }], 2),
    )
    client.pushEvent('k', event(2, 'turn/end', { reason: 'completed', lastAssistantSeq: null }))
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
    expect(cache.busy('k')).toBe(false)
  })

  it('detaches cleanly and makes later recovery flushes inert', async () => {
    const { adapter, client, outbound } = await setup()
    outbound.detach('k')
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'ignored' }]))
    await outbound.flush('k', { reason: 'gap' })
    expect(adapter.sent).toHaveLength(0)
  })

  it('updates multipart revisions without indefinitely appending obsolete tail chunks', async () => {
    const { adapter, client, outbound } = await setup({ textChars: 4 })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'abcdefghijkl' }], 2))
    await outbound.flush('k')
    expect(adapter.sent).toHaveLength(3)

    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'new' }], 3))
    await outbound.flush('k')
    await outbound.flush('k')
    expect(adapter.sent).toHaveLength(3)
    expect(adapter.updates).toHaveLength(3)
    expect(adapter.updates.slice(1).map((item) => item.msg.blocks[0])).toEqual([
      { kind: 'text', markdown: '↩ 内容' },
      { kind: 'text', markdown: '↩ 内容' },
    ])
    for (const { msg } of [...adapter.sent, ...adapter.updates]) {
      expect(
        msg.blocks.reduce((sum, block) => sum + (block.kind === 'text' ? block.markdown.length : 0), 0),
      ).toBeLessThanOrEqual(4)
    }
  })

  it('uses a legal one-character tombstone at the minimum text limit', async () => {
    const { adapter, client, outbound } = await setup({ textChars: 1 })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'abc' }], 2))
    await outbound.flush('k')

    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'z' }], 3))
    await outbound.flush('k')

    expect(adapter.updates.slice(1).map((item) => item.msg.blocks[0])).toEqual([
      { kind: 'text', markdown: '↩' },
      { kind: 'text', markdown: '↩' },
    ])
    for (const { msg } of [...adapter.sent, ...adapter.updates]) {
      expect(
        msg.blocks.reduce((sum, block) => sum + (block.kind === 'text' ? block.markdown.length : 0), 0),
      ).toBeLessThanOrEqual(1)
      for (const block of msg.blocks) {
        if (block.kind === 'text') expect(block.markdown).not.toMatch(/[\uD800-\uDFFF]/)
      }
    }
  })

  it('persists each multipart send and resumes after an intermediate failure', async () => {
    const { adapter, client, outbound, refs } = await setup({ textChars: 4, caps: { edit: false } })
    const realSend = adapter.send.bind(adapter)
    let calls = 0
    adapter.send = vi.fn(async (target, message) => {
      calls++
      if (calls === 2) throw new Error('transient')
      return realSend(target, message)
    })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'abcdefghijkl' }], 2))

    await expect(outbound.flush('k')).rejects.toThrow('transient')
    expect(refs.getState('k', 'a')).toMatchObject({
      complete: false,
      parts: [{ contentHash: expect.any(String) }],
    })
    await outbound.flush('k')

    expect(adapter.sent).toHaveLength(3)
    expect(adapter.sent.map((item) => item.msg.blocks[0])).toContainEqual({ kind: 'text', markdown: 'abcd' })
    expect(refs.getState('k', 'a')).toMatchObject({ complete: true })
  })

  it('keeps a non-edit update revision stable while resuming a failed multipart send', async () => {
    const { adapter, client, outbound } = await setup({ textChars: 4, caps: { edit: false } })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'old' }], 2))
    await outbound.flush('k')

    const realSend = adapter.send.bind(adapter)
    let revisionCalls = 0
    adapter.send = vi.fn(async (target, message) => {
      revisionCalls++
      if (revisionCalls === 2) throw new Error('middle')
      return realSend(target, message)
    })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'abcdefgh' }], 3))
    await expect(outbound.flush('k')).rejects.toThrow('middle')
    await outbound.flush('k')

    const expectedRevision = chunkText('（更新）abcdefgh', 4)
    expect(
      adapter.sent.slice(1).map((item) => {
        const block = item.msg.blocks[0]
        return block?.kind === 'text' ? block.markdown : ''
      }),
    ).toEqual(expectedRevision)
  })

  it('recovers the serialized lane after projectUI, send, and update failures', async () => {
    const { adapter, client, outbound, session } = await setup()
    const realProject = session.projectUI.bind(session)
    session.projectUI = vi.fn().mockRejectedValueOnce(new Error('projection')).mockImplementation(realProject)
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'one' }], 2))
    await expect(outbound.flush('k')).rejects.toThrow('projection')

    const realSend = adapter.send.bind(adapter)
    adapter.send = vi.fn().mockRejectedValueOnce(new Error('send')).mockImplementation(realSend)
    await expect(outbound.flush('k')).rejects.toThrow('send')
    await outbound.flush('k')

    const realUpdate = adapter.update.bind(adapter)
    adapter.update = vi.fn().mockRejectedValueOnce(new Error('update')).mockImplementation(realUpdate)
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'two' }], 3))
    await expect(outbound.flush('k')).rejects.toThrow('update')
    await outbound.flush('k')
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.updates).toHaveLength(1)
  })

  it('propagates a live ref-store write failure instead of claiming completion', async () => {
    const { adapter, client, outbound, refs } = await setup()
    refs.putProgress = vi.fn(() => {
      throw new Error('sqlite disk full')
    })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'sent' }], 2))

    await expect(outbound.flush('k')).rejects.toThrow('sqlite disk full')
    expect(adapter.sent).toHaveLength(1)
    expect(refs.getState('k', 'a')).toBeUndefined()
  })

  it('bounds stop even when an adapter send never settles', async () => {
    const { adapter, client, outbound, session } = await setup({ stopSettleMs: 20 })
    adapter.send = vi.fn(() => new Promise<MessageRef>(() => undefined))
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'blocked' }], 2))
    void outbound.flush('k')
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalled())
    await expect(outbound.stop()).resolves.toBeUndefined()
    outbound.attach('after-stop', session, { chatId: 'chat-1' })
    await outbound.flush('after-stop')
    expect(outbound.keys()).toEqual([])
  })

  it('allows a late send settlement after bounded stop without writing a closed store', async () => {
    const { adapter, client, outbound, refs } = await setup({ stopSettleMs: 5 })
    let resolveSend!: (ref: { chatId: string; messageId: string }) => void
    adapter.send = vi.fn(
      () =>
        new Promise<MessageRef>((resolve) => {
          resolveSend = resolve
        }),
    )
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'blocked' }], 2))
    const flushing = outbound.flush('k')
    await vi.waitFor(() => expect(adapter.send).toHaveBeenCalled())
    await outbound.stop()
    refs.close()
    resolveSend({ chatId: 'chat-1', messageId: 'late' })
    await expect(flushing).resolves.toBeUndefined()
  })

  it('handles a late update rejection after bounded stop without a closed-store write', async () => {
    const { adapter, client, outbound, refs } = await setup({ stopSettleMs: 5 })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'one' }], 2))
    await outbound.flush('k')
    let rejectUpdate!: (error: Error) => void
    adapter.update = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectUpdate = reject
        }),
    )
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'two' }], 3))
    const flushing = outbound.flush('k')
    await vi.waitFor(() => expect(adapter.update).toHaveBeenCalled())
    await outbound.stop()
    refs.close()
    rejectUpdate(new Error('late rejection'))
    await expect(flushing).rejects.toThrow('late rejection')
  })

  it('cancels queued throttle waits on detach', async () => {
    const { adapter, client, outbound } = await setup({ textChars: 4, sessionPerSec: 1 })
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'abcdefgh' }], 2))
    const flushing = outbound.flush('k')
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
    outbound.detach('k')
    await expect(flushing).rejects.toMatchObject({ name: 'AbortError' })
    expect(adapter.sent).toHaveLength(1)
  })

  it.each(['same', 'different'])('does not reuse old refs after /new when content is %s', async (variant) => {
    const { adapter, client, outbound, session: oldSession } = await setup()
    client.setTimeline('k', timeline([{ kind: 'assistant', id: 'same-node', seq: 2, text: 'old' }], 2))
    await outbound.flush('k')
    outbound.detach('k')

    const newSession = await client.session.new({
      cwd: '/workspace',
      preset: 'channel',
      sessionKey: 'new-id',
    })
    client.setTimeline('new-id', {
      ...timeline(
        [{ kind: 'assistant', id: 'same-node', seq: 2, text: variant === 'same' ? 'old' : 'new' }],
        2,
      ),
      sessionId: 'new-id',
    })
    expect(newSession.id).not.toBe(oldSession.id)
    outbound.attach('k', newSession, { chatId: 'chat-1' })
    await outbound.flush('k')

    expect(adapter.sent).toHaveLength(2)
    expect(adapter.updates).toHaveLength(0)
  })

  it('rebuilds an event iterator after it throws', async () => {
    const { adapter, client, outbound } = await setup({ debounceMs: 1 })
    outbound.detach('k')
    const session = await client.session.new({
      cwd: '/workspace',
      preset: 'channel',
      sessionKey: 'recovery-id',
    })
    const realEvents = session.events.bind(session)
    let attempts = 0
    session.events = (() => {
      attempts++
      if (attempts === 1) {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('stream reset')),
          }),
        }
      }
      return realEvents()
    }) as typeof session.events
    outbound.attach('k', session, { chatId: 'chat-1' })
    client.setTimeline('recovery-id', {
      ...timeline([{ kind: 'assistant', id: 'a', seq: 2, text: 'recovered' }], 2),
      sessionId: 'recovery-id',
    })
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1))
    client.pushEvent('recovery-id', event(2, 'turn/end'))
    await vi.waitFor(() => expect(adapter.sent).toHaveLength(1))
  })

  it('calls return and wakes a never-yielding event iterator on detach', async () => {
    const { client, outbound } = await setup({ stopSettleMs: 500 })
    outbound.detach('k')
    const session = await client.session.new({
      cwd: '/workspace',
      preset: 'channel',
      sessionKey: 'blocked-id',
    })
    const returned = vi.fn(async () => ({ value: undefined, done: true as const }))
    session.events = (() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => undefined),
        return: returned,
      }),
    })) as typeof session.events
    outbound.attach('blocked', session, { chatId: 'chat-1' })
    outbound.detach('blocked')

    await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce())
  })

  it('awaits iterator return inside the bounded stop window', async () => {
    const { client, outbound } = await setup({ stopSettleMs: 500 })
    outbound.detach('k')
    const session = await client.session.new({
      cwd: '/workspace',
      preset: 'channel',
      sessionKey: 'return-id',
    })
    let releaseReturn!: () => void
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve
    })
    const returned = vi.fn(async () => {
      await returnGate
      return { value: undefined, done: true as const }
    })
    session.events = (() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => undefined),
        return: returned,
      }),
    })) as typeof session.events
    outbound.attach('returning', session, { chatId: 'chat-1' })
    let stopped = false
    const stopping = outbound.stop().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(returned).toHaveBeenCalledOnce())
    expect(stopped).toBe(false)
    releaseReturn()
    await stopping
    expect(stopped).toBe(true)
  })

  it('caps detached work when repeated iterator return and flush operations never settle', async () => {
    const { client, outbound } = await setup({ stopSettleMs: 10, maxDetachedWork: 2 })
    outbound.detach('k')
    for (let index = 0; index < 12; index++) {
      const session = await client.session.new({
        cwd: '/workspace',
        preset: 'channel',
        sessionKey: `blocked-${index}`,
      })
      session.events = (() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => undefined),
          return: () => new Promise(() => undefined),
        }),
      })) as typeof session.events
      session.projectUI = vi.fn(() => new Promise(() => undefined)) as typeof session.projectUI
      outbound.attach(`blocked-${index}`, session, { chatId: 'chat-1' })
      void outbound.flush(`blocked-${index}`)
      outbound.detach(`blocked-${index}`)
    }

    const tracked = (outbound as unknown as { detachedPumps: Set<Promise<void>> }).detachedPumps
    expect(tracked.size).toBeLessThanOrEqual(2)
    await expect(outbound.stop()).resolves.toBeUndefined()
  })
})
