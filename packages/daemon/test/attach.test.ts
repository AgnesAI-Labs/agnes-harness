import { validateMethod } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { JsonRpcMessage } from '../src/rpc.js'
import { openTestHost, say } from './host.js'

const caps = {
  fs: { readTextFile: false, writeTextFile: false },
  _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
}
const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: caps },
}
type N = {
  method?: string
  params?: {
    event?: { seq: number; type: string }
    kind?: string
    _meta?: Record<string, { eventSequence: number }>
  }
}

/** Close first, then read to the end. A detached pump running alongside would take the values these
 *  assertions are about, and `seen` would come back empty. */
async function drain(ep: {
  notifications: AsyncIterable<JsonRpcMessage>
  close(): Promise<void>
}): Promise<N[]> {
  await ep.close()
  const out: N[] = []
  for await (const n of ep.notifications) out.push(n as N)
  return out
}

const newSession = async (
  ep: { handle(m: JsonRpcMessage): Promise<JsonRpcMessage | undefined> },
  cwd: string,
): Promise<string> => {
  await ep.handle(init)
  const r = (await ep.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd, mcpServers: [] },
  })) as { result: { sessionId: string } }
  return r.result.sessionId
}

describe('_agnes/v1/session.attach', () => {
  it('replays strictly after an exclusive cursor, raw only, then streams', async () => {
    const h = await openTestHost({ script: [say('a'), say('b')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'one' }] },
    })
    // Everything before this point ran unattached, so the ACP stream was live for turn one. What the
    // attach must not do is add to it.
    const mark = ep.pending().events + ep.pendingPreviews().events
    // fromSeq 0 means "nothing applied yet" - the cursor is exclusive - so the replay starts at seq 1.
    const att = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.attach',
      params: {
        sessionId,
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
    })) as { result: { generation: number; lastSeq: number } }
    expect(att.result.generation).toBe(1)
    await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'two' }] },
    })
    const seen = await drain(ep)
    const raw = seen.filter((n) => n.method === '_agnes/v1/session.event')
    const seqs = raw.map((n) => n.params?.event?.seq as number)
    expect(seqs[0]).toBe(1)
    expect(seqs).toEqual([...new Set(seqs)])
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs.some((s) => s > att.result.lastSeq)).toBe(true) // live rows after catch-up
    // Streamed text is never a raw row; with preview:false it is not sent at all.
    expect(seen.some((n) => n.method === '_agnes/v1/session.preview')).toBe(false)
    // The three _meta invariants belong to the ACP stream, which acpUpdates:false switched off; the
    // replay must not have produced any session/update at all.
    expect(seen.slice(0, mark).some((n) => n.method === 'session/update')).toBe(true)
    expect(seen.slice(mark).some((n) => n.method === 'session/update')).toBe(false)
    await h.close()
  })

  it('honours a types filter, so a consumer can drop the classes it does not want', async () => {
    const h = await openTestHost({ script: [say('a')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.attach',
      params: { sessionId, filter: { types: ['user/message', 'turn/end'] } },
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'one' }] },
    })
    const seen = await drain(ep)
    const types = seen
      .filter((n) => n.method === '_agnes/v1/session.event')
      .map((n) => n.params?.event?.type as string)
    expect(types.length).toBeGreaterThan(0)
    expect([...new Set(types)].sort()).toEqual(['turn/end', 'user/message'])
    await h.close()
  })

  it('a cursor already at lastSeq replays nothing and is not an error; past it is -32005', async () => {
    const h = await openTestHost({ script: [say('a')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'one' }] },
    })
    const caught = await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.attach',
      params: { sessionId, cursor: { fromSeq: 999_999, generation: 1 } },
    })
    expect(caught).toMatchObject({ error: { code: -32005, data: { earliestSeq: 0 } } })
    const before = ep.pending().events
    const last = (await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/session.attach',
      params: { sessionId },
    })) as { result: { lastSeq: number } }
    // Default cursor is fromSeq 0, so that attach replayed the whole ledger.
    expect(ep.pending().events).toBeGreaterThan(before)
    const atEnd = ep.pending().events
    const caughtUp = await ep.handle({
      jsonrpc: '2.0',
      id: 6,
      method: '_agnes/v1/session.attach',
      params: { sessionId, cursor: { fromSeq: last.result.lastSeq, generation: 1 } },
    })
    expect(caughtUp).toMatchObject({ result: { generation: 1 } })
    expect(ep.pending().events).toBe(atEnd)
    await ep.close()
    await h.close()
  })

  it('rejects a stale generation and detaches', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/session.attach',
        params: { sessionId, cursor: { fromSeq: 0, generation: 7 } },
      }),
    ).toMatchObject({ error: { code: -32004, data: { generation: 1 } } })
    expect(ep.conn.attached.has(sessionId)).toBe(false)
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.attach',
      params: { sessionId },
    })
    expect(ep.conn.attached.has(sessionId)).toBe(true)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 5,
        method: '_agnes/v1/session.detach',
        params: { sessionId },
      }),
    ).toMatchObject({ result: {} })
    expect(ep.conn.attached.has(sessionId)).toBe(false)
    await ep.close()
    await h.close()
  })

  it('a detached connection stops receiving raw rows', async () => {
    const h = await openTestHost({ script: [say('a'), say('b')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    expect(
      await ep.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/session.attach',
        params: { sessionId },
      }),
    ).toMatchObject({ result: { generation: 1 } })
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'one' }] },
    })
    const streamed = ep.pending().events
    await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/session.detach',
      params: { sessionId },
    })
    const mark = ep.pending().events
    expect(mark).toBe(streamed)
    await ep.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'two' }] },
    })
    const seen = await drain(ep)
    // The first turn did stream raw rows, so the absence after the detach is a change and not the
    // state this connection was in all along.
    expect(seen.slice(0, mark).some((n) => n.method === '_agnes/v1/session.event')).toBe(true)
    const after = seen.slice(mark)
    expect(after.length).toBeGreaterThan(0) // the second turn did produce notifications
    expect(after.some((n) => n.method === '_agnes/v1/session.event')).toBe(false)
    await h.close()
  })

  it('the ACP stream survives an attach that happens after a completed turn', async () => {
    // Replaying history through the ACP Feed would re-emit terminalQuiescence for every past turn and
    // push eventSequence backwards. Attach after one turn, run another, and check the ACP stream.
    const h = await openTestHost({ script: [say('a'), say('b')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'one' }] },
    })
    const attached = await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.attach',
      params: { sessionId, cursor: { fromSeq: 0, generation: 1 }, filter: { acpUpdates: true } },
    })
    expect(attached).toMatchObject({ result: { generation: 1 } })
    await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'two' }] },
    })
    const seen = await drain(ep)
    // Streamed text rides as previews, which are not rows and carry no harness _meta.
    const acp = seen.filter(
      (n) => n.method === 'session/update' && n.params?._meta?.['ai.agnes.harness'] !== undefined,
    )
    const seqs = acp.map((n) => n.params?._meta?.['ai.agnes.harness']?.eventSequence as number)
    expect(seqs.length).toBeGreaterThan(2)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    await h.close()
  })

  // Three real turns: about 0.1 s alone, past the 5 s default on the Windows runner.
  it('cuts the subscription when the consumer does not drain, and stops delivering after the notice', async () => {
    const h = await openTestHost({ script: Array.from({ length: 8 }, () => say('x'.repeat(200))) })
    const ep = h.endpoint({
      clock: () => 1_700_000_000_000,
      pollMs: 5,
      limits: { subscribeBufferEvents: 5, subscribeBufferBytes: 1 << 20 },
    })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.attach',
      params: { sessionId, filter: { acpUpdates: false } },
    })
    for (let i = 0; i < 3; i++)
      await ep.handle({
        jsonrpc: '2.0',
        id: 10 + i,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      })
    // Nothing is consumed until here, so the whole run is in the queue; drain it all and then assert
    // on its shape. The old test broke out of the loop on the notice and then asserted that the last
    // element was the notice - the exit condition was the assertion.
    const seen = await drain(ep)
    const notices = seen.filter((n) => n.method === '_agnes/v1/daemon.notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      params: { kind: 'overloaded', sessionId, detail: { code: 'OVERLOADED', retryAfterMs: 500 } },
    })
    const at = seen.indexOf(notices[0] as N)
    expect(seen.slice(at + 1).some((n) => n.method === '_agnes/v1/session.event')).toBe(false)
    expect(
      seen.slice(0, at).filter((n) => n.method === '_agnes/v1/session.event').length,
    ).toBeLessThanOrEqual(6)
    expect(ep.conn.attached.has(sessionId)).toBe(false)
    // Every notice must be discriminable by kind: sdk forwards the params with no declared type.
    expect(
      validateMethod('_agnes/v1/daemon.notice', 'params', (notices[0] as { params: unknown }).params).ok,
    ).toBe(true)
    await h.close()
  }, 30_000)

  // A real turn: about 0.1 s alone, past the 5 s default on the Windows runner.
  it('attach consumers see request/header rows and plain ACP clients see none', async () => {
    // What is exercised here is one successful turn: the header reaches the raw stream and no
    // session/update mentions it, because toSessionUpdate maps request/header to null. The reason
    // raw consumers get them at all is that an aborted or retried attempt writes the request it
    // tried too, so a header means "a request was tried", not "a request got an answer" - that half
    // is the contract this direction serves, not something this scenario reproduces.
    const h = await openTestHost({ script: [say('a')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    const sessionId = await newSession(ep, h.dataDir)
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.attach',
      params: { sessionId, filter: { acpUpdates: true } },
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'one' }] },
    })
    const seen = await drain(ep)
    expect(
      seen.some((n) => n.method === '_agnes/v1/session.event' && n.params?.event?.type === 'request/header'),
    ).toBe(true)
    expect(
      seen.some((n) => n.method === 'session/update' && JSON.stringify(n).includes('request/header')),
    ).toBe(false)
    await h.close()
  }, 30_000)
})

