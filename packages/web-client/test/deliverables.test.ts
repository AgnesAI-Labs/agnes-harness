import { createHash } from 'node:crypto'
import { Context } from '@agnes/cordis'
import type { UITimeline, UiSurfaceRecord } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { expect, it, vi } from 'vitest'
import {
  type DeliverableRecord,
  DeliverablesStore,
  deliveredFiles,
  groupDeliveredFiles,
  surfaceDeliverables,
} from '../src/deliverables.js'
import { SessionService } from '../src/services-session.js'

const artifact = { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' }
const file = { name: 'report.txt', description: 'final', ref: artifact }
const turns = [{ id: 'turn', startSeq: 1, endSeq: 20 }] as UITimeline['turns']
const record = {
  lane: 'main',
  owner: 'agnes/deliverables',
  createdSeq: 5,
  surface: {
    id: 'card',
    revision: 1,
    placement: { inline: true, workbench: true },
    components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
    data: { 'file-0': { name: file.name, description: file.description, artifact } },
  },
} as unknown as UiSurfaceRecord

it('validates full artifact identities and preserves same-byte files under distinct names and snapshot history', () => {
  expect(deliveredFiles([{ ...file, ref: { ...artifact, sha256: '../../secret' } }])).toEqual([])
  const first = surfaceDeliverables('session', record, turns)[0]!
  expect(first).toMatchObject({
    turnId: 'turn',
    sessionId: 'session',
    laneId: 'main',
    source: { owner: 'agnes/deliverables' },
  })
  const second = { ...first, id: 'v2', seq: 9, artifact: { ...artifact, sha256: 'b'.repeat(64) } }
  const renamed = { ...first, id: 'other', name: 'other.txt' }
  const groups = groupDeliveredFiles([first, renamed, second, { ...second, id: 'repeat', seq: 10 }])
  expect(groups.map((group) => group.latest.id)).toEqual(['repeat', 'other'])
  expect(groups[0]?.earlier.map((entry) => entry.artifact.sha256)).toEqual([artifact.sha256])
})

it('recovers durable plain files when Intelligent UI is disabled, refreshes on restart and ignores stale session reads', async () => {
  const ctx = new Context()
  const selected = new SessionService(ctx, 's1')
  const notifications = new Set<(...args: never[]) => void>()
  const lifecycle = new Map<string, () => void>()
  let admitted = false
  const detail = vi.fn(async () => ({
    result: { structured: { deliverables: [file], laneId: 'main', owner: 'agnes/deliverables' } },
  }))
  const presented = [{ kind: 'tool', name: 'present', seq: 3, resultSeq: 6, toolUseId: 'call' }]
  const handle = {
    id: 's1',
    listeners: notifications,
    projectUI: async () => {
      if (!admitted) throw new Error('SESSION_NOT_FOUND')
      return { turns, nodes: [...presented] }
    },
    uiRead: async () => {
      throw new Error('provider disabled')
    },
    readToolDetail: detail,
  }
  const client = {
    sessions: { get: () => handle },
    on: (name: string, listener: () => void) => {
      lifecycle.set(name, listener)
      return () => lifecycle.delete(name)
    },
  } as unknown as Client
  // A cold browser can mount the role from a history preview before admission completes.
  selected.setSession('s1', 'history-only')
  const store = new DeliverablesStore(client, selected)
  await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
  expect(store.getSnapshot().files).toEqual([])
  selected.setSession('s1', 'connecting')
  admitted = true
  selected.setReadiness('ready')
  await vi.waitFor(() => expect(store.getSnapshot().files).toHaveLength(1))
  expect(store.getSnapshot().files[0]).toMatchObject({ artifact, turnId: 'turn', source: { callSeq: 3 } })
  let beginRead!: () => void
  const entered = new Promise<void>((resolve) => {
    beginRead = resolve
  })
  let finishRead!: (value: Awaited<ReturnType<typeof detail>>) => void
  const late = new Promise<Awaited<ReturnType<typeof detail>>>((resolve) => {
    finishRead = resolve
  })
  detail.mockImplementationOnce(() => {
    beginRead()
    return late
  })
  // Settled results are read once; a later present result is the read in flight across the epoch.
  presented.push({ kind: 'tool', name: 'present', seq: 7, resultSeq: 8, toolUseId: 'later' })
  const pending = store.refresh()
  await entered
  selected.setReadiness('connecting')
  expect(store.getSnapshot().files).toEqual([])
  let stalePublished = false
  const stop = store.subscribe(() => {
    stalePublished ||= store.getSnapshot().files.some((entry) => entry.name === 'stale.txt')
  })
  selected.setReadiness('ready')
  presented.pop()
  finishRead({
    result: {
      structured: {
        deliverables: [{ ...file, name: 'stale.txt' }],
        laneId: 'main',
        owner: 'agnes/deliverables',
      },
    },
  })
  await pending
  expect(stalePublished).toBe(false)
  expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['report.txt'])
  stop()
  // Reconstructing the reader after restart uses the saved result, not a browser cache or source path.
  store.dispose()
  expect(notifications.size).toBe(0)
  const restored = new DeliverablesStore(client, selected)
  await vi.waitFor(() => expect(restored.getSnapshot().files).toHaveLength(1))
  lifecycle.get('reconnected')?.()
  await restored.refresh()
  selected.setSession(undefined)
  expect(restored.getSnapshot().files).toEqual([])
  restored.dispose()
  expect(lifecycle.size).toBe(0)
})

