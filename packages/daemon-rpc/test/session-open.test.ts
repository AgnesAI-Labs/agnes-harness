import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { EventEnvelope, HarnessMeta } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { waitForHistoryOpen } from '../src/local/history-open.js'
import { disposeFeeds, Feed, type LocalContext, registerAcp } from '../src/local/methods/acp.js'
import type { SessionEntry } from '../src/local/sessions.js'

it.each([false, true])(
  'ACP load rebuilds historical turns across pages without changing live turns (resumed=%s)',
  async (resumed) => {
    const row = (seq: number, type: string, data: unknown = {}): EventEnvelope =>
      ({ seq, type, data, lane: 'main' }) as EventEnvelope
    const message = (seq: number, type: string, text: string) =>
      row(seq, type, { content: [{ type: 'text', text }] })
    const history = [
      row(1, 'turn/start'),
      message(2, 'user/message', 'old'),
      message(3, 'assistant/message', 'old answer'),
      row(4, 'turn/end', { reason: 'completed' }),
      row(498, 'cost/ledger', { credits: 7 }),
      row(499, 'turn/start'),
      message(500, 'user/message', 'second'),
      message(501, 'assistant/message', 'second answer'),
      row(502, 'turn/end', { reason: 'completed' }),
      row(600, 'turn/start'),
      row(601, 'cost/ledger', { credits: 99 }),
    ]
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'owner' })
    ep.conn.initialized = true
    const feeds = new Map<string, Feed>()
    const entry = {
      key: 'owned',
      generation: 3,
      session: {
        lastSeq: 601,
        latest: () => null,
        verifyHistory: async () => 601,
        scan: async ({ fromSeq, toSeq }: { fromSeq: number; toSeq: number }) => {
          // A new live turn starts while the replay still has an older turn to finish.
          if (fromSeq === 501) {
            feeds.get('owned')?.onEvent(row(620, 'turn/start'))
            feeds.get('owned')?.onEvent(row(621, 'cost/ledger', { credits: 123 }))
          }
          return history.filter((e) => e.seq >= fromSeq && e.seq <= toSeq)
        },
      },
    } as unknown as SessionEntry
    if (!resumed) {
      const feed = new Feed(ep, entry, () => undefined)
      feeds.set(entry.key, feed)
      feed.onEvent(row(600, 'turn/start'))
      feed.onEvent(row(601, 'cost/ledger', { credits: 99 }))
    }
    registerAcp(
      ep,
      {
        sessionOwnership: { resolve: () => ({ principalId: 'owner' }) },
        workspaces: { restoreBinding: async () => ({ canonicalRoot: '/synthetic' }) },
        registry: {
          get: () => (resumed ? undefined : entry),
          open: async () => entry,
          subscribe: (_key: string, listener: (e: EventEnvelope) => void) => {
            listener(row(600, 'turn/start'))
            listener(row(601, 'cost/ledger', { credits: 99 }))
            return () => {}
          },
          subscribePreview: () => () => {},
          previewSnapshot: async () => [],
        },
      } as unknown as LocalContext,
      feeds,
      new Map(),
    )
    try {
      await expect(
        ep.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'session/load',
          params: { sessionId: 'owned', cwd: '/synthetic', mcpServers: [] },
        }),
      ).resolves.toMatchObject({ result: {} })
      const feed = feeds.get('owned')
      if (!feed) throw new Error('load did not create a feed')
      expect(feed.lastPushed).toBe(621)
      feed.onEvent(message(622, 'assistant/message', 'live answer'))
      feed.onEvent(row(623, 'turn/end', { reason: 'completed' }))
      await ep.close()
      const metas: HarnessMeta[] = []
      for await (const frame of ep.notifications) {
        const n = frame as { method?: string; params?: { _meta?: { 'ai.agnes.harness'?: HarnessMeta } } }
        if (n.method === 'session/update' && n.params?._meta?.['ai.agnes.harness'])
          metas.push(n.params._meta['ai.agnes.harness'])
      }
      expect(metas.map((m) => [m.eventSequence, m.promptTurnId])).toEqual([
        [2, '1'],
        [3, '1'],
        [500, '499'],
        [501, '499'],
        [622, '620'],
        [623, '620'],
      ])
      expect(metas[0]).not.toHaveProperty('credits')
      expect(metas[3]?.credits).toEqual({ used: 7, source: 'estimated' })
      expect(metas[4]?.credits).toEqual({ used: 123, source: 'estimated' })
      expect(metas.every((m) => m.generation === 3)).toBe(true)
    } finally {
      disposeFeeds(feeds)
      await ep.close()
    }
  },
)