describe('AttachedFeed replay ordering', () => {
  const row = (seq: number) => ({
    seq,
    ts: '1970-01-01T00:00:00.000Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type: 'user/message',
    data: {},
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
  })

  it('holds a live row that lands mid-replay instead of putting it ahead of older history', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const session = {
      scan: async (q: { fromSeq: number; toSeq: number }) => {
        await gate
        return [row(1), row(2), row(3)].filter((r) => r.seq >= q.fromSeq && r.seq <= q.toSeq)
      },
    }
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 1 << 20 },
      clock: () => 0,
      onDrop: () => undefined,
    })
    const replaying = feed.replay(session as never, 0, 3)
    // A live row arrives while the history page is still being read.
    feed.onEvent(row(4) as never)
    release?.()
    await replaying
    const seen: number[] = []
    await ep.close()
    for await (const n of ep.notifications)
      seen.push((n as { params: { event: { seq: number } } }).params.event.seq)
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('holds rows from the publication-to-cut window before the replay scan begins', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const session = {
      scan: async (q: { fromSeq: number; toSeq: number }) =>
        [row(1), row(2), row(3)].filter((event) => event.seq >= q.fromSeq && event.seq <= q.toSeq),
    }
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 1 << 20 },
      clock: () => 0,
      onDrop: () => undefined,
    })
    feed.beginReplay()
    // The feed is now published, but the handler has not captured its final replay cut yet.
    feed.onEvent(row(4) as never)
    await feed.replay(session as never, 0, 3)
    const seen: number[] = []
    await ep.close()
    for await (const n of ep.notifications)
      seen.push((n as { params: { event: { seq: number } } }).params.event.seq)
    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('notices the overload once and then delivers nothing, however often it is called', async () => {
    // onDrop unhooks the feed in the live wiring, so the map is what usually stops the second call.
    // The feed still has to be safe on its own: a second notice is a second detach instruction, and
    // a row emitted after the cut is one the client was told it would not get.
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let drops = 0
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 1, subscribeBufferBytes: 1 << 20 },
      clock: () => 0,
      onDrop: () => {
        drops++
      },
    })
    feed.onEvent(row(1) as never) // queue is empty, so this one is delivered
    feed.onEvent(row(2) as never) // one queued item is already at the limit: cut
    feed.onEvent(row(3) as never)
    feed.onEvent(row(4) as never)
    expect(drops).toBe(1)
    const seen: string[] = []
    await ep.close()
    for await (const n of ep.notifications) seen.push((n as { method: string }).method)
    expect(seen).toEqual(['_agnes/v1/session.event', '_agnes/v1/daemon.notice'])
  })

  it('refuses a single event whose utf8 frame exceeds the byte cap, even on an empty queue', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let drops = 0
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 100 },
      clock: () => 0,
      onDrop: () => {
        drops++
      },
    })
    feed.onEvent({ ...row(1), data: { text: '你'.repeat(80) } } as never)
    expect(drops).toBe(1)
    const seen: string[] = []
    await ep.close()
    for await (const n of ep.notifications) seen.push((n as { method: string }).method)
    expect(seen).toEqual(['_agnes/v1/daemon.notice'])
  })

  it('cuts when the incoming frame would take the backlog over the utf8 byte cap', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let drops = 0
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 800 },
      clock: () => 0,
      onDrop: () => {
        drops++
      },
    })
    feed.onEvent(row(1) as never)
    expect(drops).toBe(0)
    expect(ep.pending().events).toBe(1)
    const firstBytes = ep.pending().bytes
    feed.onEvent({ ...row(2), data: { text: '你'.repeat(400) } } as never)
    expect(drops).toBe(1)
    expect(ep.pending().bytes).toBeGreaterThan(firstBytes)
    const seen: string[] = []
    await ep.close()
    for await (const n of ep.notifications) seen.push((n as { method: string }).method)
    expect(seen).toEqual(['_agnes/v1/session.event', '_agnes/v1/daemon.notice'])
  })

  it('does not re-send a held row the replay already covered', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const session = {
      scan: async (q: { fromSeq: number; toSeq: number }) => {
        await gate
        return [row(1), row(2), row(3)].filter((r) => r.seq >= q.fromSeq && r.seq <= q.toSeq)
      },
    }
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 0, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 1 << 20 },
      clock: () => 0,
      onDrop: () => undefined,
    })
    const replaying = feed.replay(session as never, 0, 3)
    // seq 3 is inside the replayed range: the page already carries it.
    feed.onEvent(row(3) as never)
    release?.()
    await replaying
    const seen: number[] = []
    await ep.close()
    for await (const n of ep.notifications)
      seen.push((n as { params: { event: { seq: number } } }).params.event.seq)
    expect(seen).toEqual([1, 2, 3])
  })

  it('does not re-send storage rows delivered by a lagging tail after replay completed', async () => {
    const { AttachedFeed } = await import('../src/local/attached.js')
    const { LocalEndpoint } = await import('../src/local/endpoint.js')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const session = {
      scan: async (q: { fromSeq: number; toSeq: number }) =>
        [row(1), row(2), row(3)].filter((event) => event.seq >= q.fromSeq && event.seq <= q.toSeq),
    }
    const feed = new AttachedFeed({
      ep,
      key: 'k',
      generation: 1,
      prefs: {
        cursor: { fromSeq: 3, generation: 1 },
        filter: { preview: false, acpUpdates: false },
      },
      limits: { subscribeBufferEvents: 100, subscribeBufferBytes: 1 << 20 },
      clock: () => 0,
      onDrop: () => undefined,
    })

    await feed.replay(session as never, 3, 3)
    // tailSession had not observed the committed storage cut when attach completed. Its delayed
    // copies are already represented by the snapshot/cursor and therefore are not live events.
    feed.onEvent(row(1) as never)
    feed.onEvent(row(2) as never)
    feed.onEvent(row(3) as never)
    feed.onEvent(row(4) as never)

    const seen: number[] = []
    await ep.close()
    for await (const n of ep.notifications)
      seen.push((n as { params: { event: { seq: number } } }).params.event.seq)
    expect(seen).toEqual([4])
  })
})

describe('daemon.notice construction', () => {
  it('every kind the protocol defines produces params the live schema accepts', async () => {
    const { noticeParams } = await import('../src/local/attached.js')
    const kinds = [
      'resumed',
      'worker_crashed',
      'worker_quarantined',
      'overloaded',
      'job_dispatched',
      'job_dead',
      'shutting_down',
    ] as const
    for (const kind of kinds) {
      const p = noticeParams(kind, { sessionId: 'k', detail: { code: 'X' }, atMs: 0 })
      expect(p.kind).toBe(kind)
      expect(validateMethod('_agnes/v1/daemon.notice', 'params', p).ok, kind).toBe(true)
    }
    // The set is the schema's, not a list kept here: a kind the schema does not know is refused.
    expect(
      validateMethod('_agnes/v1/daemon.notice', 'params', {
        kind: 'invalid-event',
        detail: {},
        at: '1970-01-01T00:00:00.000Z',
      }).ok,
    ).toBe(false)
  })
})