it.each([false, true])(
  'recovers paginated or closed historical surfaces and merges enhanced copies (closed=%s)',
  async (closed) => {
    const ctx = new Context(),
      selected = new SessionService(ctx, 's')
    const read = vi.fn(async (params: { cursor?: string; surfaceId?: string } = {}) => ({
      surfaces: params.surfaceId || (!closed && !params.cursor) ? [record] : [],
      ...(params.cursor || params.surfaceId ? {} : { nextCursor: 'next' }),
    }))
    const client = {
      on: () => () => {},
      sessions: {
        get: () => ({
          id: 's',
          listeners: new Set(),
          projectUI: async () => ({
            turns,
            nodes: [{ kind: 'tool', name: 'present', seq: 3, resultSeq: 6, toolUseId: 'call' }],
          }),
          uiRead: read,
          readToolDetail: async () => ({
            result: { structured: { ...(closed ? {} : { deliverables: [file] }), surfaceId: 'card' } },
          }),
        }),
      },
    } as unknown as Client
    selected.setReadiness('ready')
    const store = new DeliverablesStore(client, selected)
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
    expect(read.mock.calls.map(([params]) => params)).toEqual(
      closed ? [{}, { cursor: 'next' }, { surfaceId: 'card' }] : [{}, { cursor: 'next' }],
    )
    expect(store.getSnapshot().files).toHaveLength(1)
    store.dispose()
  },
)

type Node = UITimeline['nodes'][number]
type Turn = UITimeline['turns'][number]
const at = '2026-10-01T00:00:00.000Z'
const turnOf = (n: number, startSeq: number, endSeq?: number) =>
  ({
    id: `turn-${n}`,
    turn: n,
    startSeq,
    ...(endSeq ? { endSeq } : {}),
    startedAt: at,
    status: endSeq ? 'completed' : 'running',
    nodeIds: [],
  }) as unknown as Turn
const said = (seq: number) => ({ kind: 'assistant', id: `a${seq}`, seq, text: 'x'.repeat(400) }) as Node
const present = (seq: number, toolUseId: string, resultSeq?: number) =>
  ({
    kind: 'tool',
    id: `t${seq}`,
    seq,
    name: 'present',
    toolUseId,
    ...(resultSeq ? { resultSeq } : {}),
  }) as Node
const surfaceOf = (id: string, createdSeq: number, name: string, extra: Record<string, unknown> = {}) =>
  ({
    lane: 'side',
    owner: 'agnes/deliverables',
    createdSeq,
    surface: {
      id,
      revision: 1,
      placement: { inline: false, workbench: true },
      components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
      data: { 'file-0': { name, description: 'surface copy', artifact }, ...extra },
    },
  }) as unknown as UiSurfaceRecord

/** Core-style patch: removals, then upserts from the first differing position. */
const diff = <T extends { id: string }>(before: readonly T[], after: readonly T[], key: 'node' | 'turn') => {
  const kept = new Set(after.map((item) => item.id))
  let first = 0
  while (first < after.length && JSON.stringify(before[first]) === JSON.stringify(after[first])) first++
  return [
    ...before.filter((item) => !kept.has(item.id)).map((item) => ({ op: 'remove' as const, id: item.id })),
    ...after
      .slice(first)
      .map((item, offset) => ({ op: 'upsert' as const, index: first + offset, [key]: item })),
  ]
}

const filedUnder = (turns: readonly Turn[], seq: number) =>
  turns.find((turn) => seq >= turn.startSeq && (turn.endSeq === undefined || seq <= turn.endSeq))?.id

