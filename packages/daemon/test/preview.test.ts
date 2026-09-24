import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { EventEnvelope, InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { createClient, fileJournal } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { LocalEndpoint, PREVIEW_BUDGET } from '../src/local/endpoint.js'
import { Feed } from '../src/local/methods/acp.js'
import {
  PREVIEW_HOLD_MAX_BYTES,
  PreviewPipe,
  SNAPSHOT_SLICE,
  SNAPSHOT_SLICE_BYTES,
} from '../src/local/preview.js'
import type { SessionEntry } from '../src/local/sessions.js'
import type { PreviewSnapshotEntry, PreviewUpdate } from '../src/registry.js'
import type { JsonRpcMessage } from '../src/rpc.js'
import { notify } from '../src/rpc.js'
import { openTestHost } from './host.js'

const p = (delta: string, offset: number, o: Partial<PreviewUpdate> = {}): PreviewUpdate => ({
  lane: 'main',
  effectId: 'e1',
  stream: 'text',
  offset,
  delta,
  ...o,
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Reassembles what a viewer shows by merging on offset, the way every client does. */
function merged(sent: PreviewUpdate[], stream: 'text' | 'thinking' = 'text'): string {
  let out = ''
  for (const x of sent.filter((y) => y.stream === stream)) {
    if (x.offset > out.length) continue
    out += x.delta.slice(out.length - x.offset)
  }
  return out
}

describe('PreviewPipe', () => {
  it('holds live previews while a snapshot is fetched and sends them after it', async () => {
    const sent: PreviewUpdate[] = []
    const snap = deferred<PreviewSnapshotEntry[]>()
    const pipe = new PreviewPipe({ fetch: () => snap.promise, send: (x) => sent.push(x) > 0 })
    pipe.resync()
    // The live delta is newer than the snapshot the worker is about to answer with.
    pipe.live(p('world', 6))
    expect(sent).toEqual([])
    snap.resolve([{ lane: 'main', effectId: 'e1', text: 'hello ', thinking: 'hm' }])
    await snap.promise
    await Promise.resolve()
    expect(sent.map((x) => [x.stream, x.offset, x.delta])).toEqual([
      ['thinking', 0, 'hm'],
      ['text', 0, 'hello '],
      ['text', 6, 'world'],
    ])
    expect(merged(sent)).toBe('hello world')
  })

  it('sends the held previews without a snapshot when fetching one fails', async () => {
    const sent: PreviewUpdate[] = []
    const snap = deferred<PreviewSnapshotEntry[]>()
    const pipe = new PreviewPipe({
      fetch: () => snap.promise.then(() => Promise.reject(new Error('worker session command timed out'))),
      send: (x) => sent.push(x) > 0,
    })
    pipe.resync()
    pipe.live(p('late', 0))
    expect(sent).toEqual([])
    snap.resolve([])
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.map((x) => x.delta)).toEqual(['late'])
    pipe.live(p('r', 4))
    expect(sent.map((x) => x.delta)).toEqual(['late', 'r'])
  })

  it('cuts a long snapshot into consecutive pieces', async () => {
    const sent: PreviewUpdate[] = []
    const text = 'x'.repeat(SNAPSHOT_SLICE + 10)
    const pipe = new PreviewPipe({
      fetch: async () => [{ lane: 'main', effectId: 'e1', text, thinking: '' }],
      send: (x) => sent.push(x) > 0,
    })
    pipe.resync()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.map((x) => x.offset)).toEqual([0, SNAPSHOT_SLICE])
    expect(merged(sent)).toBe(text)
  })

  it('refetches instead of holding more than its limit', async () => {
    const sent: PreviewUpdate[] = []
    let fetches = 0
    const first = deferred<PreviewSnapshotEntry[]>()
    const pipe = new PreviewPipe({
      fetch: () => {
        fetches++
        return fetches === 1
          ? first.promise
          : Promise.resolve([{ lane: 'main', effectId: 'e1', text: 'all', thinking: '' }])
      },
      send: (x) => sent.push(x) > 0,
    })
    pipe.resync()
    pipe.live(p('y'.repeat(PREVIEW_HOLD_MAX_BYTES + 1), 0))
    first.resolve([])
    await new Promise((r) => setTimeout(r, 0))
    expect(fetches).toBe(2)
    expect(sent.map((x) => x.delta)).toEqual(['all'])
  })

  it('resyncs at low water after a refused preview, and only then', async () => {
    let refuse = true
    let fetches = 0
    const sent: PreviewUpdate[] = []
    const pipe = new PreviewPipe({
      fetch: async () => {
        fetches++
        return [{ lane: 'main', effectId: 'e1', text: 'abc', thinking: '' }]
      },
      send: (x) => (refuse ? false : sent.push(x) > 0),
    })
    pipe.lowWater()
    expect(fetches).toBe(0)
    pipe.live(p('abc', 0))
    refuse = false
    pipe.lowWater()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetches).toBe(1)
    expect(merged(sent)).toBe('abc')
  })

  it('drops lanes the viewer filtered out, and everything once closed', async () => {
    const sent: PreviewUpdate[] = []
    const pipe = new PreviewPipe({
      lanes: ['main'],
      fetch: async () => [{ lane: 'side', effectId: 'e2', text: 'no', thinking: '' }],
      send: (x) => sent.push(x) > 0,
    })
    pipe.live(p('no', 0, { lane: 'side' }))
    pipe.resync()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual([])
    pipe.close()
    pipe.live(p('late', 0))
    expect(sent).toEqual([])
  })
})

