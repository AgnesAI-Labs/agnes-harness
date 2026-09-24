import type { Provider, RequestBody } from '@agnes/protocol'
import { createClient, memoryJournal, TransportClosed } from '@agnes/sdk'
import { createClient as browserClient, localStorageJournal } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { createLocalEndpoint } from '../src/local/index.js'
import { openTestHost, say, slowProvider } from './host.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
})
async function service(options: Parameters<typeof openTestHost>[0] = {}) {
  const h = await openTestHost(options)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const endpoints: ReturnType<typeof createLocalEndpoint>[] = []
  const ended: Promise<void>[] = []
  wss.on('connection', (socket) => {
    const endpoint = h.endpoint({ pollMs: 5 })
    endpoints.push(endpoint)
    ended.push(
      new Promise<void>((resolve) =>
        socket.on('close', () => {
          void endpoint.close().finally(resolve)
        }),
      ),
    )
    void (async () => {
      for await (const message of endpoint.notifications)
        if (socket.readyState === 1) socket.send(JSON.stringify(message))
    })()
    socket.on('message', (raw) => {
      void (async () => {
        const response = await endpoint.handle(JSON.parse(raw.toString()))
        if (response && socket.readyState === 1) socket.send(JSON.stringify(response))
      })()
    })
  })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (!address || typeof address === 'string') throw new Error('missing integration socket')
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await Promise.all(ended)
    await h.close()
  })
  return { h, url: `ws://127.0.0.1:${address.port}`, endpoints }
}
it.each([
  ['node', createClient],
  ['browser API', browserClient],
] as const)(
  'uses the %s default SDK factory with actual daemon/core output and projections',
  async (_name, factory) => {
    const s = await service({ script: [say('actual WebSocket answer')] })
    const client = factory({ journal: memoryJournal(), transport: { kind: 'ws', url: s.url } })
    cleanup.push(() => client.close())
    const session = await client.session.new({ cwd: s.h.dataDir })
    expect(await session.prompt('WebSocket question')).toMatchObject({ reason: 'completed' })
    const timeline = await session.projectUI()
    expect(JSON.stringify(timeline.nodes)).toContain('actual WebSocket answer')
    expect(JSON.stringify(timeline.nodes)).toContain('WebSocket question')
    expect(timeline.generation).toBe(1)
    expect((await session.budget()).ledger).toHaveLength(1)
    await client.session.rename(session.id, 'WebSocket 人工名称')
    await client.session.archive(session.id, true)
    expect((await client.session.list()).items).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        title: 'WebSocket 人工名称',
        titleSource: 'user',
        archived: true,
      }),
    ])
    await client.session.archive(session.id, false)
    const boundary = timeline.turns.findLast((turn) => turn.forkable)?.endSeq
    expect(boundary).toEqual(expect.any(Number))
    const child = await client.session.fork(session.id, boundary as number)
    await client.session.rename(child.id, 'WebSocket 人工名称 (1)')
    const inherited = await child.projectUI()
    expect(JSON.stringify(inherited.nodes)).toContain('WebSocket question')
    expect((await client.session.list()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: session.id, title: 'WebSocket 人工名称', archived: false }),
        expect.objectContaining({ sessionId: child.id, title: 'WebSocket 人工名称 (1)', archived: false }),
      ]),
    )

    await client.close()
    expect(session.closed).toBe(true)
  },
)
it('WebSocket disconnect aborts actual core inference and settles the SDK prompt', async () => {
  const inner = slowProvider(60_000)
  let observed: AbortSignal | undefined
  let begin!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const provider: Provider = {
    models: () => inner.models(),
    async *infer(request: RequestBody, options: { signal: AbortSignal; toolNames: string[] }) {
      observed = options.signal
      begin()
      yield* inner.infer(request, options)
    },
  }
  const s = await service({ provider })
  const client = createClient({ journal: memoryJournal(), transport: { kind: 'ws', url: s.url } })
  cleanup.push(() => client.close())
  const session = await client.session.new({ cwd: s.h.dataDir })
  const result = session.prompt('slow').catch((error: unknown) => error)
  await started
  await client.close()
  expect(await result).toBeInstanceOf(TransportClosed)
  await vi.waitFor(() => expect(observed?.aborted).toBe(true))
})

it('persists an actual browser-API session cursor across journal instances', async () => {
  const s = await service({ script: [say('journal-backed browser answer')] })
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
  const journal = localStorageJournal(storage)
  const client = browserClient({ transport: { kind: 'ws', url: s.url }, journal })
  cleanup.push(() => client.close())
  const session = await client.session.new({ cwd: s.h.dataDir })
  const consumed = (async () => {
    for await (const event of session.events()) if (event.type === 'turn/end') break
  })()
  await session.prompt('persist cursor')
  await consumed
  await client.close()
  const cursor = await journal.cursor(session.id)
  expect(cursor?.fromSeq).toBeGreaterThan(0)
  expect(cursor?.generation).toBe(1)
  await client.close()
  const reopened = localStorageJournal(storage)
  expect(await reopened.clientId()).toBe(await journal.clientId())
  expect(await reopened.cursor(session.id)).toEqual(cursor)
})

it('uses the real browser default journal while consuming actual core events over WebSocket', async () => {
  const s = await service({ script: [say('default journal answer')] })
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  })
  const client = browserClient({ transport: { kind: 'ws', url: s.url } })
  cleanup.push(() => client.close())
  const session = await client.session.new({ cwd: s.h.dataDir })
  const consumed = (async () => {
    for await (const event of session.events()) if (event.type === 'turn/end') break
  })()
  await session.prompt('default persistence')
  await consumed
  await client.close()
  const saved = await localStorageJournal().cursor(session.id)
  expect(saved?.fromSeq).toBeGreaterThan(0)
  expect(saved?.generation).toBe(1)
  expect(await localStorageJournal().clientId()).toBe(await client.clientId())
})

it('accepts a default generated command ID for a maximum-length client identity on the real core path', async () => {
  const s = await service()
  const journal = memoryJournal('c'.repeat(128))
  const client = createClient({ transport: { kind: 'ws', url: s.url }, journal })
  cleanup.push(() => client.close())
  const session = await client.session.new({ cwd: s.h.dataDir })
  expect(await session.steer('bounded generated command')).toBeGreaterThan(0)
  expect(await journal.pending(session.id)).toEqual([])
})
