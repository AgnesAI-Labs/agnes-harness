import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { HostSession } from '@agnes/host'
import type { UITimeline } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { diffUITimeline } from '../src/local/methods/agnes.js'
import { RegistryLister, SessionRegistry } from '../src/local/sessions.js'
import { openTestHost, say } from './host.js'

const caps = {
  fs: { readTextFile: false, writeTextFile: false },
  _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
}
const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: caps,
    _meta: { 'ai.agnes.harness': { clientId: 'cli-test' } },
  },
}

describe('session extras: budget, projectUI (real, per the 2026-09-10 revision notes)', () => {
  it('budget keeps sparse ledger rows in chronological order and a nullable state', async () => {
    const h = await openTestHost({ script: [say('hello')] })
    const _host = h.host
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    void (async () => {
      for await (const _ of ep.notifications) {
        /* drain */
      }
    })()
    await ep.handle(init)
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    // No prompt yet: the ledger has no cost/ledger rows and no budget.state row either. state must be
    // null, not a thrown error and not a fabricated zero-valued object - the 2026-09-10 note's "状态
    // 寄存器是最近预检快照, 不冒称最新会话总额" half of the contract.
    const before = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.budget',
      params: { sessionId },
    })) as { result: { state: unknown; ledger: unknown[] } }
    expect(before.result.state).toBeNull()
    expect(before.result.ledger).toEqual([])
    await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })
    const after = (await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/session.budget',
      params: { sessionId },
    })) as {
      result: { state: unknown; ledger: Array<{ seq: number; creditSource: string; purpose: string }> }
    }
    expect(Array.isArray(after.result.ledger)).toBe(true)
    expect(after.result.ledger.length).toBeGreaterThan(0)
    // Chronological, not storage order: scan() reads the type-filtered window newest-first (so a
    // sparse ledger deep in a long session is not lost to an unfiltered last-N-events window), and the
    // handler must reverse it back before answering.
    const seqs = after.result.ledger.map((r) => r.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    for (const row of after.result.ledger) {
      expect(typeof row.creditSource).toBe('string')
      expect(typeof row.purpose).toBe('string')
    }
    await ep.close()
    await h.close()
  })

  it("projectUI stamps the registry generation onto core's CoreUITimeline and preserves upto=0", async () => {
    const h = await openTestHost({ script: [say('hello'), say('again')] })
    const host = h.host
    const createSession = host.createSession.bind(host)
    let fullProjectionCalls = 0
    let incrementalProjectionCalls = 0
    vi.spyOn(host, 'createSession').mockImplementation(async (opts) => {
      const session = await createSession(opts)
      const full = session.projectUI.bind(session)
      const incremental = session.projectUIPatch.bind(session)
      session.projectUI = (upto, options) => {
        fullProjectionCalls += 1
        return options ? full(upto, options) : full(upto)
      }
      session.projectUIPatch = (after, upto, options) => {
        incrementalProjectionCalls += 1
        return options ? incremental(after, upto, options) : incremental(after, upto)
      }
      return session
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    void (async () => {
      for await (const _ of ep.notifications) {
        /* drain */
      }
    })()
    await ep.handle(init)
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })
    const ui = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.projectUI',
      params: { sessionId, surface: 'tui' },
    })) as { result: { nodes: unknown[]; generation: number; upto: number } }
    expect(ui.result.nodes.length).toBeGreaterThan(0)
    // core's projectUI() returns CoreUITimeline, which has no `generation` field at all - this is the
    // daemon-side addition the 2026-09-10 note requires, read from the registry entry, not invented.
    expect(ui.result.generation).toBe(1)
    const fullCallsAtBaseline = fullProjectionCalls
    const unchanged = (await ep.handle({
      jsonrpc: '2.0',
      id: 41,
      method: '_agnes/v1/session.projectUIPatch',
      params: { sessionId, after: ui.result.upto, surface: 'tui' },
    })) as { result: { kind: string; patch: { from: number; upto: number; changes: unknown[] } } }
    expect(unchanged.result).toMatchObject({
      kind: 'patch',
      patch: { from: ui.result.upto, upto: ui.result.upto, changes: [] },
    })
    expect(incrementalProjectionCalls).toBe(1)
    expect(fullProjectionCalls).toBe(fullCallsAtBaseline)
    await ep.handle({
      jsonrpc: '2.0',
      id: 43,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'again' }] },
    })
    const changed = (await ep.handle({
      jsonrpc: '2.0',
      id: 44,
      method: '_agnes/v1/session.projectUIPatch',
      params: { sessionId, after: ui.result.upto, surface: 'tui' },
    })) as { result: { kind: string; patch: { from: number; upto: number; changes: unknown[] } } }
    expect(changed.result.kind).toBe('patch')
    expect(changed.result.patch.from).toBe(ui.result.upto)
    expect(changed.result.patch.upto).toBeGreaterThan(ui.result.upto)
    expect(changed.result.patch.changes.length).toBeGreaterThan(0)
    expect(incrementalProjectionCalls).toBe(2)
    expect(fullProjectionCalls).toBe(fullCallsAtBaseline)
    const caughtUp = (await ep.handle({
      jsonrpc: '2.0',
      id: 45,
      method: '_agnes/v1/session.projectUIPatch',
      params: { sessionId, after: changed.result.patch.upto, surface: 'tui' },
    })) as { result: { kind: string; patch: { from: number; upto: number; changes: unknown[] } } }
    expect(caughtUp.result).toMatchObject({
      kind: 'patch',
      patch: {
        from: changed.result.patch.upto,
        upto: changed.result.patch.upto,
        changes: [],
      },
    })
    expect(incrementalProjectionCalls).toBe(3)
    expect(fullProjectionCalls).toBe(fullCallsAtBaseline)
    const cacheMiss = (await ep.handle({
      jsonrpc: '2.0',
      id: 42,
      method: '_agnes/v1/session.projectUIPatch',
      params: { sessionId, after: 0, surface: 'tui' },
    })) as { result: { kind: string; timeline: { upto: number } } }
    expect(cacheMiss.result).toMatchObject({
      kind: 'replace',
      timeline: { upto: changed.result.patch.upto },
    })
    // upto=0 is a legal projection bound (the empty prefix), not "no bound given"; it must survive and
    // not be coerced away by a falsy check.
    const empty = (await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/session.projectUI',
      params: { sessionId, upto: 0 },
    })) as { result: { nodes: unknown[]; upto: number } }
    expect(empty.result.upto).toBe(0)
    expect(empty.result.nodes).toEqual([])
    const invalid = await ep.handle({
      jsonrpc: '2.0',
      id: 6,
      method: '_agnes/v1/session.projectUI',
      params: { sessionId, upto: -1 },
    })
    expect(invalid).toMatchObject({ error: { code: -32602 } })
    await ep.close()
    await h.close()
  })

  it('bounds opening payloads and pages an HMAC-bound stable cut without duplicate nodes', async () => {
    const h = await openTestHost()
    const createSession = h.host.createSession.bind(h.host)
    let opened: HostSession | undefined
    vi.spyOn(h.host, 'createSession').mockImplementation(async (opts) => {
      const created = await createSession(opts)
      opened ??= created
      return created
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const created = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    if (!opened) throw new Error('session was not captured')
    await opened.append(
      Array.from({ length: 299 }, (_, index) =>
        opened?.ev('user/message', {
          content: [{ type: 'text', text: `${index + 1}:${'x'.repeat(700)}` }],
        }),
      ).filter((event): event is NonNullable<typeof event> => event !== undefined),
    )
    await opened.enqueue('next-turn', {
      actor: opened.d.actor,
      content: [{ type: 'text', text: `300:${'x'.repeat(700)}` }],
      kind: 'prompt',
    })
    expect(await opened.acceptInput()).toBe(true)
    await opened.endTurn('completed')
    const [completedTurn] = await opened.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    if (!completedTurn) throw new Error('missing completed turn boundary')
    const forkBoundary = completedTurn.seq

    const forked = await ep.handle({
      jsonrpc: '2.0',
      id: 21,
      method: '_agnes/v1/session.fork',
      params: {
        sessionId: created.result.sessionId,
        at: forkBoundary,
        childKey: 'agnes:fork:history-boundary-child',
      },
    })
    expect(forked).toMatchObject({ result: { sessionId: 'agnes:fork:history-boundary-child' } })

    const maxBytes = 16 * 1024
    const openingResponse = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId: created.result.sessionId, surface: 'tui', maxNodes: 200, maxBytes },
    })) as {
      result: {
        timeline: UITimeline
        history: { hasEarlier: boolean; cursor?: string; startIndex: number; totalNodes: number }
      }
    }
    expect(Buffer.byteLength(JSON.stringify(openingResponse.result), 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(openingResponse.result.history).toMatchObject({ hasEarlier: true, totalNodes: 300 })
    expect(openingResponse.result.timeline.nodes.length).toBeLessThan(200)
    expect(openingResponse.result.history.startIndex + openingResponse.result.timeline.nodes.length).toBe(300)
    expect(openingResponse.result.timeline.turns).toHaveLength(1)
    expect(openingResponse.result.timeline.turns[0]).toMatchObject({
      endSeq: forkBoundary,
      status: 'completed',
      nodeIds: expect.any(Array),
    })
    expect(openingResponse.result.timeline.turns[0]?.nodeIds).toHaveLength(300)
    const stableCut = openingResponse.result.timeline.upto
    const firstCursor = openingResponse.result.history.cursor
    if (!firstCursor) throw new Error('missing history cursor')

    await opened.append([
      opened.ev('user/message', { content: [{ type: 'text', text: 'newer than the captured cut' }] }),
    ])
    const patch = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.projectUIPatch',
      params: { sessionId: created.result.sessionId, surface: 'tui', after: stableCut },
    })) as { result: { kind: string; patch: { totalNodes?: number } } }
    expect(patch.result).toMatchObject({ kind: 'patch', patch: { totalNodes: 301 } })

    const seen = new Set(openingResponse.result.timeline.nodes.map((node) => node.id))
    let cursor: string | undefined = firstCursor
    let expectedEnd = openingResponse.result.history.startIndex
    while (cursor) {
      const response = (await ep.handle({
        jsonrpc: '2.0',
        id: 10 + seen.size,
        method: '_agnes/v1/session.projectUIHistory',
        params: { sessionId: created.result.sessionId, cursor, limit: 37, maxBytes },
      })) as {
        result: {
          cut: number
          nodes: UITimeline['nodes']
          turns: UITimeline['turns']
          hasEarlier: boolean
          cursor?: string
          startIndex: number
          totalNodes: number
        }
      }
      expect(Buffer.byteLength(JSON.stringify(response.result), 'utf8')).toBeLessThanOrEqual(maxBytes)
      expect(response.result).toMatchObject({ cut: stableCut, totalNodes: 300 })
      expect(response.result.startIndex + response.result.nodes.length).toBe(expectedEnd)
      expect(response.result.nodes.length).toBeGreaterThan(0)
      expect(response.result.turns).toHaveLength(1)
      expect(response.result.turns[0]).toMatchObject({ endSeq: forkBoundary, status: 'completed' })
      expect(response.result.turns[0]?.nodeIds).toHaveLength(300)
      expect(
        response.result.turns[0]?.nodeIds.some((id) => response.result.nodes.some((n) => n.id === id)),
      ).toBe(true)
      expect(response.result.startIndex).toBeLessThan(expectedEnd)
      expect(JSON.stringify(response.result.nodes)).not.toContain('newer than the captured cut')
      for (const node of response.result.nodes) {
        expect(seen.has(node.id)).toBe(false)
        seen.add(node.id)
      }
      expectedEnd = response.result.startIndex
      cursor = response.result.cursor
    }
    expect(expectedEnd).toBe(0)
    expect(seen.size).toBe(300)

    const tampered = `${firstCursor.slice(0, -1)}${firstCursor.endsWith('A') ? 'B' : 'A'}`
    const rejected = await ep.handle({
      jsonrpc: '2.0',
      id: 99,
      method: '_agnes/v1/session.projectUIHistory',
      params: { sessionId: created.result.sessionId, cursor: tampered },
    })
    expect(rejected).toMatchObject({ error: { code: -32602 } })

    const otherCwd = join(h.dataDir, 'history-other')
    mkdirSync(otherCwd)
    await h.addWorkspace(otherCwd)
    const other = (await ep.handle({
      jsonrpc: '2.0',
      id: 991,
      method: 'session/new',
      params: { cwd: otherCwd, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const crossSession = await ep.handle({
      jsonrpc: '2.0',
      id: 992,
      method: '_agnes/v1/session.projectUIHistory',
      params: { sessionId: other.result.sessionId, cursor: firstCursor },
    })
    expect(crossSession).toMatchObject({ error: { code: -32602 } })

    // A bounded baseline must never fall back to an unbounded replacement over the wire. The TUI
    // will answer this stable detail code by asking for a fresh bounded opening snapshot.
    const resync = await ep.handle({
      jsonrpc: '2.0',
      id: 100,
      method: '_agnes/v1/session.projectUIPatch',
      params: { sessionId: created.result.sessionId, surface: 'tui', after: 0 },
    })
    expect(resync).toMatchObject({
      error: { code: -32603, data: { code: 'UI_PROJECTION_RESYNC_REQUIRED' } },
    })

    await opened.append([
      opened.ev('user/message', { content: [{ type: 'text', text: 'z'.repeat(24 * 1024) }] }),
    ])
    const oversizedOpening = await ep.handle({
      jsonrpc: '2.0',
      id: 101,
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId: created.result.sessionId, surface: 'tui', maxNodes: 1, maxBytes },
    })
    expect(oversizedOpening).toMatchObject({
      error: { code: -32603, data: { code: 'UI_PROJECTION_NODE_TOO_LARGE' } },
    })

    await opened.append([
      opened.ev('user/message', { content: [{ type: 'text', text: 'small node after oversized history' }] }),
    ])
    const afterOversized = (await ep.handle({
      jsonrpc: '2.0',
      id: 102,
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId: created.result.sessionId, surface: 'tui', maxNodes: 1, maxBytes },
    })) as { result: { timeline: { upto: number }; history: { cursor?: string } } }
    const oversizedHistoryCursor = afterOversized.result.history.cursor
    if (!oversizedHistoryCursor) throw new Error('missing oversized history cursor')
    const oversizedHistory = await ep.handle({
      jsonrpc: '2.0',
      id: 103,
      method: '_agnes/v1/session.projectUIHistory',
      params: {
        sessionId: created.result.sessionId,
        cursor: oversizedHistoryCursor,
        limit: 1,
        maxBytes,
      },
    })
    expect(oversizedHistory).toMatchObject({
      error: { code: -32603, data: { code: 'UI_PROJECTION_NODE_TOO_LARGE' } },
    })

    // Evict this session's bounded baseline from the 32-entry LRU. A bounded-opening connection
    // must still fail closed with a resync request, never regress to an unbounded full replacement.
    const fillerSessions = [other.result.sessionId]
    for (let index = 0; index < 31; index += 1) {
      const cwd = join(h.dataDir, `history-baseline-${index}`)
      mkdirSync(cwd)
      await h.addWorkspace(cwd)
      const filler = (await ep.handle({
        jsonrpc: '2.0',
        id: 200 + index,
        method: 'session/new',
        params: { cwd, mcpServers: [] },
      })) as { result: { sessionId: string } }
      fillerSessions.push(filler.result.sessionId)
    }
    for (const [index, sessionId] of fillerSessions.entries()) {
      const baseline = await ep.handle({
        jsonrpc: '2.0',
        id: 300 + index,
        method: '_agnes/v1/session.projectUI',
        params: { sessionId, surface: 'tui' },
      })
      expect(baseline).not.toHaveProperty('error')
    }
    const afterEviction = await ep.handle({
      jsonrpc: '2.0',
      id: 400,
      method: '_agnes/v1/session.projectUIPatch',
      params: {
        sessionId: created.result.sessionId,
        surface: 'tui',
        after: afterOversized.result.timeline.upto,
      },
    })
    expect(afterEviction).toMatchObject({
      error: { code: -32603, data: { code: 'UI_PROJECTION_RESYNC_REQUIRED' } },
    })
    await ep.close()
    await h.close()
  })
})

