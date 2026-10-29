import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  observeProgress,
  RUN_PROGRESS_EVENT_TYPES,
  type RunProgress,
  startProgress,
} from '@agnes/base/schedule'
import { APPROVAL_TICKET_EVENT_TYPES, indexApprovalTicket } from '@agnes/daemon-rpc/local/methods/agnes'
import { createSqliteStorage } from '@agnes/host'
import { type EventEnvelope, sessionArtifactRoots } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { workspaceBinding } from '../../daemon-foundation/test/workspace-authority.js'
import type { HistoryConsumer } from '../src/supervisor/open-history.js'
import { type RegistryOptions, WorkerRegistry } from '../src/supervisor/registry.js'
import {
  observeSessionRequests,
  SESSION_REQUEST_EVENT_TYPES,
} from '../src/supervisor/session-request-events.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'

// Opening a session reads its history by the event types its consumers react to instead of having
// the worker push every row. These tests drive the real registry against a fake ledger and compare
// the effects of the typed read with those of feeding every row, the way the open used to.

const KEY = 'history-session'
const KINDS = ['roots:', 'progress:', 'ticket:', 'reset:', 'revoke:']
const SHA = (n: number) => n.toString(16).padStart(64, '0')

function row(seq: number, type: string, data: unknown, extra: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    seq,
    ts: new Date(Date.UTC(2026, 9, 21, 0, 0, seq)).toISOString(),
    id: `id-${seq}`,
    type,
    v: 1,
    lane: 'main',
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
    data,
    ...extra,
  } as EventEnvelope
}

const decision = (id: string, state: 'parked' | 'answered' | 'refused' | 'consumed', turn = 1) => ({
  handle: { id, sessionId: KEY },
  request: {
    expiresAt: '2030-01-01T00:00:00.000Z',
    spec: { subject: { turn } },
  },
  ...(state === 'answered' ? { result: { reason: 'answered', response: { option: 'approved' } } } : {}),
  ...(state === 'refused' ? { result: { reason: 'answered', response: { option: 'rejected' } } } : {}),
  ...(state === 'consumed' ? { consumption: { at: 1 } } : {}),
})

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** A mixed history: rows consumers want, and the many they do not. */
function history(seed: number, length: number): EventEnvelope[] {
  const next = random(seed)
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)] as T
  const rows: EventEnvelope[] = [row(1, 'session/start', { key: KEY, preset: 'standard' })]
  let turn = 0
  for (let seq = 2; seq <= length; seq++) {
    const kind = pick([
      'assistant',
      'assistant',
      'tool-call',
      'user',
      'result-image',
      'result-other',
      'header',
      'registered',
      'turn-start',
      'turn-end',
      'decision',
      'refused',
      'switch',
      'control',
      'budget',
      'cost',
    ])
    if (kind === 'assistant')
      rows.push(row(seq, 'assistant/message', { content: [{ type: 'text', text: `m${seq}` }] }))
    else if (kind === 'tool-call') rows.push(row(seq, 'tool/call', { name: 'read' }))
    else if (kind === 'user') rows.push(row(seq, 'user/message', { content: [{ type: 'text', text: 'hi' }] }))
    else if (kind === 'result-image')
      rows.push(
        row(
          seq,
          'tool/result',
          {
            content: [
              { type: 'resource_link', uri: `artifact://${SHA(seq)}`, mimeType: 'image/png', name: 'i' },
            ],
            isError: false,
          },
          { origin: 'tool:read', trust: 'trusted' },
        ),
      )
    else if (kind === 'result-other')
      rows.push(
        row(
          seq,
          'tool/result',
          { content: [{ type: 'text', text: 'ok' }], isError: false },
          { origin: 'tool:bash' },
        ),
      )
    else if (kind === 'header')
      rows.push(
        row(
          seq,
          'request/header',
          pick([
            {},
            {
              media: {
                manifest: [{ sha256: SHA(seq), mime: 'image/png', artifactUri: `artifact://${SHA(seq)}` }],
              },
            },
          ]),
          { origin: 'system' },
        ),
      )
    else if (kind === 'registered')
      rows.push(
        row(
          seq,
          'x/core/artifact.registered',
          { artifact: { sha256: SHA(seq), mime: 'image/png', size: seq } },
          { origin: 'system' },
        ),
      )
    else if (kind === 'turn-start') {
      turn++
      rows.push(row(seq, 'turn/start', { turn, trigger: pick(['user', 'approval-resume']) }))
    } else if (kind === 'turn-end')
      rows.push(row(seq, 'turn/end', { turn, reason: pick(['completed', 'parked', 'failed']) }))
    else if (kind === 'decision')
      rows.push(
        row(
          seq,
          'decision/state',
          decision(`d${Math.floor(next() * 4)}`, pick(['parked', 'answered', 'consumed']), turn),
        ),
      )
    else if (kind === 'refused') rows.push(row(seq, 'decision/state', decision(`d${seq}`, 'refused', turn)))
    else if (kind === 'switch')
      rows.push(
        row(
          seq,
          'x/core/preset-switch',
          { to: 'careful', fromPermission: pick(['full-access', 'default']) },
          { origin: 'system' },
        ),
      )
    else if (kind === 'control')
      rows.push(
        row(seq, 'x/core/control', {
          action: pick(['cancel', 'interrupt', 'pause']),
          outcome: pick(['requested', 'done']),
        }),
      )
    else if (kind === 'budget')
      rows.push(row(seq, 'budget.state', { spent: seq }, { register: 'budget.state' }))
    else rows.push(row(seq, 'cost/ledger', { cost: seq }))
  }
  return rows
}