/** One session ledger. Each connect() is one daemon connection with its own projection baseline. */
function ledger(id = 's', pageSize = 100) {
  const head = { sessionId: id, generation: 1, upto: 1, opState: null, nodes: [], turns: [] } as UITimeline
  const results = new Map<string, Record<string, unknown>>()
  const surfaces: { open: boolean; record: UiSurfaceRecord }[] = []
  const connect = () => {
    let served: UITimeline | undefined
    const bytes = { full: 0, patch: 0, query: 0 }
    const send = <T>(kind: keyof typeof bytes, value: T): T => {
      bytes[kind] += JSON.stringify(value).length
      return structuredClone(value)
    }
    return {
      id,
      bytes,
      listeners: new Set<() => void>(),
      projectUI: vi.fn(async () => {
        served = structuredClone(head)
        return send('full', head)
      }),
      projectUIPatch: vi.fn(async (after: number) => {
        if (served?.upto !== after || served.generation !== head.generation) {
          served = structuredClone(head)
          return send('full', { kind: 'replace', timeline: head })
        }
        const patch = {
          sessionId: id,
          generation: head.generation,
          from: after,
          upto: head.upto,
          opState: null,
          changes: diff(served.nodes, head.nodes, 'node'),
          turnChanges: diff(served.turns, head.turns, 'turn'),
        }
        served = structuredClone(head)
        return send('patch', { kind: 'patch', patch })
      }),
      readToolDetail: vi.fn(async (callSeq: number, resultSeq?: number) => ({
        result: { structured: results.get(`${head.generation}:${callSeq}:${resultSeq}`) },
      })),
      // The daemon's present sources: results after the cut in result order, turn by call seq.
      deliverables: vi.fn(async ({ afterSeq = 0 }: { afterSeq?: number; limit?: number } = {}) => {
        const items = head.nodes
          .flatMap((node) =>
            node.kind === 'tool' && node.name === 'present' && node.resultSeq && node.resultSeq > afterSeq
              ? [{ ...node, resultSeq: node.resultSeq }]
              : [],
          )
          .sort((a, b) => a.resultSeq - b.resultSeq)
          .map((node) => {
            const structured = results.get(`${head.generation}:${node.seq}:${node.resultSeq}`)
            const turnId = filedUnder(head.turns, node.seq)
            return {
              callSeq: node.seq,
              resultSeq: node.resultSeq,
              toolUseId: node.toolUseId,
              ...(turnId ? { turnId } : {}),
              ...(structured === undefined ? {} : { structured }),
            }
          })
        const page = items.slice(0, pageSize)
        const last = page.at(-1)
        return send(
          'query',
          page.length < items.length && last
            ? { sessionId: id, upto: last.resultSeq, items: page, nextAfterSeq: last.resultSeq }
            : { sessionId: id, upto: head.upto, items: page },
        )
      }),
      uiRead: vi.fn(async ({ surfaceId }: { cursor?: string; surfaceId?: string } = {}) => ({
        surfaces: surfaces
          .filter((entry) => (surfaceId ? entry.record.surface.id === surfaceId : entry.open))
          .map((entry) => entry.record),
      })),
    }
  }
  const commit = (change: (timeline: UITimeline) => void) => {
    change(head)
    head.upto += 1
  }
  return { head, results, surfaces, connect, commit }
}
type Connection = ReturnType<ReturnType<typeof ledger>['connect']>

function mountWith(apis: (() => Promise<unknown>) | undefined, connections: Connection[]) {
  const selected = new SessionService(new Context(), connections[0]?.id)
  const lifecycle = new Map<string, () => void>()
  const client = {
    sessions: { get: (id: string) => connections.find((connection) => connection.id === id) },
    on: (name: string, listener: () => void) => {
      lifecycle.set(name, listener)
      return () => lifecycle.delete(name)
    },
    ...(apis ? { apis } : {}),
  } as unknown as Client
  selected.setReadiness('ready')
  return { store: new DeliverablesStore(client, selected), selected, lifecycle }
}
function mount(...connections: [Connection, ...Connection[]]) {
  return mountWith(undefined, connections)
}
/** A daemon whose apis.list announces session.deliverables beside the other session reads. */
function offering(
  connection: Connection,
  methods = ['_agnes/v1/session.projectUI', '_agnes/v1/session.deliverables'],
) {
  const apis = vi.fn(async () => ({ families: [{ name: 'session', methods }] }))
  return { apis, mounted: () => mountWith(apis, [connection]) }
}
const loaded = async (store: DeliverablesStore) => {
  await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
  return store.getSnapshot().files
}
/** The records a freshly mounted reader derives from one full projection of the current ledger. */
const fullRead = async (source: ReturnType<typeof ledger>) => {
  const { store } = mount(source.connect())
  const files = await loaded(store)
  store.dispose()
  return files
}
const seeded = () => {
  const source = ledger()
  source.commit((timeline) => {
    timeline.turns.push(turnOf(1, 1, 400))
    for (let seq = 2; seq < 300; seq++) timeline.nodes.push(said(seq))
    timeline.nodes.push(present(300, 'first', 301))
  })
  source.results.set('1:300:301', { deliverables: [file] })
  return source
}