describe('LocalEndpoint preview budget', () => {
  it('counts previews apart, refuses them past the budget and reports low water once drained', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let lowWater = 0
    ep.onPreviewLowWater(() => lowWater++)
    const frame = notify('_agnes/v1/session.preview', { sessionId: 's', ...p('x', 0) })
    let accepted = 0
    while (ep.pushPreview(frame)) accepted++
    expect(accepted).toBe(PREVIEW_BUDGET.events)
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    expect(ep.pendingPreviews().events).toBe(PREVIEW_BUDGET.events)
    const it = ep.notifications[Symbol.asyncIterator]()
    for (let i = 0; i < PREVIEW_BUDGET.events / 2 - 1; i++) await it.next()
    expect(lowWater).toBe(0)
    await it.next()
    expect(lowWater).toBe(1)
    await it.next()
    expect(lowWater).toBe(1)
    expect(ep.pushPreview(frame)).toBe(true)
  })

  it('delivers a snapshot larger than the whole budget, a few pieces per drain', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    // Three bytes a character once encoded: larger than the budget, however it is cut.
    const text = '中'.repeat(1_200_000)
    let fetches = 0
    const pipe = new PreviewPipe({
      fetch: async () => {
        fetches++
        return [{ lane: 'main', effectId: 'e1', text, thinking: '' }]
      },
      send: (x) => ep.pushPreview(notify('_agnes/v1/session.preview', { sessionId: 's', ...x })),
    })
    ep.onPreviewLowWater(() => pipe.lowWater())
    pipe.resync()
    const it = ep.notifications[Symbol.asyncIterator]()
    const seen: PreviewUpdate[] = []
    while (merged(seen).length < text.length && seen.length < 100) {
      const next = await Promise.race([it.next(), new Promise<null>((r) => setTimeout(() => r(null), 200))])
      if (!next || next.done) break
      seen.push((next.value as unknown as { params: PreviewUpdate }).params)
    }
    expect(merged(seen).length).toBe(text.length)
    expect(fetches).toBeGreaterThan(1)
    expect(seen.every((x) => x.delta.length * 3 <= SNAPSHOT_SLICE_BYTES)).toBe(true)
  })

  it('refuses a malformed preview before it reaches the queue', () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    expect(() => ep.pushPreview(notify('_agnes/v1/session.preview', { sessionId: 's', seq: 1 }))).toThrow()
  })
})

type Update = {
  method?: string
  params?: { update?: { sessionUpdate: string; content?: { text?: string } }; _meta?: unknown }
}