describe('session extras: deterministic UI projection diff', () => {
  const timeline = (nodes: UITimeline['nodes'], upto: number): UITimeline => ({
    sessionId: 's',
    generation: 2,
    upto,
    opState: null,
    nodes,
    turns: [],
  })

  it('emits removals and position-stable or moved upserts without folding domain events', () => {
    const user = { kind: 'user' as const, id: 'u', seq: 1, content: [{ type: 'text' as const, text: 'hi' }] }
    const oldAssistant = {
      kind: 'assistant' as const,
      id: 'a',
      seq: 2,
      text: 'partial',
      streaming: true,
    }
    const removed = { kind: 'cost' as const, id: 'c', seq: 3, credits: 1, source: 'estimated' as const }
    const nextAssistant = { ...oldAssistant, text: 'done', streaming: false }
    const added = {
      kind: 'slot' as const,
      id: 's',
      seq: 4,
      fill: { slot: 'status.line' as const, extId: 'x', payload: 'ok' },
    }

    expect(
      diffUITimeline(timeline([user, oldAssistant, removed], 3), timeline([nextAssistant, user, added], 4)),
    ).toMatchObject({
      from: 3,
      upto: 4,
      changes: [
        { op: 'remove', id: 'c' },
        { op: 'upsert', index: 0, node: nextAssistant },
        { op: 'upsert', index: 1, node: user },
        { op: 'upsert', index: 2, node: added },
      ],
      turnChanges: [],
    })
  })
})