it('keeps one full projection per baseline and reads each present result once', async () => {
  const source = seeded()
  const connection = source.connect()
  const { store } = mount(connection)
  expect(await loaded(store)).toEqual(await fullRead(source))
  const firstBytes = connection.bytes.full
  source.commit((timeline) => {
    timeline.turns.push(turnOf(2, 401))
    timeline.nodes.push(said(402), present(403, 'second'))
  })
  await store.refresh()
  source.commit((timeline) => {
    timeline.nodes[timeline.nodes.length - 1] = present(403, 'second', 404)
    timeline.turns[1] = turnOf(2, 401, 405)
  })
  source.results.set('1:403:404', { deliverables: [{ ...file, name: 'second.txt' }], laneId: 'side' })
  await store.refresh()
  await store.refresh()
  expect(store.getSnapshot().files).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => [entry.name, entry.turnId])).toEqual([
    ['report.txt', 'turn-1'],
    ['second.txt', 'turn-2'],
  ])
  // A call whose result position changes is read again.
  source.commit((timeline) => {
    timeline.nodes[timeline.nodes.length - 1] = present(403, 'second', 406)
  })
  source.results.set('1:403:406', { deliverables: [{ ...file, name: 'second-v2.txt' }] })
  await store.refresh()
  expect(store.getSnapshot().files).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['report.txt', 'second-v2.txt'])
  expect(connection.projectUI).toHaveBeenCalledTimes(1)
  expect(connection.projectUIPatch).toHaveBeenCalledTimes(4)
  expect(connection.bytes.full).toBe(firstBytes)
  expect(connection.bytes.patch).toBeLessThan(firstBytes / 10)
  expect(connection.readToolDetail.mock.calls).toEqual([
    [300, 301],
    [403, 404],
    [403, 406],
  ])
  store.dispose()
})

it.each(['replace', 'resync', 'mismatch'] as const)(
  'recovers from a %s projection update with the same records',
  async (failure) => {
    const source = seeded()
    const connection = source.connect()
    const { store } = mount(connection)
    await loaded(store)
    source.commit((timeline) => {
      timeline.nodes.push(present(310, 'next', 311))
    })
    source.results.set('1:310:311', { deliverables: [{ ...file, name: 'next.txt' }] })
    // Another reader of the same projection on this connection moves the daemon's baseline.
    if (failure === 'replace') await connection.projectUI()
    if (failure === 'resync')
      connection.projectUIPatch.mockRejectedValueOnce(
        Object.assign(new Error('resync'), { data: { code: 'UI_PROJECTION_RESYNC_REQUIRED' } }),
      )
    if (failure === 'mismatch')
      connection.projectUIPatch.mockImplementationOnce(async (after: number) => ({
        kind: 'patch',
        patch: {
          sessionId: 's',
          generation: 1,
          from: after - 1,
          upto: after + 1,
          opState: null,
          changes: [],
          turnChanges: [],
        },
      }))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ loading: false, files: await fullRead(source) })
    expect(store.getSnapshot().error).toBeUndefined()
    expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['report.txt', 'next.txt'])
    // The replacement is the new baseline; a failed patch costs one full projection of our own.
    expect(connection.projectUI).toHaveBeenCalledTimes(2)
    expect(connection.projectUIPatch).toHaveBeenCalledTimes(1)
    source.commit((timeline) => {
      timeline.nodes.push(said(312))
    })
    await store.refresh()
    expect(connection.projectUI).toHaveBeenCalledTimes(2)
    expect(connection.projectUIPatch).toHaveBeenCalledTimes(2)
    expect(connection.readToolDetail).toHaveBeenCalledTimes(2)
    store.dispose()
  },
)

it('reports an unavailable projection without discarding the published records', async () => {
  const source = seeded()
  const connection = source.connect()
  const { store } = mount(connection)
  const files = await loaded(store)
  connection.projectUIPatch.mockRejectedValueOnce(new Error('closed'))
  connection.projectUI.mockRejectedValueOnce(new Error('closed'))
  await store.refresh()
  expect(store.getSnapshot()).toEqual({
    sessionId: 's',
    files,
    loading: false,
    error: 'Deliverables unavailable',
  })
  await store.refresh()
  expect(store.getSnapshot()).toEqual({ sessionId: 's', files, loading: false })
  store.dispose()
})

it.each(['reconnected', 'gap', 'generationChanged'] as const)(
  'starts from a full projection after %s',
  async (name) => {
    const source = seeded()
    const connection = source.connect()
    const { store, lifecycle } = mount(connection)
    await loaded(store)
    if (name === 'generationChanged') {
      // A rewritten ledger may reuse sequence numbers for different results.
      source.head.generation = 2
      source.results.set('2:300:301', { deliverables: [{ ...file, name: 'rewritten.txt' }] })
    }
    // The event lands while a patch is in flight; that answer must not become the new baseline.
    let release!: () => void
    connection.projectUIPatch.mockImplementationOnce(async (after: number) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        kind: 'patch',
        patch: {
          sessionId: 's',
          generation: 1,
          from: after,
          upto: after,
          opState: null,
          changes: [],
          turnChanges: [],
        },
      }
    })
    const pending = store.refresh()
    lifecycle.get(name)?.()
    release()
    await pending
    expect(connection.projectUI).toHaveBeenCalledTimes(2)
    await store.refresh()
    expect(connection.projectUIPatch).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().files).toEqual(await fullRead(source))
    expect(connection.readToolDetail).toHaveBeenCalledTimes(name === 'generationChanged' ? 2 : 1)
    store.dispose()
  },
)

