import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { HostSession } from '@agnes/host'
import type {
  EventEnvelope,
  SessionDeliverableSource,
  SessionDeliverablesResult,
  SessionReadToolDetailResult,
  UITimeline,
  UITurn,
} from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerToolRecordReads } from '../src/local/methods/tool-records.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
}

type Endpoint = ReturnType<Awaited<ReturnType<typeof openTestHost>>['endpoint']>
type Response<T> = { result?: T; error?: { code?: number; data?: { code?: string; reason?: string } } }
let nextId = 2
const rpc = async <T>(ep: Endpoint, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as Response<T>
const must = <T>(response: Response<T>): T => {
  if (!response.result) throw new Error(JSON.stringify(response))
  return response.result
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup() {
  const h = await openTestHost()
  const ep = h.endpoint({ pollMs: 5 })
  cleanup.push(() => h.close())
  cleanup.push(() => ep.close())
  await ep.handle(initialize)
  const sessionId = must(
    await rpc<{ sessionId: string }>(ep, 'session/new', { cwd: h.dataDir, mcpServers: [] }),
  ).sessionId
  const session = h.host.kernel.get(sessionId)
  if (!session) throw new Error('session missing')
  return { h, ep, session, sessionId }
}

const delivered = (name: string, description = '') => ({
  deliverables: [
    {
      name,
      description,
      ref: {
        uri: `artifact://sha256/${'b'.repeat(64)}`,
        sha256: 'b'.repeat(64),
        size: 3,
        mime: 'text/markdown',
      },
    },
  ],
  laneId: 'main',
  owner: 'agnes/deliverables',
  surfaceId: `card-${name}`,
})

/** Rows of one tool step: each entry is a call, optionally followed later by its result. */
function toolTurn(
  session: HostSession,
  turn: number,
  calls: Array<{ id: string; name?: string; structured?: unknown; result?: false }>,
  extra: { start?: Record<string, unknown>; end?: string; lane?: string } = {},
) {
  const lane = extra.lane ? { lane: extra.lane } : {}
  return [
    session.ev('turn/start', { turn, trigger: 'prompt', ...extra.start }, lane),
    session.ev('step/start', { turn, step: 1 }, lane),
    ...calls.map((call, ordinal) =>
      session.ev(
        'tool/call',
        {
          toolUseId: call.id,
          name: call.name ?? 'present',
          args: { files: [{ path: 'report.md' }] },
          ordinal,
        },
        lane,
      ),
    ),
    ...calls
      .filter((call) => call.result !== false)
      .map((call) =>
        session.ev(
          'tool/result',
          {
            toolUseId: call.id,
            content: [{ type: 'text', text: `Presented ${call.id}` }],
            ...(call.structured === undefined ? {} : { structured: call.structured }),
            isError: false,
            enforcement: { level: 'full', scope: [] },
            authz: { decisionId: `d-${call.id}` },
          },
          lane,
        ),
      ),
    session.ev('step/end', { turn, step: 1 }, lane),
    session.ev('turn/end', { reason: extra.end ?? 'completed', lastAssistantSeq: null }, lane),
  ]
}

/** What the Web derives today: the full projection, a tool-detail read per present node, its turn by seq. */
async function projected(ep: Endpoint, sessionId: string): Promise<SessionDeliverableSource[]> {
  const timeline = must(await rpc<UITimeline>(ep, '_agnes/v1/session.projectUI', { sessionId }))
  const turnOf = (turns: readonly UITurn[], seq: number) =>
    turns.find((turn) => seq >= turn.startSeq && (turn.endSeq === undefined || seq <= turn.endSeq))?.id
  const sources: SessionDeliverableSource[] = []
  for (const node of timeline.nodes) {
    if (node.kind !== 'tool' || node.name !== 'present' || !node.resultSeq) continue
    const chunks: Buffer[] = []
    for (let offset: number | null = 0; offset !== null; ) {
      const page: SessionReadToolDetailResult = must(
        await rpc<SessionReadToolDetailResult>(ep, '_agnes/v1/session.readToolDetail', {
          sessionId,
          callSeq: node.seq,
          resultSeq: node.resultSeq,
          offset,
        }),
      )
      chunks.push(Buffer.from(page.data, 'base64'))
      offset = page.nextOffset
    }
    const result = (
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result: { structured?: unknown } }
    ).result
    const turnId = turnOf(timeline.turns, node.seq)
    sources.push({
      callSeq: node.seq,
      resultSeq: node.resultSeq,
      toolUseId: node.toolUseId,
      ...(turnId ? { turnId } : {}),
      ...('structured' in result ? { structured: result.structured as never } : {}),
    })
  }
  return sources
}

/** Every page of the new read from `afterSeq`, merged by call the way an incremental reader keeps them. */
async function queried(ep: Endpoint, sessionId: string, afterSeq = 0, limit?: number) {
  const pages: SessionDeliverablesResult[] = []
  const merged = new Map<number, SessionDeliverableSource>()
  for (let next: number | undefined = afterSeq; next !== undefined; ) {
    const page: SessionDeliverablesResult = must(
      await rpc<SessionDeliverablesResult>(ep, '_agnes/v1/session.deliverables', {
        sessionId,
        afterSeq: next,
        ...(limit === undefined ? {} : { limit }),
      }),
    )
    pages.push(page)
    for (const item of page.items) merged.set(item.callSeq, item)
    next = page.nextAfterSeq
  }
  return { pages, sources: [...merged.values()].sort((a, b) => a.callSeq - b.callSeq) }
}

describe('session.deliverables', () => {
  it('equals the projection path for plain, pending, bare and surface-only presentations', async () => {
    const { ep, session, sessionId } = await setup()
    await session.append(
      toolTurn(session, 1, [
        { id: 'a', structured: delivered('a.md') },
        { id: 'read-1', name: 'read', structured: { lines: 2 } },
      ]),
    )
    await session.append(
      toolTurn(session, 2, [
        { id: 'pending', result: false },
        { id: 'bare' },
        { id: 'surface-only', structured: { surfaceId: 'card-legacy' } },
        { id: 'b', structured: delivered('b.md', 'second') },
      ]),
    )
    const expected = await projected(ep, sessionId)
    expect(expected.map((source) => source.toolUseId)).toEqual(['a', 'bare', 'surface-only', 'b'])
    const { pages, sources } = await queried(ep, sessionId)
    expect(sources).toEqual(expected)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ sessionId, upto: session.lastSeq })
    expect(pages[0]).not.toHaveProperty('nextAfterSeq')
    // One item per page still assembles the same set, each page ending where the next one starts.
    const paged = await queried(ep, sessionId, 0, 1)
    expect(paged.sources).toEqual(expected)
    expect(paged.pages.map((page) => page.items.length)).toEqual([1, 1, 1, 1])
    for (const page of paged.pages.slice(0, -1)) expect(page.nextAfterSeq).toBe(page.upto)
    expect(paged.pages.at(-1)?.upto).toBe(session.lastSeq)
  })

  it('equals the projection path across a continued turn, another lane and a fork', async () => {
    const { ep, h, session, sessionId } = await setup()
    const [, , parkedCallSeq] = (
      await session.append(toolTurn(session, 1, [{ id: 'parked', result: false }], { end: 'parked' }))
    ).seqs
    if (!parkedCallSeq) throw new Error('missing parked call')
    await session.append([
      session.ev('turn/start', {
        turn: 2,
        trigger: 'approval-resume',
        continues: { turn: 1, step: 1, toolUseId: 'parked' },
      }),
      session.ev('step/start', { turn: 2, step: 1 }),
      session.ev(
        'tool/result',
        {
          toolUseId: 'parked',
          content: [{ type: 'text', text: 'Presented parked' }],
          structured: delivered('parked.md'),
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'd-parked' },
        },
        { sourceEventSeqs: [parkedCallSeq] },
      ),
      session.ev('step/end', { turn: 2, step: 1 }),
      session.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ])
    await session.append(
      toolTurn(session, 1, [{ id: 'side', structured: delivered('side.md') }], { lane: 'side' }),
    )
    await session.append(toolTurn(session, 3, [{ id: 'main', structured: delivered('main.md') }]))
    const expected = await projected(ep, sessionId)
    expect(expected.map(({ toolUseId, turnId }) => [toolUseId, turnId])).toEqual([
      ['parked', 'turn:1'],
      ['main', 'turn:3'],
    ])
    expect((await queried(ep, sessionId)).sources).toEqual(expected)

    const at = session.lastSeq
    const childKey = 'agnes:fork:deliverables'
    expect(await rpc(ep, '_agnes/v1/session.fork', { sessionId, at, childKey })).toMatchObject({
      result: { sessionId: childKey },
    })
    const child = h.host.kernel.get(childKey)
    if (!child) throw new Error('fork missing')
    await child.append(toolTurn(child, 4, [{ id: 'own', structured: delivered('own.md') }]))
    const inherited = await projected(ep, childKey)
    expect(inherited.map(({ toolUseId, turnId }) => [toolUseId, turnId])).toEqual([
      ['parked', 'turn:1'],
      ['main', 'turn:3'],
      ['own', 'turn:4'],
    ])
    expect((await queried(ep, childKey)).sources).toEqual(inherited)
  })

  it('reads only main-lane tool and turn rows, and later pages only after the cut', async () => {
    const { ep, session, sessionId } = await setup()
    await session.append(toolTurn(session, 1, [{ id: 'a', structured: delivered('a.md') }]))
    await session.append([session.ev('user/message', { content: [{ type: 'text', text: 'between turns' }] })])
    const read: EventEnvelope[] = []
    const scan = session.scan.bind(session)
    session.scan = async (q) => {
      const rows = await scan(q)
      read.push(...rows)
      return rows
    }
    const first = must(
      await rpc<SessionDeliverablesResult>(ep, '_agnes/v1/session.deliverables', { sessionId }),
    )
    expect(first.items.map((item) => item.toolUseId)).toEqual(['a'])
    expect(read.length).toBeGreaterThan(0)
    expect(new Set(read.map((row) => row.type))).toEqual(
      new Set(['tool/call', 'tool/result', 'turn/start', 'turn/end']),
    )
    read.length = 0
    // Nothing new after the cut: no rows at all.
    expect(
      must(
        await rpc<SessionDeliverablesResult>(ep, '_agnes/v1/session.deliverables', {
          sessionId,
          afterSeq: first.upto,
        }),
      ),
    ).toEqual({ sessionId, upto: first.upto, items: [] })
    expect(read).toEqual([])
    const [, , callSeq, resultSeq] = (
      await session.append(toolTurn(session, 2, [{ id: 'b', structured: delivered('b.md') }]))
    ).seqs
    const next = must(
      await rpc<SessionDeliverablesResult>(ep, '_agnes/v1/session.deliverables', {
        sessionId,
        afterSeq: first.upto,
      }),
    )
    expect(next).toEqual({
      sessionId,
      upto: session.lastSeq,
      items: [{ callSeq, resultSeq, toolUseId: 'b', turnId: 'turn:2', structured: delivered('b.md') }],
    })
    expect(read.filter((row) => row.type.startsWith('tool/')).every((row) => row.seq > first.upto)).toBe(true)
  })

  it('cuts pages by bytes and refuses what one page cannot hold', async () => {
    const { ep, session, sessionId } = await setup()
    const large = (id: string, size: number) => ({
      id,
      structured: { ...delivered(`${id}.md`), note: 'x'.repeat(size) },
    })
    await session.append(
      toolTurn(session, 1, [large('a', 100_000), large('b', 100_000), large('c', 100_000)]),
    )
    const { pages, sources } = await queried(ep, sessionId)
    expect(sources.map((source) => source.toolUseId)).toEqual(['a', 'b', 'c'])
    expect(pages.map((page) => page.items.length)).toEqual([2, 1])
    for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(262_144)
    await session.append(toolTurn(session, 2, [large('huge', 300_000)]))
    expect(
      await rpc(ep, '_agnes/v1/session.deliverables', { sessionId, afterSeq: pages.at(-1)?.upto }),
    ).toMatchObject({ error: { data: { code: 'INVALID_PARAMS', reason: 'deliverable-too-large' } } })
  })

  it('refuses unknown sessions, out-of-range bounds and a cut past the ledger', async () => {
    const { ep, session, sessionId } = await setup()
    expect(await rpc(ep, '_agnes/v1/session.deliverables', { sessionId: 'missing' })).toHaveProperty(
      'error.data.code',
      'SESSION_NOT_FOUND',
    )
    for (const bounds of [{ afterSeq: -1 }, { afterSeq: 1.5 }, { limit: 0 }, { limit: 201 }, { cursor: 'x' }])
      expect(await rpc(ep, '_agnes/v1/session.deliverables', { sessionId, ...bounds })).toHaveProperty(
        'error.code',
        -32602,
      )
    expect(
      await rpc(ep, '_agnes/v1/session.deliverables', { sessionId, afterSeq: session.lastSeq + 1 }),
    ).toMatchObject({ error: { data: { code: 'INVALID_PARAMS', reason: 'after-seq-out-of-range' } } })
  })

  it('lets a worker-backed session read in the worker and keeps its refusals', async () => {
    const endpoint = new LocalEndpoint({ clock: () => 1, principalId: 'owner' })
    endpoint.conn.initialized = true
    const page = { upto: 9, items: [{ callSeq: 3, resultSeq: 5, toolUseId: 'p' }], nextAfterSeq: 9 }
    const readDeliverablesPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, page })
      .mockResolvedValueOnce({ ok: false, reason: 'after-seq-out-of-range' })
    const session = {
      readDeliverablesPage,
      scan: () => Promise.reject(new Error('the daemon must not read a worker ledger')),
    }
    const owners: string[] = []
    registerToolRecordReads(
      endpoint,
      { registry: { require: () => ({ session: session as never }) } },
      (method) => {
        owners.push(method)
      },
    )
    const call = (params: Record<string, unknown>) =>
      endpoint.handle({ jsonrpc: '2.0', id: nextId++, method: '_agnes/v1/session.deliverables', params })
    await expect(call({ sessionId: 's', afterSeq: 2, limit: 1 })).resolves.toMatchObject({
      result: { sessionId: 's', ...page },
    })
    await expect(call({ sessionId: 's' })).resolves.toMatchObject({
      error: { data: { code: 'INVALID_PARAMS', reason: 'after-seq-out-of-range' } },
    })
    expect(readDeliverablesPage.mock.calls).toEqual([
      [{ afterSeq: 2, limit: 1 }],
      [{ afterSeq: 0, limit: 100 }],
    ])
    expect(owners).toEqual(['session.deliverables', 'session.deliverables'])
  })

  it('is announced with the session reads', async () => {
    const { ep } = await setup()
    const listed = must(
      await rpc<{ families: Array<{ name: string; methods: string[] }> }>(ep, '_agnes/v1/apis.list', {}),
    )
    expect(listed.families.find((family) => family.name === 'session')?.methods).toContain(
      '_agnes/v1/session.deliverables',
    )
  })
})