describe('session extras: RegistryLister (unit-level, independent of the RPC wire shape)', () => {
  // Exercises the class directly, against the same SessionRegistry createLocalEndpoint wires it
  // into as the default `cx.lister` - the `q`/`cursor` shape here is RegistryLister's own, not the
  // wire's (`_agnes/v1/session.list`'s handler in methods/agnes.ts translates between the two; see
  // its own describe block above for the RPC-level coverage, including the `cursor` -> `next` rename).
  it('lists every open session, newest key included, and pages with a cursor', async () => {
    const h = await openTestHost()
    const reg = new SessionRegistry(h.host, { clock: () => Date.now(), pollMs: 5 })
    const a = await reg.open({ cwd: h.dataDir })
    const b = await reg.open({ cwd: h.dataDir, key: `${a.key}:second` })
    const lister = new RegistryLister(reg)
    const all = await lister.list({})
    const ids = all.items.map((i) => i.sessionId)
    expect(ids).toContain(a.key)
    expect(ids).toContain(b.key)
    for (const item of all.items) {
      expect(typeof item.lastSeq).toBe('number')
      expect(item.generation).toBe(1)
      // Fixed 2026-09-10: the plan this was drafted from read `latest('session/start')`, which is not
      // one of core's six registers and always answers undefined. `preset` must be the live preset
      // name (SessionImpl.preset.name), not null for every row.
      expect(item.preset).toBe('standard')
    }
    const page1 = await lister.list({ limit: 1 })
    expect(page1.items).toHaveLength(1)
    expect(page1.cursor).toBe('1')
    const page2 = await lister.list({ limit: 1, cursor: page1.cursor as string })
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]?.sessionId).not.toBe(page1.items[0]?.sessionId)
    await reg.closeAll()
    await h.close()
  })
})