it('keeps projection baselines and present results per session', async () => {
  const first = seeded(),
    second = ledger('t')
  second.commit((timeline) => {
    timeline.turns.push(turnOf(1, 1))
    timeline.nodes.push(present(300, 'other', 301))
  })
  second.results.set('1:300:301', { deliverables: [{ ...file, name: 'other.txt' }] })
  const a = first.connect(),
    b = second.connect()
  // The first session's projection is still in flight when the user switches to the second one.
  let release!: () => void
  a.projectUI.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return structuredClone(first.head)
  })
  const { store, selected } = mount(a, b)
  await vi.waitFor(() => expect(a.projectUI).toHaveBeenCalled())
  selected.setSession('t', 'ready')
  release()
  await vi.waitFor(() => expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['other.txt']))
  expect(b.projectUIPatch).not.toHaveBeenCalled()
  expect(b.readToolDetail.mock.calls).toEqual([[300, 301]])
  selected.setSession('s', 'ready')
  await vi.waitFor(() => expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['report.txt']))
  expect(a.projectUI).toHaveBeenCalledTimes(2)
  expect(a.projectUIPatch).not.toHaveBeenCalled()
  expect(a.readToolDetail).toHaveBeenCalledTimes(2)
  store.dispose()
})

it('derives the same records from patches as from full projections across a session history', async () => {
  const source = ledger()
  const connection = source.connect()
  const { store } = mount(connection)
  const steps: ((timeline: UITimeline) => void)[] = [
    (timeline) => {
      timeline.turns.push(turnOf(1, 1, 20))
      timeline.nodes.push(said(2), present(3, 'plain', 4))
      source.results.set('1:3:4', { deliverables: [file], owner: 'plugin' })
    },
    (timeline) => {
      // An open surface enhances the same presentation; another lane's surface stands alone.
      timeline.turns.push(turnOf(2, 21))
      timeline.nodes.push(present(22, 'enhanced'))
      source.surfaces.push(
        { open: true, record: surfaceOf('card-22', 23, 'report.txt', { presentedAt: 7 }) },
        { open: true, record: surfaceOf('loose', 24, 'loose.txt') },
      )
    },
    (timeline) => {
      timeline.nodes[timeline.nodes.length - 1] = present(22, 'enhanced', 25)
      timeline.turns[1] = turnOf(2, 21, 30)
      source.results.set('1:22:25', { deliverables: [file], surfaceId: 'card-22' })
    },
    (timeline) => {
      // A closed surface is still read by id; the plain result disappears with its node.
      timeline.turns.push(turnOf(3, 31, 40))
      timeline.nodes.splice(1, 1)
      timeline.nodes.push(present(32, 'closed', 33))
      source.results.set('1:32:33', { surfaceId: 'closed-card' })
      source.surfaces.push({ open: false, record: surfaceOf('closed-card', 32, 'closed.txt') })
    },
  ]
  const history: DeliverableRecord[][] = []
  await loaded(store)
  for (const step of steps) {
    source.commit(step)
    await store.refresh()
    expect(store.getSnapshot().files).toEqual(await fullRead(source))
    history.push([...store.getSnapshot().files])
  }
  expect(connection.projectUI).toHaveBeenCalledTimes(1)
  expect(history.map((files) => files.map((entry) => [entry.id, entry.turnId]))).toEqual([
    [['s:main:plain:0', 'turn-1']],
    [
      ['s:main:plain:0', 'turn-1'],
      ['s:side:card-22:0', 'turn-2'],
      ['s:side:loose:0', 'turn-2'],
    ],
    [
      ['s:main:plain:0', 'turn-1'],
      ['s:side:enhanced:0', 'turn-2'],
      ['s:side:loose:0', 'turn-2'],
    ],
    [
      ['s:side:enhanced:0', 'turn-2'],
      ['s:side:loose:0', 'turn-2'],
      ['s:side:closed-card:0', 'turn-3'],
    ],
  ])
  expect(history.at(-1)).toEqual([
    {
      id: 's:side:enhanced:0',
      sessionId: 's',
      laneId: 'side',
      source: { owner: 'agnes/deliverables', toolUseId: 'enhanced', callSeq: 22 },
      turnId: 'turn-2',
      seq: 22,
      inline: false,
      workbench: true,
      presentedAt: 7,
      name: 'report.txt',
      description: 'final',
      artifact,
    },
    {
      id: 's:side:loose:0',
      sessionId: 's',
      laneId: 'side',
      source: { owner: 'agnes/deliverables', surfaceId: 'loose' },
      turnId: 'turn-2',
      seq: 24,
      inline: false,
      workbench: true,
      name: 'loose.txt',
      description: 'surface copy',
      artifact,
    },
    {
      id: 's:side:closed-card:0',
      sessionId: 's',
      laneId: 'side',
      source: { owner: 'agnes/deliverables', surfaceId: 'closed-card' },
      turnId: 'turn-3',
      seq: 32,
      inline: false,
      workbench: true,
      name: 'closed.txt',
      description: 'surface copy',
      artifact,
    },
  ])
  store.dispose()
})

