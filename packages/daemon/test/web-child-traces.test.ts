import type { HostSession } from '@agnes/host'
import type { UISpan, UITimeline, UITurn } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestHost } from './host.js'

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
    _meta: { 'ai.agnes.harness': { clientId: 'web-child-traces' } },
  },
}

afterEach(() => vi.restoreAllMocks())

const walk = (span: UISpan): UISpan[] => [span, ...span.children.flatMap(walk)]
const truncations = (turns: readonly UITurn[]) =>
  turns
    .flatMap((turn) => (turn.trace ? walk(turn.trace) : []))
    .filter((span) => span.error?.code === 'TRACE_TRUNCATED')

/**
 * A web session with 600 large messages, then a turn spawning a child whose trace is about 20k
 * spans (several MiB). Returns the endpoint and a counter of daemon-side result serializations.
 */
async function bigWebSession() {
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
  const parent = opened
  if (!parent) throw new Error('session was not captured')
  const create = parent.d.children.createWithKind
  if (!create) throw new Error('the child factory must create by kind')
  const handle = await create.call(parent.d.children, 'spawn', {
    parent: parent.key,
    cwd: h.dataDir,
    input: 'big',
  })
  const child = h.host.kernel.get(handle.key)
  if (!child) throw new Error('child session is not open')
  // Each child turn is one append; title calls add one span each and no per-call ledger state.
  for (let turn = 1; turn <= 1_000; turn += 1)
    await child.append([
      child.ev('turn/start', { turn, trigger: 'prompt' }),
      ...Array.from({ length: 19 }, (_, i) =>
        child.ev('cost/ledger', {
          purpose: 'title',
          effectId: `call-${turn}-${i}`,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          creditSource: 'estimated',
          model: `model-${i}-${'m'.repeat(60)}`,
          sourceTurn: turn,
        }),
      ),
      child.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ])
  for (let i = 0; i < 600; i += 200)
    await parent.append(
      Array.from({ length: 200 }, (_, j) =>
        parent.ev('user/message', { content: [{ type: 'text', text: `${i + j}:${'x'.repeat(2_000)}` }] }),
      ),
    )
  const toolUseId = 'spawn-big'
  await parent.append([
    parent.ev('turn/start', { turn: 1, trigger: 'prompt' }),
    parent.ev('step/start', { turn: 1, step: 1 }),
    parent.ev('tool/call', { toolUseId, name: 'subagent_spawn', args: { task: 'big' }, ordinal: 0 }),
    parent.ev('effect/intent', {
      effectId: `eff-${toolUseId}`,
      kind: 'tool',
      replay: 'never',
      tool: { toolUseId, name: 'subagent_spawn' },
    }),
    parent.ev('effect/settled', { effectId: `eff-${toolUseId}`, outcome: 'ok', durationMs: 7 }),
    parent.ev('tool/result', {
      toolUseId,
      content: [{ type: 'text', text: `spawned ${handle.key}` }],
      structured: { childKey: handle.key },
      isError: false,
      enforcement: { level: 'full', scope: ['process'] },
      authz: { decisionId: `d-${toolUseId}` },
    }),
    parent.ev('step/end', { turn: 1, step: 1 }),
    parent.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
  ])

  // Counts only the daemon's own whole-result serializations in its trim loops.
  const stringify = JSON.stringify
  const serialized = { opening: 0, history: 0 }
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
    if (value && typeof value === 'object') {
      if ('timeline' in value && 'history' in value) serialized.opening += 1
      else if ('cut' in value && 'nodes' in value && 'turns' in value && 'generation' in value)
        serialized.history += 1
    }
    return (stringify as (...args: unknown[]) => string)(value, ...rest)
  }) as typeof JSON.stringify)
  return { ep, sessionId: created.result.sessionId, serialized }
}

describe('web projections of a session with a huge child trace', () => {
  it('fit the opening and a history page on the first daemon serialization, truncated', async () => {
    const { ep, sessionId, serialized } = await bigWebSession()
    const maxBytes = 1024 * 1024
    const opening = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId, surface: 'web', maxNodes: 500, maxBytes },
    })) as {
      result?: { timeline: UITimeline; history: { hasEarlier: boolean; cursor?: string } }
      error?: unknown
    }
    expect(opening.error).toBeUndefined()
    expect(serialized.opening).toBe(1)
    const result = opening.result
    if (!result) throw new Error('missing opening result')
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(truncations(result.timeline.turns).length).toBeGreaterThan(0)
    expect(result.history.hasEarlier).toBe(true)

    const history = (await ep.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/session.projectUIHistory',
      params: { sessionId, cursor: result.history.cursor, limit: 200, maxBytes },
    })) as { result?: { nodes: unknown[]; turns: UITurn[] }; error?: unknown }
    expect(history.error).toBeUndefined()
    expect(serialized.history).toBe(1)
    expect(history.result?.nodes.length).toBeGreaterThan(0)
    // The earlier messages belong to the spawning turn, so the page carries its truncated trace too.
    expect(truncations(history.result?.turns ?? []).length).toBeGreaterThan(0)
  }, 60_000)
})