/** Everything the consumers do, in the order they do it. */
function consumers(effects: string[]) {
  const pool = {
    resetSessionRequests: (key: string) => effects.push(`reset:${key}`),
    revokeSessionRequests: (key: string) => effects.push(`revoke:${key}`),
  }
  let progress: RunProgress = startProgress()
  const tickets = {
    put: (id: string, key: string, expiresAt: number) => effects.push(`ticket:${id}:${key}:${expiresAt}`),
  }
  const requests: HistoryConsumer = {
    types: SESSION_REQUEST_EVENT_TYPES,
    observe: (key, e) => observeSessionRequests(pool, key, e),
  }
  const automation: HistoryConsumer = {
    types: RUN_PROGRESS_EVENT_TYPES,
    observe: (_key, e) => {
      // What the schedule and trigger observers do: skip other rows, otherwise fold into the state.
      if (!RUN_PROGRESS_EVENT_TYPES.includes(e.type)) return
      progress = observeProgress(progress, e, Date.UTC(2026, 9, 21))
      effects.push(`progress:${e.seq}:${JSON.stringify(progress)}`)
    },
  }
  const approvals: HistoryConsumer = {
    types: APPROVAL_TICKET_EVENT_TYPES,
    observe: (key, e) => {
      indexApprovalTicket(tickets as never, key, e, '/workspace')
    },
  }
  const authority = {
    resetSession: vi.fn(),
    observe: vi.fn(async (_key: string, event: unknown) => {
      const e = event as EventEnvelope
      let roots: string
      try {
        roots = JSON.stringify(sessionArtifactRoots(e) ?? null)
      } catch {
        roots = 'invalid'
      }
      if (roots !== 'null') effects.push(`roots:${e.seq}:${roots}`)
    }),
  }
  return { list: [requests, automation, approvals], authority }
}