const unprojected = (connection: Connection) => {
  expect(connection.projectUI).not.toHaveBeenCalled()
  expect(connection.projectUIPatch).not.toHaveBeenCalled()
  expect(connection.readToolDetail).not.toHaveBeenCalled()
}
const cardOf = (toolUseId: string) =>
  `card-${createHash('sha256').update(toolUseId).digest('hex').slice(0, 48)}`

it('reads present results through session.deliverables with the projection records and no projection', async () => {
  const source = seeded()
  const connection = source.connect()
  const { apis, mounted } = offering(connection)
  const { store } = mounted()
  expect(await loaded(store)).toEqual(await fullRead(source))
  source.commit((timeline) => {
    timeline.turns.push(turnOf(2, 401))
    timeline.nodes.push(said(402), present(403, 'second'))
  })
  await store.refresh()
  source.commit((timeline) => {
    timeline.nodes[timeline.nodes.length - 1] = present(403, 'second', 404)
    timeline.turns[1] = turnOf(2, 401, 405)
  })
  source.results.set('1:403:404', { deliverables: [{ ...file, name: 'second.txt' }], laneId: 'side' })
  await store.refresh()
  expect(store.getSnapshot().files).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => [entry.name, entry.turnId])).toEqual([
    ['report.txt', 'turn-1'],
    ['second.txt', 'turn-2'],
  ])
  // A replaced result is the one shown; every refresh reads from the start.
  source.commit((timeline) => {
    timeline.nodes[timeline.nodes.length - 1] = present(403, 'second', 406)
  })
  source.results.set('1:403:406', { deliverables: [{ ...file, name: 'second-v2.txt' }] })
  await store.refresh()
  expect(store.getSnapshot()).toEqual({ sessionId: 's', files: await fullRead(source), loading: false })
  unprojected(connection)
  expect(connection.deliverables.mock.calls.map(([params]) => params)).toEqual(
    Array.from({ length: 4 }, () => ({ afterSeq: 0 })),
  )
  expect(apis).toHaveBeenCalledTimes(1)
  // Four complete reads together stay far below one projection of this ledger.
  expect(connection.bytes.query).toBeLessThan(JSON.stringify(source.head).length / 10)
  store.dispose()
})

it('derives the same records as the projection across a session history', async () => {
  const source = ledger()
  const connection = source.connect()
  const { store } = offering(connection).mounted()
  const steps: ((timeline: UITimeline) => void)[] = [
    (timeline) => {
      timeline.turns.push(turnOf(1, 1, 20))
      timeline.nodes.push(said(2), present(3, 'plain', 4))
      source.results.set('1:3:4', { deliverables: [file], owner: 'plugin' })
    },
    (timeline) => {
      // The call's own surface enhances the same presentation.
      timeline.turns.push(turnOf(2, 21, 30))
      timeline.nodes.push(present(22, 'enhanced', 25))
      source.results.set('1:22:25', { deliverables: [file], surfaceId: 'card-22' })
      source.surfaces.push({ open: true, record: surfaceOf('card-22', 23, 'report.txt', { presentedAt: 7 }) })
    },
    (timeline) => {
      // Older results kept their files only in a surface, read by id once closed.
      timeline.turns.push(turnOf(3, 31, 40))
      timeline.nodes.splice(1, 1)
      timeline.nodes.push(present(32, 'closed', 33))
      source.results.set('1:32:33', { surfaceId: 'closed-card' })
      source.surfaces.push({ open: false, record: surfaceOf('closed-card', 32, 'closed.txt') })
    },
    (timeline) => {
      // No structured data at all: the surface is found by the id derived from the call.
      timeline.turns.push(turnOf(4, 41, 49))
      timeline.nodes.push(present(42, 'bare', 44), present(45, 'null', 46))
      source.results.set('1:45:46', null as never)
      source.surfaces.push({ open: true, record: surfaceOf(cardOf('bare'), 43, 'bare.txt') })
    },
    (timeline) => {
      // A parked call finished by a continuation of its turn.
      timeline.turns.push(turnOf(5, 50, 52))
      timeline.nodes.push(present(51, 'parked'))
    },
    (timeline) => {
      timeline.turns[4] = turnOf(5, 50, 60)
      timeline.nodes[timeline.nodes.length - 1] = present(51, 'parked', 56)
      source.results.set('1:51:56', { deliverables: [{ ...file, name: 'parked.txt' }] })
    },
  ]
  await loaded(store)
  for (const step of steps) {
    source.commit(step)
    await store.refresh()
    expect(store.getSnapshot().files).toEqual(await fullRead(source))
  }
  expect(store.getSnapshot().files.map((entry) => [entry.id, entry.turnId, entry.seq])).toEqual([
    ['s:side:enhanced:0', 'turn-2', 22],
    ['s:side:closed-card:0', 'turn-3', 32],
    [`s:side:${cardOf('bare')}:0`, 'turn-4', 43],
    ['s:main:parked:0', 'turn-5', 51],
  ])
  unprojected(connection)
  store.dispose()
})