async function drained(ep: LocalEndpoint): Promise<Update[]> {
  await ep.close()
  const out: Update[] = []
  for await (const n of ep.notifications) out.push(n as Update)
  return out
}

const row = (seq: number, type: string, data: unknown): EventEnvelope =>
  ({
    seq,
    ts: '2026-09-24T00:00:00.000Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'model',
    trust: 'trusted',
    lane: 'main',
  }) as EventEnvelope

const message = (seq: number, text: string) =>
  row(seq, 'assistant/message', { content: [{ type: 'text', text }], stopReason: 'end_turn' })

function acpFeed(snapshot: () => Promise<PreviewSnapshotEntry[]> = async () => []) {
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  const feed = new Feed(ep, { key: 's', generation: 1 } as SessionEntry, () => undefined, snapshot)
  return { ep, feed }
}

const said = (updates: Update[]) =>
  updates
    .filter((u) => u.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.params?.update?.content?.text ?? '')

describe('ACP Feed streamed text', () => {
  it('says each part of the answer once: previews, overlap trimmed, then the part they missed', async () => {
    const { ep, feed } = acpFeed()
    feed.onEvent(row(1, 'effect/intent', { effectId: 'e1', kind: 'inference', replay: 'never' }))
    feed.onPreview(p('hel', 0))
    feed.onPreview(p('ello', 1))
    feed.onPreview(p('far ahead', 40))
    feed.onPreview(p('hm', 0, { stream: 'thinking' }))
    feed.onEvent(message(2, 'hello world'))
    const updates = await drained(ep)
    expect(said(updates)).toEqual(['hel', 'lo', ' world'])
    expect(
      updates.find((u) => u.params?.update?.sessionUpdate === 'agent_thought_chunk')?.params?.update?.content
        ?.text,
    ).toBe('hm')
    // Previews are not rows: they carry no harness _meta.
    expect(updates.filter((u) => u.params?._meta === undefined).length).toBe(3)
  })

  it('does not repeat an answer when a snapshot arrives after it', async () => {
    const snapshot = deferred<PreviewSnapshotEntry[]>()
    const { ep, feed } = acpFeed(() => snapshot.promise)
    feed.onEvent(row(1, 'effect/intent', { effectId: 'e1', kind: 'inference', replay: 'never' }))
    feed.previewResync()
    feed.onEvent(message(2, 'done'))
    snapshot.resolve([{ lane: 'main', effectId: 'e1', text: 'done', thinking: '' }])
    await snapshot.promise
    await new Promise((r) => setTimeout(r, 0))
    feed.onPreview(p('done', 0))
    expect(said(await drained(ep))).toEqual(['done'])
  })

  it('catches a load up on a stream already running, then adds only the rest', async () => {
    const { ep, feed } = acpFeed(async () => [{ lane: 'main', effectId: 'e9', text: 'so far', thinking: '' }])
    feed.replayLoad([row(1, 'user/message', { content: [{ type: 'text', text: 'go' }] })])
    feed.previewResync()
    await new Promise((r) => setTimeout(r, 0))
    feed.onPreview(p(' and more', 6, { effectId: 'e9' }))
    feed.onEvent(message(3, 'so far and more, done'))
    expect(said(await drained(ep))).toEqual(['so far', ' and more', ', done'])
  })

  it('says the text of an interrupted output that the previews missed', async () => {
    const { ep, feed } = acpFeed()
    feed.onEvent(row(1, 'effect/intent', { effectId: 'e1', kind: 'inference', replay: 'never' }))
    feed.onPreview(p('part', 0))
    feed.onEvent(
      row(2, 'assistant/output', {
        state: 'interrupted',
        effectId: 'e1',
        chars: { text: 12, thinking: 0 },
        estimatedTokens: 3,
        content: [{ type: 'text', text: 'partial text' }],
      }),
    )
    expect(said(await drained(ep))).toEqual(['part', 'ial text'])
  })

  it('tells the whole answer to a load that joined after the inference began', async () => {
    const snapshot = deferred<PreviewSnapshotEntry[]>()
    const { ep, feed } = acpFeed(() => snapshot.promise)
    feed.replayLoad([row(1, 'user/message', { content: [{ type: 'text', text: 'go' }] })])
    feed.previewResync()
    feed.onPreview(p('the ', 0))
    feed.onEvent(message(4, 'the answer'))
    feed.onEvent(row(5, 'effect/settled', { effectId: 'e1', outcome: 'ok' }))
    snapshot.resolve([])
    await snapshot.promise
    await new Promise((r) => setTimeout(r, 0))
    expect(said(await drained(ep))).toEqual(['the answer'])
  })

  it('after telling a whole answer, drops text for it until the next inference is seen', async () => {
    const snapshot = deferred<PreviewSnapshotEntry[]>()
    const { ep, feed } = acpFeed(() => snapshot.promise)
    feed.previewResync()
    feed.onEvent(message(4, 'the answer'))
    snapshot.resolve([{ lane: 'main', effectId: 'e1', text: 'the answer', thinking: '' }])
    await snapshot.promise
    await new Promise((r) => setTimeout(r, 0))
    feed.onPreview(p('the answer', 0))
    feed.onEvent(row(6, 'effect/intent', { effectId: 'e2', kind: 'inference', replay: 'never' }))
    feed.onPreview(p('next', 0, { effectId: 'e2' }))
    expect(said(await drained(ep))).toEqual(['the answer', 'next'])
  })

  it('tells an answer recorded as interrupted and then as a message once', async () => {
    const { ep, feed } = acpFeed()
    feed.onEvent(row(1, 'effect/intent', { effectId: 'e1', kind: 'inference', replay: 'never' }))
    feed.onPreview(p('the ', 0))
    feed.onEvent(
      row(2, 'assistant/output', {
        state: 'interrupted',
        effectId: 'e1',
        chars: { text: 10, thinking: 0 },
        estimatedTokens: 3,
        content: [{ type: 'text', text: 'the answer' }],
      }),
    )
    feed.onEvent(message(3, 'the answer'))
    feed.onEvent(row(4, 'effect/settled', { effectId: 'e1', outcome: 'ok' }))
    expect(said(await drained(ep))).toEqual(['the ', 'answer'])
  })

  it('takes the running inference from op.state when it opens mid-stream', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const op = { phase: { kind: 'inference', gen: { status: 'effect_pending', effectId: 'e1' } } }
    const session = { latest: (register: string) => (register === 'op.state' ? op : undefined) }
    const feed = new Feed(
      ep,
      { key: 's', generation: 1, session } as never,
      () => undefined,
      async () => [],
    )
    feed.onPreview(p('stale', 0, { effectId: 'e0' }))
    feed.onPreview(p('the ', 0))
    feed.onEvent(message(4, 'the answer'))
    expect(said(await drained(ep))).toEqual(['stale', 'the ', 'answer'])
  })

  it('guesses nothing when what was streamed is not the start of the recorded answer', async () => {
    const { ep, feed } = acpFeed()
    feed.onEvent(row(1, 'effect/intent', { effectId: 'e1', kind: 'inference', replay: 'never' }))
    feed.onPreview(p('draft', 0))
    feed.onEvent(message(2, 'final answer'))
    expect(said(await drained(ep))).toEqual(['draft'])
  })
})