it('cancels one admission wait without cancelling another open or returning a stale success', async () => {
  const waiting: (() => void)[] = []
  const entry = {
    key: 'owned',
    generation: 1,
    session: {
      lastSeq: 0,
      latest: () => null,
      verifyHistory: ({ signal }: { signal: AbortSignal }) =>
        new Promise<number>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          waiting.push(() => {
            signal.removeEventListener('abort', abort)
            resolve(0)
          })
        }),
    },
  }
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  const feeds = new Map<string, Feed>()
  registerAcp(
    ep,
    {
      sessionOwnership: { resolve: () => ({ principalId: 'owner' }) },
      workspaces: { restoreBinding: async () => ({ canonicalRoot: '/synthetic' }) },
      registry: {
        get: () => entry,
        open: async () => entry,
        subscribe: () => () => {},
        subscribePreview: () => () => {},
        previewSnapshot: async () => [],
      },
    } as unknown as LocalContext,
    feeds,
    new Map(),
  )
  const open = (requestId: string) =>
    ep.handle({
      jsonrpc: '2.0',
      id: requestId,
      method: '_agnes/v1/session.open',
      params: { sessionId: 'owned', requestId },
    })
  try {
    const cancelled = open('old-selection')
    const kept = open('new-selection')
    await vi.waitFor(() => expect(waiting.length).toBe(2))
    await ep.handle({
      jsonrpc: '2.0',
      method: '_agnes/v1/session.loadingCancel',
      params: { sessionId: 'owned', requestId: 'old-selection' },
    })
    await expect(cancelled).resolves.toHaveProperty('error')
    for (const release of waiting) release()
    await expect(kept).resolves.toMatchObject({ result: {} })
  } finally {
    disposeFeeds(feeds)
    await ep.close()
  }
})

it('a cancelled cold caller releases its wait while shared registry preparation still completes', async () => {
  const registry = {}
  const first = new AbortController()
  const second = new AbortController()
  let complete!: (value: string) => void
  const prepared = new Promise<string>((resolve) => {
    complete = resolve
  })
  let sharedSignal: AbortSignal | undefined
  const a = waitForHistoryOpen(
    registry,
    'owned',
    first.signal,
    () => {},
    async (_progress, signal) => {
      sharedSignal = signal
      return prepared
    },
  )
  const b = waitForHistoryOpen(
    registry,
    'owned',
    second.signal,
    () => {},
    async () => prepared,
  )
  const rejected = expect(a).rejects.toThrow('selection changed')
  await Promise.resolve()
  first.abort(new Error('selection changed'))
  await rejected
  expect(sharedSignal?.aborted).toBe(false)
  complete('admitted')
  await expect(b).resolves.toBe('admitted')
})

it('a rapid return waits for cancelled cold preparation to unwind before opening again', async () => {
  const registry = {}
  const controller = new AbortController()
  let rejectOld!: (reason: Error) => void
  const old = new Promise<never>((_, reject) => {
    rejectOld = reject
  })
  const loading = waitForHistoryOpen(
    registry,
    's',
    controller.signal,
    () => {},
    async () => old,
  )
  const rejected = expect(loading).rejects.toThrow('left')
  await Promise.resolve()
  controller.abort(new Error('left'))
  await rejected
  const returned = waitForHistoryOpen(
    registry,
    's',
    new AbortController().signal,
    () => {},
    async () => 'fresh admission',
  )
  rejectOld(new Error('old preparation cancelled'))
  await expect(returned).resolves.toBe('fresh admission')
})