it('follows nextAfterSeq pages and starts from the beginning on every refresh', async () => {
  const source = ledger('s', 1)
  source.commit((timeline) => {
    timeline.turns.push(turnOf(1, 1, 30))
    timeline.nodes.push(present(2, 'a', 9), present(3, 'b', 5), present(4, 'c', 7))
    for (const [key, name] of [
      ['1:2:9', 'a.txt'],
      ['1:3:5', 'b.txt'],
      ['1:4:7', 'c.txt'],
    ] as const)
      source.results.set(key, { deliverables: [{ ...file, name }] })
  })
  const connection = source.connect()
  const { store } = offering(connection).mounted()
  expect(await loaded(store)).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  await store.refresh()
  expect(connection.deliverables.mock.calls.map(([params]) => params?.afterSeq)).toEqual([0, 5, 7, 0, 5, 7])
  unprojected(connection)
  store.dispose()
})

const refused = (reason: string) =>
  Object.assign(new Error(reason), { code: -32602, data: { code: 'INVALID_PARAMS', reason } })

it.each([
  ['the daemon does not announce it', 'unannounced'],
  ['apis.list fails', 'apis'],
  ['the read fails', 'read'],
  ['one source is larger than a page', 'too-large'],
] as const)(
  'falls back to the projection when %s and keeps it for the connection',
  async (_name, failure) => {
    const source = seeded()
    const connection = source.connect()
    const offer = offering(
      connection,
      failure === 'unannounced'
        ? ['_agnes/v1/session.projectUI']
        : ['_agnes/v1/session.projectUI', '_agnes/v1/session.deliverables'],
    )
    if (failure === 'apis') offer.apis.mockRejectedValueOnce(new Error('closed'))
    if (failure === 'read') connection.deliverables.mockRejectedValueOnce(new Error('closed'))
    if (failure === 'too-large')
      connection.deliverables.mockRejectedValueOnce(refused('deliverable-too-large'))
    const { store, lifecycle } = offer.mounted()
    expect(await loaded(store)).toEqual(await fullRead(source))
    expect(store.getSnapshot().error).toBeUndefined()
    expect(connection.projectUI).toHaveBeenCalledTimes(1)
    const tried = connection.deliverables.mock.calls.length
    expect(tried).toBe(failure === 'read' || failure === 'too-large' ? 1 : 0)
    source.commit((timeline) => {
      timeline.nodes.push(present(310, 'next', 311))
    })
    source.results.set('1:310:311', { deliverables: [{ ...file, name: 'next.txt' }] })
    await store.refresh()
    expect(store.getSnapshot().files).toEqual(await fullRead(source))
    expect(connection.projectUIPatch).toHaveBeenCalledTimes(1)
    expect(connection.deliverables).toHaveBeenCalledTimes(tried)
    // A new connection asks again.
    lifecycle.get('reconnected')?.()
    await store.refresh()
    expect(offer.apis).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().files).toEqual(await fullRead(source))
    if (failure === 'unannounced') expect(connection.projectUI).toHaveBeenCalledTimes(2)
    else {
      expect(connection.projectUI).toHaveBeenCalledTimes(1)
      expect(connection.deliverables.mock.calls.length).toBeGreaterThan(tried)
    }
    store.dispose()
  },
)

it.each([
  ['a file surface no present result names', 'loose'],
  ['the surface of a call still running', 'running'],
  ['the closed surface of a call outside any turn', 'unfiled'],
  ['a surface named by calls in different turns', 'shared'],
] as const)('lets the projection file %s under its turn', async (_name, surface) => {
  const source = seeded()
  source.commit((timeline) => {
    timeline.turns.push(turnOf(2, 401, 420), turnOf(3, 421, 440))
    if (surface === 'running') timeline.nodes.push(present(402, 'running'))
    if (surface === 'unfiled') timeline.nodes.push(present(450, 'unfiled', 451))
    if (surface === 'shared') timeline.nodes.push(present(405, 'p1', 406), present(425, 'p2', 426))
  })
  source.results.set('1:450:451', { surfaceId: 'closed-unfiled' })
  source.results.set('1:405:406', { surfaceId: 'shared' })
  source.results.set('1:425:426', { surfaceId: 'shared' })
  const id = { loose: 'loose', running: cardOf('running'), unfiled: 'closed-unfiled', shared: 'shared' }[
    surface
  ]
  source.surfaces.push({ open: surface !== 'unfiled', record: surfaceOf(id, 403, 'surface.txt') })
  const connection = source.connect()
  const { store } = offering(connection).mounted()
  expect(await loaded(store)).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => [entry.name, entry.turnId])).toEqual([
    ['report.txt', 'turn-1'],
    ['surface.txt', 'turn-2'],
  ])
  expect(connection.deliverables).toHaveBeenCalledTimes(1)
  expect(connection.projectUI).toHaveBeenCalledTimes(1)
  store.dispose()
})