/** A worker link over a fake ledger; `tail` hands back rows from its `fromSeq`, like the worker's read. */
function ledgerLink(rows: EventEnvelope[], deliver: (e: EventEnvelope) => void) {
  const scans: Array<Record<string, unknown>> = []
  const tails: number[] = []
  const link = {
    alive: true,
    hello: Promise.resolve({
      kind: 'hello' as const,
      token: 'token',
      sessionKey: KEY,
      writerRunId: 'run',
      generation: 1,
      profileHash: 'sha256-profile',
      lastSeq: rows.at(-1)?.seq ?? 0,
    }),
    onExit: vi.fn(),
    closeSession: vi.fn(async () => undefined),
    tail: vi.fn(async (fromSeq: number) => {
      tails.push(fromSeq)
      for (const e of rows.filter((candidate) => candidate.seq >= fromSeq)) deliver(e)
    }),
    command: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'status') return { lastSeq: rows.at(-1)?.seq ?? 0, preset: null }
      if (method !== 'scan') return undefined
      scans.push(params)
      const types = params.type === undefined ? undefined : ([] as unknown[]).concat(params.type)
      let page = rows.filter(
        (e) =>
          e.seq >= Number(params.fromSeq ?? 1) &&
          e.seq <= Number(params.toSeq ?? Number.MAX_SAFE_INTEGER) &&
          (!types || types.includes(e.type)),
      )
      if (params.order === 'desc') page = page.reverse()
      return page.slice(0, Number(params.limit ?? 500))
    }),
  }
  return { link, scans, tails }
}

async function openWith(
  rows: EventEnvelope[],
  options: RegistryOptions,
  authority?: ReturnType<typeof consumers>['authority'],
) {
  let registry: WorkerRegistry | undefined
  const { link, scans, tails } = ledgerLink(rows, (e) => void registry?.deliver(KEY, e))
  registry = new WorkerRegistry(
    { acquire: vi.fn(async () => link), retire: vi.fn() } as unknown as WorkerPool,
    authority,
    options,
  )
  const entry = await registry.open({
    key: KEY,
    cwd: '/workspace',
    resume: true,
    binding: await workspaceBinding(KEY, '/workspace'),
  })
  return { registry, entry, link, scans, tails }
}

/** What opening used to do: every row of the ledger through each consumer, in order. */
async function everyRow(rows: EventEnvelope[]): Promise<string[]> {
  const effects: string[] = []
  const { list, authority } = consumers(effects)
  for (const e of rows) {
    await authority.observe(KEY, e)
    for (const consumer of list) consumer.observe(KEY, e, 1)
  }
  return effects
}