/** Streams "partial ", waits until released, then streams " tail". */
function gatedProvider() {
  const release = deferred<void>()
  const paused = deferred<void>()
  const inner = new ScriptedProvider({ scripts: [[{ type: 'done', reason: 'stop' }]] })
  const provider: Provider = {
    models: () => inner.models(),
    async *infer(
      req: RequestBody,
      opts: { signal: AbortSignal; toolNames: string[] },
    ): AsyncIterable<InferenceEvent> {
      const it = inner.infer(req, opts)[Symbol.asyncIterator]()
      const first = await it.next()
      if (!first.done) yield first.value
      yield { type: 'text_delta', delta: 'partial ' }
      paused.resolve()
      await release.promise
      yield { type: 'text_delta', delta: 'tail' }
      for (let n = await it.next(); !n.done; n = await it.next()) yield n.value
    },
  }
  return { provider, release: () => release.resolve(), paused: paused.promise }
}

describe('AttachedFeed streamed text', () => {
  it('says nothing more once detached, not even a snapshot already on its way', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const snapshot = deferred<PreviewSnapshotEntry[]>()
    const feed = new AttachedFeed({
      ep,
      key: 's',
      generation: 1,
      prefs: { cursor: { fromSeq: 0, generation: 1 }, filter: { preview: true, acpUpdates: false } },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 1 << 20 },
      clock: () => 0,
      onDrop: () => undefined,
      fetchPreview: () => snapshot.promise,
    })
    await feed.replay({ scan: async () => [] } as never, 0, 0)
    feed.detach()
    snapshot.resolve([{ lane: 'main', effectId: 'e1', text: 'so far', thinking: '' }])
    await snapshot.promise
    await new Promise((r) => setTimeout(r, 0))
    feed.onPreview(p(' and more', 6))
    feed.previewResync()
    expect(await drained(ep)).toEqual([])
  })
})