it('merges present results in call order, as the projection lists them', async () => {
  const source = ledger()
  source.commit((timeline) => {
    timeline.turns.push(turnOf(1, 1, 40))
    // The earlier call finishes last; its closed surface shares a seq with the later call.
    timeline.nodes.push(present(10, 'early', 30), present(20, 'late', 25))
  })
  source.results.set('1:10:30', { surfaceId: 'closed-early' })
  source.results.set('1:20:25', { deliverables: [{ ...file, name: 'late.txt' }] })
  source.surfaces.push({ open: false, record: surfaceOf('closed-early', 20, 'early.txt') })
  const connection = source.connect()
  const { store } = offering(connection).mounted()
  expect(await loaded(store)).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['early.txt', 'late.txt'])
  unprojected(connection)
  store.dispose()
})

it('keeps the newest result of a call that a later page repeats', async () => {
  const source = seeded()
  source.commit((timeline) => {
    timeline.nodes[timeline.nodes.length - 1] = present(300, 'first', 305)
  })
  source.results.set('1:300:305', { deliverables: [{ ...file, name: 'replaced.txt' }] })
  const connection = source.connect()
  // The result was replaced between two pages of the same read.
  connection.deliverables
    .mockResolvedValueOnce({
      sessionId: 's',
      upto: 301,
      items: [
        {
          callSeq: 300,
          resultSeq: 301,
          toolUseId: 'first',
          turnId: 'turn-1',
          structured: { deliverables: [file] },
        },
      ],
      nextAfterSeq: 301,
    })
    .mockResolvedValueOnce({
      sessionId: 's',
      upto: 305,
      items: [
        {
          callSeq: 300,
          resultSeq: 305,
          toolUseId: 'first',
          turnId: 'turn-1',
          structured: { deliverables: [{ ...file, name: 'replaced.txt' }] },
        },
      ],
    })
  const { store } = offering(connection).mounted()
  expect(await loaded(store)).toEqual(await fullRead(source))
  expect(store.getSnapshot().files.map((entry) => entry.name)).toEqual(['replaced.txt'])
  unprojected(connection)
  store.dispose()
})

it('reports a failed read on both paths without discarding the published records', async () => {
  const source = seeded()
  const connection = source.connect()
  const { store } = offering(connection).mounted()
  const files = await loaded(store)
  connection.deliverables.mockRejectedValueOnce(new Error('closed'))
  connection.projectUI.mockRejectedValueOnce(new Error('closed'))
  await store.refresh()
  expect(store.getSnapshot()).toEqual({
    sessionId: 's',
    files,
    loading: false,
    error: 'Deliverables unavailable',
  })
  await store.refresh()
  expect(store.getSnapshot()).toEqual({ sessionId: 's', files, loading: false })
  store.dispose()
})

it('detects again instead of projecting when the baseline drops while apis.list is pending', async () => {
  const source = seeded()
  const connection = source.connect()
  const offer = offering(connection)
  const { store, lifecycle } = offer.mounted()
  await loaded(store)
  // The listing in flight belongs to the closed connection and fails.
  let release!: () => void
  offer.apis.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    throw new Error('closed')
  })
  lifecycle.get('reconnected')?.()
  await vi.waitFor(() => expect(release).toBeDefined())
  // A reconnect drops the baseline again (gap, readiness epoch) before the first listing answers.
  lifecycle.get('gap')?.()
  release()
  await vi.waitFor(() => expect(connection.deliverables.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(offer.apis).toHaveBeenCalledTimes(3)
  expect(store.getSnapshot().files).toEqual(await fullRead(source))
  unprojected(connection)
  store.dispose()
})

it('detects again instead of projecting when a deliverables read fails across a baseline drop', async () => {
  const source = seeded()
  const connection = source.connect()
  const offer = offering(connection)
  const { store, lifecycle } = offer.mounted()
  await loaded(store)
  let fail!: () => void
  connection.deliverables.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = () => reject(new Error('closed'))
      }),
  )
  void store.refresh()
  await vi.waitFor(() => expect(fail).toBeDefined())
  lifecycle.get('reconnected')?.()
  fail()
  await vi.waitFor(() => expect(connection.deliverables.mock.calls.length).toBeGreaterThanOrEqual(3))
  expect(offer.apis).toHaveBeenCalledTimes(2)
  expect(store.getSnapshot().files).toEqual(await fullRead(source))
  unprojected(connection)
  store.dispose()
})

it('does not publish a deliverables read that a newer readiness epoch overtook', async () => {
  const source = seeded()
  const connection = source.connect()
  const { store, selected } = offering(connection).mounted()
  await loaded(store)
  let release!: () => void
  const original = connection.deliverables.getMockImplementation()
  connection.deliverables.mockImplementationOnce(async (params) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    source.results.set('1:300:301', { deliverables: [{ ...file, name: 'stale.txt' }] })
    return (original as NonNullable<typeof original>)(params)
  })
  const pending = store.refresh()
  await vi.waitFor(() => expect(release).toBeDefined())
  selected.setReadiness('connecting')
  expect(store.getSnapshot().files).toEqual([])
  release()
  await pending
  expect(store.getSnapshot().files).toEqual([])
  store.dispose()
})