describe('typed history read at open', () => {
  it('has the same effects as feeding every row, across random histories', async () => {
    const exercised = new Set<string>()
    for (let seed = 1; seed <= 25; seed++) {
      const rows = history(seed, 30 + (seed % 6) * 40)
      const expected = await everyRow(rows)
      for (const kind of KINDS) if (expected.some((e) => e.startsWith(kind))) exercised.add(kind)
      const effects: string[] = []
      const { list, authority } = consumers(effects)
      await openWith(rows, { history: list }, authority)
      // Both sides interleave authority and consumer effects per row, so equal sequences mean equal order.
      expect(effects, `seed ${seed}`).toEqual(expected)
    }
    // The comparison means little if the histories do not exercise every consumer.
    expect([...exercised].sort()).toEqual([...KINDS].sort())
  })

  it('reads a real SQLite ledger the same way: typed pages, the newest register row, the head', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agnes-open-history-'))
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
    try {
      const rows = history(31, 1_300)
      await storage.open(KEY, { writerRunId: 'r1', ttlMs: 60_000 })
      for (let at = 0; at < rows.length; at += 200)
        await storage.commit(KEY, {
          events: rows.slice(at, at + 200).map(({ seq: _seq, ...event }) => event as never),
          expectedWriterRunId: 'r1',
        })
      const expected = await everyRow(rows)
      const effects: string[] = []
      const { list, authority } = consumers(effects)
      const link = {
        alive: true,
        hello: Promise.resolve({
          kind: 'hello' as const,
          token: 'token',
          sessionKey: KEY,
          writerRunId: 'run',
          generation: 1,
          profileHash: 'sha256-profile',
          lastSeq: rows.length,
        }),
        onExit: vi.fn(),
        closeSession: vi.fn(async () => undefined),
        tail: vi.fn(async () => undefined),
        command: vi.fn(async (method: string, params: Record<string, unknown>) =>
          method === 'scan' ? storage.scan(KEY, params as never) : { lastSeq: rows.length, preset: null },
        ),
      }
      const registry = new WorkerRegistry(
        { acquire: vi.fn(async () => link), retire: vi.fn() } as unknown as WorkerPool,
        authority,
        { history: list },
      )
      const entry = await registry.open({
        key: KEY,
        cwd: '/workspace',
        resume: true,
        binding: await workspaceBinding(KEY, '/workspace'),
      })
      expect(effects.length).toBeGreaterThan(50)
      expect(effects).toEqual(expected)
      expect(entry.session.latest('budget.state')).toEqual(
        rows.filter((e) => e.type === 'budget.state').at(-1)?.data,
      )
    } finally {
      await storage.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads only rows of the consumers types, from the first row to the head, and tails after the head', async () => {
    const rows = history(3, 400)
    const { list, authority } = consumers([])
    const { scans, tails, entry } = await openWith(rows, { history: list }, authority)
    const wanted = new Set([
      'user/message',
      'inbox',
      'request/header',
      'tool/result',
      'x/core/artifact.registered',
      ...SESSION_REQUEST_EVENT_TYPES,
      ...RUN_PROGRESS_EVENT_TYPES,
      ...APPROVAL_TICKET_EVENT_TYPES,
    ])
    const typed = scans.filter((q) => Array.isArray(q.type) && q.order === 'asc')
    expect(typed.length).toBeGreaterThan(0)
    for (const q of typed) {
      expect(new Set(q.type as string[])).toEqual(wanted)
      expect(q.toSeq).toBe(400)
    }
    // No scan reads rows without naming their types, apart from the listener gap (none here).
    expect(scans.every((q) => q.type !== undefined)).toBe(true)
    expect(tails).toEqual([401])
    expect(entry.session.lastSeq).toBe(400)
  })

  it('pages the typed read past the page size without skipping or repeating a row', async () => {
    const rows = history(8, 1_800)
    const seen: number[] = []
    const consumer: HistoryConsumer = { types: ['turn/start'], observe: (_k, e) => void seen.push(e.seq) }
    await openWith(rows, { history: [consumer] })
    expect(seen).toEqual(rows.filter((e) => e.type === 'turn/start').map((e) => e.seq))
  })

  it('counts every row up to the head as projected, though only some were read', async () => {
    const rows = [...history(23, 80), row(81, 'cost/ledger', { cost: 1 })]
    const { list, authority } = consumers([])
    const { registry } = await openWith(rows, { history: list }, authority)
    // The newest row is not one the open reads, yet media authority for it must not wait on a frame.
    await expect(registry.ensureArtifactAuthority(KEY, 81)).resolves.toBeUndefined()
  })

  it('primes the budget register from the newest budget row', async () => {
    const rows = history(5, 300)
    const newest = rows.filter((e) => e.type === 'budget.state').at(-1)
    const { entry } = await openWith(rows, {})
    expect(entry.session.latest('budget.state')).toEqual(newest?.data)
  })

  it('holds the consumers of a frame that arrives mid-catch-up behind the history', async () => {
    const rows = history(11, 120)
    const effects: string[] = []
    const { list, authority } = consumers(effects)
    let registry: WorkerRegistry | undefined
    const ledger = ledgerLink(rows, () => undefined)
    const base = ledger.link.command.getMockImplementation() as (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>
    let injected = false
    ledger.link.command.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      // The first typed read is under way when the next committed row reaches the daemon.
      if (!injected && method === 'scan') {
        injected = true
        const live = row(121, 'turn/start', { turn: 99, trigger: 'user' })
        void registry?.deliver(
          KEY,
          live,
          () => effects.push('before-publish:121'),
          () => effects.push('wire:121'),
        )
      }
      return base(method, params)
    })
    registry = new WorkerRegistry(
      { acquire: vi.fn(async () => ledger.link), retire: vi.fn() } as unknown as WorkerPool,
      authority,
      { history: list },
    )
    await registry.open({
      key: KEY,
      cwd: '/workspace',
      resume: true,
      binding: await workspaceBinding(KEY, '/workspace'),
    })
    const history121 = effects.indexOf('wire:121')
    expect(history121).toBeGreaterThan(0)
    // Nothing of the history is observed after the live frame's consumers have run.
    expect(effects.slice(history121 + 1).some((e) => /^(progress|roots|ticket):/.test(e))).toBe(false)
    expect(effects.slice(history121)).toEqual(['wire:121', 'before-publish:121'])
  })

  it('delivers the row committed between hello and tail exactly once', async () => {
    const rows = history(13, 60)
    const late = row(61, 'turn/start', { turn: 50, trigger: 'user' })
    const wire: number[] = []
    const consumed: number[] = []
    const consumer: HistoryConsumer = { types: ['turn/start'], observe: (_k, e) => void consumed.push(e.seq) }
    let registry: WorkerRegistry | undefined
    const ledger = ledgerLink(rows, () => undefined)
    // The worker's read at tail time sees the row appended after hello.
    ledger.link.tail.mockImplementation(async (fromSeq: number) => {
      rows.push(late)
      for (const e of rows.filter((candidate) => candidate.seq >= fromSeq))
        void registry?.deliver(KEY, e, undefined, () => wire.push(e.seq))
    })
    registry = new WorkerRegistry(
      { acquire: vi.fn(async () => ledger.link), retire: vi.fn() } as unknown as WorkerPool,
      undefined,
      { history: [consumer] },
    )
    const entry = await registry.open({
      key: KEY,
      cwd: '/workspace',
      resume: true,
      binding: await workspaceBinding(KEY, '/workspace'),
    })
    expect(wire).toEqual([61])
    expect(consumed).toEqual(rows.filter((e) => e.type === 'turn/start' && e.seq <= 60).map((e) => e.seq))
    expect(entry.session.lastSeq).toBe(61)
  })

  it('offers listeners that outlived a worker generation the rows they have not seen, once', async () => {
    const rows = history(17, 100)
    const first = rows.slice(0, 80)
    const seen: number[] = []
    let registry: WorkerRegistry | undefined
    const make = (ledger: EventEnvelope[]) => ledgerLink(ledger, (e) => void registry?.deliver(KEY, e))
    const links = [make(first), make(rows)]
    let opens = 0
    registry = new WorkerRegistry(
      { acquire: vi.fn(async () => links[opens++]?.link), retire: vi.fn() } as unknown as WorkerPool,
      undefined,
      {},
    )
    await registry.open({
      key: KEY,
      cwd: '/workspace',
      resume: true,
      binding: await workspaceBinding(KEY, '/workspace'),
    })
    registry.subscribe(KEY, (e) => seen.push(e.seq))
    // Rows 81..100 were committed by the worker that then died, before any frame reached the daemon.
    registry.interrupt(KEY, new Error('worker link closed'))
    await vi.waitFor(() => expect(opens).toBe(2))
    await vi.waitFor(() => expect(registry?.get(KEY)).toBeDefined())
    await registry.deliver(KEY, row(101, 'assistant/message', { content: [{ type: 'text', text: 'x' }] }))
    expect(seen).toEqual(Array.from({ length: 21 }, (_, i) => 81 + i))
  })

  it('fails the open and retires the session when a consumer throws', async () => {
    const rows = history(19, 50)
    const boom: HistoryConsumer = {
      types: ['turn/start'],
      observe: () => {
        throw new Error('consumer failed')
      },
    }
    const retire = vi.fn()
    const ledger = ledgerLink(rows, () => undefined)
    const registry = new WorkerRegistry(
      { acquire: vi.fn(async () => ledger.link), retire } as unknown as WorkerPool,
      undefined,
      {
        history: [boom],
      },
    )
    await expect(
      registry.open({
        key: KEY,
        cwd: '/workspace',
        resume: true,
        binding: await workspaceBinding(KEY, '/workspace'),
      }),
    ).rejects.toThrow('consumer failed')
    expect(retire).toHaveBeenCalledOnce()
    expect(registry.get(KEY)).toBeUndefined()
  })
})