describe('session.preview over a local connection', () => {
  const init = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
      },
    },
  }

  async function lateJoin(filter: Record<string, unknown>) {
    const gate = gatedProvider()
    const h = await openTestHost({ provider: gate.provider })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const made = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const sessionId = made.result.sessionId
    const prompt = ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    })
    await gate.paused
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.attach',
      params: { sessionId, filter },
    })
    await new Promise((r) => setTimeout(r, 20))
    gate.release()
    await prompt
    await ep.close()
    const seen: JsonRpcMessage[] = []
    for await (const n of ep.notifications) seen.push(n)
    await h.close()
    return seen
      .filter((n) => (n as { method?: string }).method === '_agnes/v1/session.preview')
      .map((n) => (n as unknown as { params: PreviewUpdate & { sessionId: string } }).params)
  }

  it('gives a viewer who attaches mid-stream the text so far, then the rest', async () => {
    const previews = await lateJoin({ preview: true, acpUpdates: false })
    expect(previews[0]).toMatchObject({ offset: 0, delta: 'partial ', stream: 'text', lane: 'main' })
    expect(merged(previews)).toBe('partial tail')
  })

  it('sends nothing to a connection that did not ask, or that filtered the lane out', async () => {
    expect(await lateJoin({ acpUpdates: false })).toEqual([])
    expect(await lateJoin({ preview: true, lanes: ['side'], acpUpdates: false })).toEqual([])
  })
})

describe('streamed text is never persisted', () => {
  it('reaches a viewer while no file under the data directory or the client journal holds it', async () => {
    const sentinel = `sentinel-${Math.random().toString(36).slice(2)}`
    const release = deferred<void>()
    const inner = new ScriptedProvider({ scripts: [[{ type: 'done', reason: 'stop' }]] })
    const provider: Provider = {
      models: () => inner.models(),
      async *infer(req: RequestBody, opts: { signal: AbortSignal; toolNames: string[] }) {
        const it = inner.infer(req, opts)[Symbol.asyncIterator]()
        const first = await it.next()
        if (!first.done) yield first.value
        yield { type: 'text_delta', delta: sentinel }
        await release.promise
        for (let n = await it.next(); !n.done; n = await it.next()) yield n.value
      },
    }
    const h = await openTestHost({ provider })
    const journalDir = join(h.dataDir, 'client-journal')
    const endpoint = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: fileJournal(journalDir) })
    try {
      await client.workspace.add(h.dataDir)
      const session = await client.session.new({ cwd: h.dataDir })
      const seen: string[] = []
      session.onPreview((p) => seen.push(p.delta))
      await session.attach({ filter: { preview: true } })
      const prompted = session.prompt('go')
      await vi.waitFor(() => expect(seen.join('')).toContain(sentinel), { timeout: 10_000 })
      const needle = Buffer.from(sentinel)
      const holders = files(h.dataDir).filter((path) => readFileSync(path).includes(needle))
      expect(holders).toEqual([])
      release.resolve()
      await prompted
    } finally {
      release.resolve()
      await client.close()
      await endpoint.close()
      await h.close()
    }
  }, 30_000)
})

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : [],
  )
}