describe('web patches of a session with many children', () => {
  it('turn an oversized re-send into a resync instead of a large patch', async () => {
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
    const sessionId = created.result.sessionId
    const parent = opened
    if (!parent) throw new Error('session was not captured')
    const create = parent.d.children.createWithKind
    if (!create) throw new Error('the child factory must create by kind')
    const storage = parent.d.log.storage as unknown as {
      lookupByKey(key: string): Promise<{ stateRevision: number } | null>
      casState(key: string, revision: number, next: string): Promise<boolean>
    }
    // 30 children with about 15 KB of trace each, each spawned from its own parent turn. Each is
    // ended once written, which keeps the parent under its fan-out limit.
    for (let n = 1; n <= 30; n += 1) {
      const handle = await create.call(parent.d.children, 'spawn', {
        parent: parent.key,
        cwd: h.dataDir,
        input: `task ${n}`,
      })
      const child = h.host.kernel.get(handle.key)
      if (!child) throw new Error('child session is not open')
      await child.append([
        child.ev('turn/start', { turn: 1, trigger: 'prompt' }),
        ...Array.from({ length: 60 }, (_, i) =>
          child.ev('cost/ledger', {
            purpose: 'title',
            effectId: `call-${i}`,
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            creditSource: 'estimated',
            model: `model-${i}-${'m'.repeat(60)}`,
            sourceTurn: 1,
          }),
        ),
        child.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ])
      const record = await storage.lookupByKey(handle.key)
      if (!record || !(await storage.casState(handle.key, record.stateRevision, 'cancelled')))
        throw new Error('could not end the child')
      const toolUseId = `spawn-${n}`
      await parent.append([
        parent.ev('turn/start', { turn: n, trigger: 'prompt' }),
        parent.ev('step/start', { turn: n, step: 1 }),
        parent.ev('tool/call', {
          toolUseId,
          name: 'subagent_spawn',
          args: { task: `task ${n}` },
          ordinal: 0,
        }),
        parent.ev('effect/intent', {
          effectId: `eff-${toolUseId}`,
          kind: 'tool',
          replay: 'never',
          tool: { toolUseId, name: 'subagent_spawn' },
        }),
        parent.ev('effect/settled', { effectId: `eff-${toolUseId}`, outcome: 'ok', durationMs: 7 }),
        parent.ev('tool/result', {
          toolUseId,
          content: [{ type: 'text', text: `spawned ${handle.key}` }],
          structured: { childKey: handle.key },
          isError: false,
          enforcement: { level: 'full', scope: ['process'] },
          authz: { decisionId: `d-${toolUseId}` },
        }),
        parent.ev('step/end', { turn: n, step: 1 }),
        parent.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ])
    }
    const open = async (id: number) =>
      (
        (await ep.handle({
          jsonrpc: '2.0',
          id,
          method: '_agnes/v1/session.projectUIOpening',
          params: { sessionId, surface: 'web', maxNodes: 2, maxBytes: 1024 * 1024 },
        })) as { result: { timeline: UITimeline } }
      ).result.timeline.upto
    const patch = async (id: number, after: number) =>
      (await ep.handle({
        jsonrpc: '2.0',
        id,
        method: '_agnes/v1/session.projectUIPatch',
        params: { sessionId, surface: 'web', after },
      })) as { result?: unknown; error?: { data?: { code?: string } } }
    const poke = (text: string) =>
      parent.append([parent.ev('user/message', { content: [{ type: 'text', text }] })])

    // The opening folded every child at its own head, so each owner turn is due to be sent once
    // more: about 450 KB, over one projection page. The patch becomes a resync.
    const first = await open(3)
    await poke('poke')
    const resync = await patch(4, first)
    expect(resync.error?.data?.code).toBe('UI_PROJECTION_RESYNC_REQUIRED')

    // The reopen sees no child change since; the next patch is small.
    const second = await open(5)
    await poke('again')
    const next = await patch(6, second)
    expect(next.error).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(next.result), 'utf8')).toBeLessThan(16 * 1024)
  }, 60_000)
})
