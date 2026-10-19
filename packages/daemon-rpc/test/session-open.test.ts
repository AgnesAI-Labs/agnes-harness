import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { expect, it, vi } from 'vitest'
import { waitForHistoryOpen } from '../src/local/history-open.js'
import { disposeFeeds, type Feed, type LocalContext, registerAcp } from '../src/local/methods/acp.js'

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