describe('session extras: list, preset/model switching and durable fork', () => {
  it('session.list pages every open session and round-trips the next cursor', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const {
      result: { sessionId: a },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    // sessionKey is a deterministic hash of (profile, actor, cwd) - a second session/new on the
    // same cwd would resolve to the same key and collide with the first instead of opening a second
    // session, so `b` needs a cwd of its own.
    const cwdB = join(h.dataDir, 'b')
    mkdirSync(cwdB)
    await h.addWorkspace(cwdB)
    const {
      result: { sessionId: b },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/new',
      params: { cwd: cwdB, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const all = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.list',
      params: {},
    })) as { result: { items: Array<{ sessionId: string; preset: string }>; next?: string } }
    const ids = all.result.items.map((i) => i.sessionId)
    expect(ids).toContain(a)
    expect(ids).toContain(b)
    for (const item of all.result.items) expect(item.preset).toBe('standard')
    // The wire's page-continuation field is `next` (PageSessionMeta), not RegistryLister's own
    // `cursor` - this proves the RPC handler renames it rather than forwarding it unchanged.
    const page1 = (await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/session.list',
      params: { limit: 1 },
    })) as { result: { items: Array<{ sessionId: string }>; next?: string } }
    expect(page1.result.items).toHaveLength(1)
    expect(typeof page1.result.next).toBe('string')
    const page2 = (await ep.handle({
      jsonrpc: '2.0',
      id: 6,
      method: '_agnes/v1/session.list',
      params: { limit: 1, cursor: page1.result.next },
    })) as { result: { items: Array<{ sessionId: string }> } }
    expect(page2.result.items).toHaveLength(1)
    expect(page2.result.items[0]?.sessionId).not.toBe(page1.result.items[0]?.sessionId)
    await ep.close()
    await h.close()
  })

  it('setPreset switches an allowed preset and rejects one outside presets.allowed', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    // 'standard' is the fixture host's own preset and is in the default profile's presets.allowed,
    // so host's validatePresetSwitch gate lets it through without this test knowing how the gate
    // itself is implemented.
    const ok = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.setPreset',
      params: { sessionId, preset: 'standard' },
    })
    expect(ok).toMatchObject({ result: { effectiveFromSeq: expect.any(Number) } })
    // Not in presets.allowed (the default template allows only 'standard') - validatePresetSwitch
    // throws E_PRESET_UNSUPPORTED, which mapCore collapses to the wire's PRESET_SWITCH_REJECTED /
    // -32008, the same code session/set_mode's own rejection path already used.
    const rejected = await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.setPreset',
      params: { sessionId, preset: 'minimal-rl' },
    })
    expect(rejected).toMatchObject({ error: { code: -32008 } })
    await ep.close()
    await h.close()
  })

  it('setModel switches to a published route/model pair and rejects one outside the route table', async () => {
    // openTestHost always passes a `script`, which makes the testkit install a ScriptedProvider
    // instead of the production buildProvider path - and the default ScriptedProvider's own model
    // list ('faux-1'/'faux') has nothing to do with the profile's declared `provider.routes` ('gw'
    // from host/testkit's fixture ROUTE). validateModelSwitch requires a route/model that is BOTH
    // declared (in the profile's route table) AND published (in provider.models()), so without this
    // override there is no route/model pair in this harness that could ever pass - a `models`
    // override is what makes the fixture provider actually publish what the fixture ROUTE declares.
    const provider = new ScriptedProvider({
      scripts: [say('hello')],
      models: [fakeModel({ id: 'm1', route: 'gw' })],
    })
    const h = await openTestHost({ provider })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    // The fixture profile declares gw/m1 and this provider publishes that same pair. Do not open a
    // private Host session merely to rediscover it: doing so creates an authoritative session fact
    // without endpoint ownership, which session/new must correctly refuse to claim afterwards.
    const route = 'gw'
    const model = 'm1'
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const ok = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.setModel',
      params: { sessionId, slot: 'primary', route, model },
    })
    expect(ok).toMatchObject({ result: { effectiveFromSeq: expect.any(Number) } })
    // Same route, a model id the provider never published under it - validateModelSwitch throws
    // E_MODEL_UNSUPPORTED, collapsed by mapCore to the same -32008.
    const rejected = await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.setModel',
      params: { sessionId, slot: 'primary', route, model: 'ghost' },
    })
    expect(rejected).toMatchObject({ error: { code: -32008 } })
    await ep.close()
    await h.close()
  })

  it('setYolo flips the session-wide approval bypass — no route table to reject against', async () => {
    const h = await openTestHost()
    const setSessionYolo = vi.fn(async () => undefined)
    Object.defineProperty(h.host, 'computerUse', {
      configurable: true,
      value: Object.freeze({
        status: () => ({ status: 'ready' }),
        setSessionYolo,
      }),
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const on = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.setYolo',
      params: { sessionId, enabled: true },
    })
    expect(on).toMatchObject({ result: { effectiveFromSeq: expect.any(Number) } })
    const live = h.host.kernel.sessions.get(sessionId)
    if (!live) throw new Error('missing live session')
    const [switchEvent] = await live.scan({ type: 'x/core/yolo-switch', order: 'desc', limit: 1 })
    expect(switchEvent).toMatchObject({
      actor: { id: 'local', org: 'local', role: 'owner' },
      data: { operatorId: 'local', sessionKey: sessionId, lane: 'main' },
    })
    expect(setSessionYolo).toHaveBeenCalledWith({ key: sessionId, lane: 'main' }, true)
    const off = await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.setYolo',
      params: { sessionId, enabled: false },
    })
    expect(off).toMatchObject({ result: { effectiveFromSeq: expect.any(Number) } })
    expect(setSessionYolo).toHaveBeenLastCalledWith({ key: sessionId, lane: 'main' }, false)
    await ep.close()
    await h.close()
  })

  it('rolls approval bypass back when the native Computer Use mode switch fails', async () => {
    const h = await openTestHost()
    const setSessionYolo = vi.fn(async (_session: unknown, enabled: boolean) => {
      if (enabled) throw new Error('injected driver switch failure')
    })
    Object.defineProperty(h.host, 'computerUse', {
      configurable: true,
      value: Object.freeze({ status: () => ({ status: 'ready' }), setSessionYolo }),
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const opened = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const response = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.setYolo',
      params: { sessionId: opened.result.sessionId, enabled: true },
    })
    expect(response).toHaveProperty('error')
    const live = h.host.kernel.sessions.get(opened.result.sessionId)
    expect(live?.yolo).toBe(false)
    expect(setSessionYolo.mock.calls.map((call) => call[1])).toEqual([true, false])
    await ep.close()
    await h.close()
  })

  it('setModel accepts and applies an optional thinking level, and rejects one the model does not support', async () => {
    const provider = new ScriptedProvider({
      scripts: [say('hello')],
      models: [fakeModel({ id: 'm1', route: 'gw', reasoning: true, thinkingLevelMap: { high: 'high' } })],
    })
    const h = await openTestHost({ provider })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const route = 'gw'
    const model = 'm1'
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const ok = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.setModel',
      params: { sessionId, slot: 'primary', route, model, thinking: 'high' },
    })
    expect(ok).toMatchObject({ result: { effectiveFromSeq: expect.any(Number) } })
    // Same route/model, a thinking level this model's thinkingLevelMap never declared - host's
    // widened validateModelSwitch throws E_MODEL_UNSUPPORTED, collapsed by mapCore to the same -32008.
    const rejected = await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.setModel',
      params: { sessionId, slot: 'primary', route, model, thinking: 'off' },
    })
    expect(rejected).toMatchObject({ error: { code: -32008 } })
    await ep.close()
    await h.close()
  })

  it('forks only at a completed projected turn and replays the same child for a stable submit key', async () => {
    const h = await openTestHost({ script: [say('parent answer'), say('child answer')] })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    await ep.handle(init)
    const {
      result: { sessionId },
    } = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'first' }] },
    })
    const projected = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.projectUI',
      params: { sessionId },
    })) as { result: { turns: Array<{ endSeq?: number; forkable: boolean }> } }
    const at = projected.result.turns[0]?.endSeq
    expect(projected.result.turns[0]).toMatchObject({ forkable: true, endSeq: expect.any(Number) })
    if (!at) throw new Error('missing completed turn boundary')
    const childKey = 'agnes:fork:test-child'
    const direct = await ep.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/session.fork',
      params: { sessionId, at, childKey },
    })
    expect(direct).toMatchObject({ result: { sessionId: childKey } })
    const submitted = await ep.handle({
      jsonrpc: '2.0',
      id: 6,
      method: '_agnes/v1/submit',
      params: {
        clientId: 'c',
        commandId: 'cmd-1',
        kind: 'fork',
        payload: { sessionId, at, childKey },
      },
    })
    expect(submitted).toMatchObject({ result: { result: { sessionId: childKey }, replayed: false } })
    const apis = (await ep.handle({
      jsonrpc: '2.0',
      id: 7,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as { result: { families: Array<{ methods: string[] }> } }
    expect(apis.result.families.flatMap((family) => family.methods)).toContain('_agnes/v1/session.fork')
    await ep.close()
    await h.close()
  })
})
