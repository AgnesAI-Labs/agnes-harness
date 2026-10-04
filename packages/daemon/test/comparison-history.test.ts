import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreUITimeline } from '@agnes/core'
import { createComparisonStore } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { comparisonArchiveReader } from '../src/local/comparison-archive-reader.js'
import {
  type ComparisonHistoryLedger,
  createComparisonHistoryReader,
} from '../src/local/comparison-history.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import type { LocalContext } from '../src/local/methods/acp.js'
import type { ComparisonLedgerReader } from '../src/local/methods/comparison.js'
import { registerComparisonRead } from '../src/local/methods/comparison-read.js'
import type { JsonRpcResponse } from '../src/rpc.js'

const capture = JSON.parse(
  readFileSync('packages/core/test/fixtures/comparison-real-journal.json', 'utf8'),
) as {
  reports: { lane: { side: 'left' | 'right'; sessionId: string }; events: EventEnvelope[] }[]
}
const views = JSON.parse(
  readFileSync('packages/web/test/fixtures/comparison-real-journal-views.json', 'utf8'),
) as {
  projections: Record<'left' | 'right', Record<string, CoreUITimeline>>
}
const tools = JSON.parse(readFileSync('packages/core/test/fixtures/jev-real-trace.json', 'utf8')) as {
  events: EventEnvelope[]
}
const prepared = JSON.parse(
  readFileSync('packages/protocol/test/fixtures/comparison-prepared-real.json', 'utf8'),
) as { events: EventEnvelope[] }
function ledger(sessions: Map<string, readonly EventEnvelope[]>): ComparisonHistoryLedger {
  return {
    async head(id) {
      return sessions.get(id)?.at(-1)?.seq ?? 0
    },
    async scan(id, query) {
      return (sessions.get(id) ?? [])
        .filter((row) => row.seq >= query.fromSeq && row.seq <= query.toSeq)
        .slice(0, query.limit)
    },
  }
}
const sessions = new Map(capture.reports.map(({ lane, events }) => [lane.sessionId, events]))

it('serves authorized stored history without a registry, binding every reply to the journal cut', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-history-rpc-'))
  const storage = createComparisonStore(join(directory, 'history.sqlite'))
  const source = ledger(
    new Map([
      ['native-archive', capture.reports[0]!.events],
      ['jev-archive', tools.events],
    ]),
  )
  const owner = new LocalEndpoint({ principalId: 'owner', clock: Date.now })
  const stranger = new LocalEndpoint({ principalId: 'stranger', clock: Date.now })
  const unavailable = (): never => {
    throw new Error('history cannot mutate session ownership')
  }
  let wrongOwner = false
  const ownership: NonNullable<LocalContext['sessionOwnership']> = {
    resolve: () => ({ active: true, principalId: wrongOwner ? 'different-owner' : 'owner' }),
    bindNew: unavailable,
    ownsNewReservation: unavailable,
    activateNew: unavailable,
    inherit: unavailable,
    activateFork: unavailable,
    activeSessionIds: unavailable,
  }
  let broken = false
  let oversized = false
  let binary = false
  let preparedType: string | undefined
  const port: ComparisonLedgerReader = {
    head: source.head,
    async scan(id, query) {
      if (broken) throw new Error('/private/secret/backend-key must not leave server')
      const rows = [
        ...(await source.scan(id, {
          fromSeq: query.fromSeq ?? 1,
          toSeq: query.toSeq ?? (await source.head(id)),
          limit: query.limit ?? 1000,
          order: 'asc',
        })),
      ]
      const extensionType = preparedType
      if (extensionType) {
        const event = prepared.events[id === 'native-archive' ? 0 : 1]
        if (!event) throw new Error('Missing actual prepared event fixture')
        return rows.map((row) => (row.seq === 4 ? { ...event, type: extensionType } : row))
      }
      if (binary)
        return rows.map((row) => ({
          ...row,
          _meta: { private: 'transport-only' },
          data: { content: [{ type: 'image', data: 'private-binary', mimeType: 'image/png' }] },
        }))
      if (oversized)
        return rows.map((row) => ({
          ...row,
          data: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] },
        }))
      return rows
    },
  }
  for (const endpoint of [owner, stranger]) {
    endpoint.conn.initialized = true
    registerComparisonRead(endpoint, ownership, storage, port)
  }
  const call = (endpoint: LocalEndpoint, method: string, params: unknown) =>
    endpoint.handle({ jsonrpc: '2.0', id: 1, method, params }) as Promise<JsonRpcResponse>
  try {
    const store = storage.scoped('owner')
    await store.compareAndSwap('pair', null, {
      id: 'pair',
      revision: 0,
      createPayload: '{}',
      creation: 'ready',
      rounds: [],
      cancellation: {},
      cleanup: { exited: ['left', 'right'], released: true },
      lanes: {
        left: {
          side: 'left',
          sessionId: 'native-archive',
          runtime: { id: 'native', version: '1' },
          workspaceLabel: 'left',
          phase: 'idle',
          lastSeq: 0,
        },
        right: {
          side: 'right',
          sessionId: 'jev-archive',
          runtime: { id: 'jevloop', version: '1' },
          workspaceLabel: 'right',
          phase: 'idle',
          lastSeq: 0,
        },
      },
    })
    const checkpoint = await store.journal.checkpoint('pair', {
      reason: 'recovery',
      cuts: { left: 10, right: 32 },
    })
    const input = { id: 'pair', side: 'right', atSeq: checkpoint.seq }
    const result = await call(owner, '_agnes/v1/comparison.events', { ...input, afterSeq: 0, limit: 100 })
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({
      ...input,
      sessionId: 'jev-archive',
      throughSeq: 32,
      nextAfterSeq: 32,
      complete: true,
    })
    expect((result.result as { events: EventEnvelope[] }).events).toEqual(tools.events.slice(0, 32))
    for (const type of ['x/host/session-prepared', 'x/core/child-descriptor', 'x/core/child-delivery']) {
      preparedType = type
      for (const side of ['left', 'right'] as const) {
        const page = await call(owner, '_agnes/v1/comparison.events', {
          ...input,
          side,
          afterSeq: 3,
          limit: 1,
        })
        // LocalEndpoint applies the real method result validator before emitting this response.
        expect(page.error).toBeUndefined()
        expect(page.result).toMatchObject({ events: [{ seq: 4, type, ignorable: true }] })
      }
    }
    preparedType = undefined
    const projected = await call(owner, '_agnes/v1/comparison.projectUI', { ...input, surface: 'web' })
    expect(projected.error).toBeUndefined()
    expect(projected.result).toMatchObject({
      ...input,
      sessionId: 'jev-archive',
      throughSeq: 32,
      timeline: await createComparisonHistoryReader(source).projectUI({
        sessionId: 'jev-archive',
        throughSeq: 32,
      }),
    })
    const detail = await call(owner, '_agnes/v1/comparison.readToolDetail', {
      ...input,
      callSeq: 28,
      resultSeq: 32,
    })
    expect(detail.error).toBeUndefined()
    expect(detail.result).toMatchObject({
      ...input,
      sessionId: 'jev-archive',
      throughSeq: 32,
      ok: true,
      page: { offset: 0, nextOffset: null },
    })
    const page = (detail.result as { page: { data: string } }).page
    expect(JSON.parse(Buffer.from(page.data, 'base64').toString('utf8'))).toEqual({
      call: tools.events[27]!.data,
      result: tools.events[31]!.data,
    })
    for (const [method, args] of [
      ['events', { afterSeq: 0 }],
      ['projectUI', { surface: 'web' }],
      ['readToolDetail', { callSeq: 28 }],
    ] as const) {
      expect(
        (await call(stranger, `_agnes/v1/comparison.${method}`, { ...input, ...args })).error,
      ).toBeDefined()
      expect(
        (await call(owner, `_agnes/v1/comparison.${method}`, { ...input, ...args, sessionId: 'arbitrary' }))
          .error,
      ).toBeDefined()
      expect(
        (
          await call(owner, `_agnes/v1/comparison.${method}`, {
            ...input,
            ...args,
            atSeq: checkpoint.seq + 100,
          })
        ).error,
      ).toBeDefined()
    }
    expect(
      (await call(owner, '_agnes/v1/comparison.readToolDetail', { ...input, callSeq: 28, resultSeq: 57 }))
        .error?.data,
    ).toMatchObject({ code: 'HISTORY_INVALID_ARGUMENT' })
    wrongOwner = true
    expect((await call(owner, '_agnes/v1/comparison.events', { ...input, afterSeq: 0 })).error?.data).toEqual(
      { code: 'CAPABILITY_DENIED' },
    )
    wrongOwner = false
    binary = true
    const sanitized = await call(owner, '_agnes/v1/comparison.events', { ...input, afterSeq: 0, limit: 1 })
    expect(sanitized.error).toBeUndefined()
    expect(JSON.stringify(sanitized.result)).toContain('[OMITTED:image:base64]')
    expect(JSON.stringify(sanitized.result)).not.toContain('private-binary')
    expect(JSON.stringify(sanitized.result)).not.toContain('_meta')
    binary = false
    broken = true
    const refused = await call(owner, '_agnes/v1/comparison.projectUI', { ...input, surface: 'web' })
    expect(refused.error?.data).toEqual({ code: 'HISTORY_UNAVAILABLE' })
    expect(JSON.stringify(refused)).not.toContain('backend-key')
    broken = false
    oversized = true
    expect(
      (await call(owner, '_agnes/v1/comparison.projectUI', { ...input, surface: 'web' })).error?.data,
    ).toMatchObject({ code: 'HISTORY_LIMIT' })
    oversized = false
    const requests = [
      ['events', { ...input, afterSeq: 0, limit: 100 }],
      ['projectUI', { ...input, surface: 'web' }],
      ['readToolDetail', { ...input, callSeq: 28, resultSeq: 32 }],
      ['metrics', { id: input.id, atSeq: input.atSeq }],
      ['priceDetails', input],
    ] as const
    const before = await Promise.all(
      requests.map(([method, args]) => call(owner, `_agnes/v1/comparison.${method}`, args)),
    )
    for (const response of before) expect(response.error).toBeUndefined()
    const original = (await store.read('pair'))!
    const racingReader = comparisonArchiveReader(store, original, 'right', {
      head: async () => {
        throw new Error('live storage retired')
      },
      scan: async () => {
        throw new Error('live storage retired')
      },
    })
    const retired = { ...original, revision: 1, retirement: { state: 'releasing' as const, epoch: 1 } }
    await store.compareAndSwap('pair', 0, retired)
    for (const side of ['left', 'right'] as const) {
      const sessionId = retired.lanes[side]!.sessionId
      const throughSeq = await source.head(sessionId)
      const rows = await source.scan(sessionId, { fromSeq: 1, toSeq: throughSeq, limit: 1000, order: 'asc' })
      store.archive.write('pair', side, {
        sessionId,
        epoch: 1,
        throughSeq,
        rows: rows.map((event) => ({ sessionKey: sessionId, event, integrity: null })),
      })
      // Real persisted event fixtures under synthetic ownership test the public archive boundary.
      const childKey = `${sessionId}/archived-child`
      store.treeArchive.write('pair', side, {
        proof: {
          rootSessionKey: sessionId,
          retirementId: `comparison:pair:${side}`,
          epoch: 1,
          members: [
            {
              sessionKey: sessionId,
              kind: 'root',
              parentKey: null,
              finalSeq: rows.length,
              owner: { sessionKey: sessionId, ownerEpoch: 1, writerRunId: 'root-owner' },
            },
            {
              sessionKey: childKey,
              kind: 'delegated',
              parentKey: sessionId,
              finalSeq: tools.events.length,
              owner: { sessionKey: childKey, ownerEpoch: 1, writerRunId: 'child-owner' },
            },
          ],
        },
        members: [
          {
            sessionKey: sessionId,
            rows: rows.map((event) => ({ sessionKey: sessionId, event, integrity: null })),
          },
          {
            sessionKey: childKey,
            rows: tools.events.map((event) => ({ sessionKey: childKey, event, integrity: null })),
          },
        ],
      })
    }
    await store.compareAndSwap('pair', 1, {
      ...retired,
      revision: 2,
      retirement: { state: 'released', epoch: 1 },
    })
    expect(await racingReader.scan('jev-archive', { fromSeq: 1, toSeq: 3, limit: 3 })).toEqual(
      await source.scan('jev-archive', { fromSeq: 1, toSeq: 3, limit: 3, order: 'asc' }),
    )
    // Simulate publication between the awaited record read and synchronous archive read.
    const staleRecord = vi.spyOn(store, 'read').mockResolvedValueOnce(original)
    const transitionReader = comparisonArchiveReader(store, original, 'right', {
      head: (id) => source.head(id),
      scan: async (id, query) => [
        ...(await source.scan(id, {
          fromSeq: query.fromSeq ?? 1,
          toSeq: query.toSeq ?? 3,
          limit: query.limit ?? 3,
          order: 'asc',
        })),
      ],
    })
    expect(await transitionReader.scan('jev-archive', { fromSeq: 1, toSeq: 3, limit: 3 })).toEqual(
      await source.scan('jev-archive', { fromSeq: 1, toSeq: 3, limit: 3, order: 'asc' }),
    )
    staleRecord.mockRestore()
    broken = true
    // Every public history view uses the captured archive even when all live ledger reads fail.
    const after = await Promise.all(
      requests.map(([method, args]) => call(owner, `_agnes/v1/comparison.${method}`, args)),
    )
    expect(after).toEqual(before)
    const final = await store.journal.checkpoint('pair', {
      reason: 'recovery',
      cuts: { left: await source.head('native-archive'), right: await source.head('jev-archive') },
    })
    const childInput = { ...input, memberSessionId: 'jev-archive/archived-child', surface: 'web' }
    expect((await call(owner, '_agnes/v1/comparison.projectUI', childInput)).error?.data).toMatchObject({
      code: 'HISTORY_INCOMPLETE',
    })
    // Equal root cuts do not turn an earlier global cursor into the final child archive.
    const later = await store.journal.checkpoint('pair', { reason: 'recovery', cuts: final.cuts })
    expect(
      (await call(owner, '_agnes/v1/comparison.projectUI', { ...childInput, atSeq: final.seq })).error?.data,
    ).toMatchObject({ code: 'HISTORY_INCOMPLETE' })
    const child = await call(owner, '_agnes/v1/comparison.projectUI', { ...childInput, atSeq: later.seq })
    expect(child.error).toBeUndefined()
    expect(child.result).toMatchObject({
      sessionId: childInput.memberSessionId,
      throughSeq: tools.events.length,
      timeline: { sessionId: childInput.memberSessionId, upto: tools.events.length },
    })
    const observed = await store.journal.checkpoint('pair', {
      reason: 'recovery',
      cuts: later.cuts,
      treeCuts: {
        right: {
          complete: true,
          issues: [],
          members: [
            {
              sessionId: 'jev-archive',
              parentSessionId: null,
              runtime: { id: 'jevloop', version: '1' },
              inheritedThroughSeq: 0,
              throughSeq: later.cuts.right,
            },
            {
              sessionId: childInput.memberSessionId,
              parentSessionId: 'jev-archive',
              runtime: { id: 'jevloop', version: '1' },
              inheritedThroughSeq: 0,
              throughSeq: 3,
            },
          ],
        },
      },
    })
    // The terminal global head plus exact archived root cut proves the entire closed tree,
    // even when an inherited live child watermark did not capture its last committed rows.
    expect(
      (await call(owner, '_agnes/v1/comparison.projectUI', { ...childInput, atSeq: observed.seq })).result,
    ).toMatchObject({ throughSeq: tools.events.length })
    const advanced = await store.journal.checkpoint('pair', {
      reason: 'recovery',
      cuts: later.cuts,
      treeCuts: {
        right: {
          complete: true,
          issues: [],
          members: [
            {
              sessionId: 'jev-archive',
              parentSessionId: null,
              runtime: { id: 'jevloop', version: '1' },
              inheritedThroughSeq: 0,
              throughSeq: later.cuts.right,
            },
            {
              sessionId: childInput.memberSessionId,
              parentSessionId: 'jev-archive',
              runtime: { id: 'jevloop', version: '1' },
              inheritedThroughSeq: 0,
              throughSeq: tools.events.length,
            },
          ],
        },
      },
    })
    // A recorded child watermark is readable at an old global cursor even after its archive
    // has the final ledger. Neither the current head nor equal root cuts expand that prefix.
    const prefix = await call(owner, '_agnes/v1/comparison.events', {
      id: 'pair',
      side: 'right',
      memberSessionId: childInput.memberSessionId,
      atSeq: observed.seq,
      afterSeq: 0,
      limit: 100,
    })
    expect(prefix.error).toBeUndefined()
    expect(prefix.result).toMatchObject({ throughSeq: 3, events: tools.events.slice(0, 3) })
    expect(
      (await call(owner, '_agnes/v1/comparison.projectUI', { ...childInput, atSeq: advanced.seq })).result,
    ).toMatchObject({ throughSeq: tools.events.length })
    for (const memberSessionId of ['native-archive/archived-child', 'jev-archive/fake-child'])
      expect(
        (
          await call(owner, '_agnes/v1/comparison.projectUI', {
            ...childInput,
            atSeq: later.seq,
            memberSessionId,
          })
        ).error?.data,
      ).toMatchObject({ code: 'HISTORY_INCOMPLETE' })
    expect(
      (
        await call(stranger, '_agnes/v1/comparison.projectUI', {
          ...childInput,
          atSeq: final.seq,
        })
      ).error,
    ).toBeDefined()
  } finally {
    await owner.close()
    await stranger.close()
    storage.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('replays every stored real comparison cut without a session, workspace or invented generation', async () => {
  const reader = createComparisonHistoryReader(ledger(sessions))
  for (const { lane } of capture.reports) {
    for (const [cut, expected] of Object.entries(views.projections[lane.side])) {
      const timeline = await reader.projectUI({ sessionId: lane.sessionId, throughSeq: Number(cut) })
      expect(timeline).toEqual(expected)
      expect(timeline).not.toHaveProperty('generation')
    }
  }
})

it('pages only the fixed prefix and reports byte-limited progress without claiming completion', async () => {
  const report = capture.reports[0]!
  const reader = createComparisonHistoryReader(ledger(sessions))
  const cut = { sessionId: report.lane.sessionId, throughSeq: 10 }
  const firstBytes = Buffer.byteLength(JSON.stringify(report.events[0]))
  const first = await reader.events({ ...cut, afterSeq: 0, limit: 10, maxBytes: firstBytes })
  expect(first.events).toEqual(report.events.slice(0, 1))
  expect(first).toMatchObject({ complete: false, nextAfterSeq: 1 })
  const events = [...first.events]
  let afterSeq = first.nextAfterSeq
  while (afterSeq < cut.throughSeq) {
    const page = await reader.events({ ...cut, afterSeq, limit: 2 })
    events.push(...page.events)
    expect(page.complete).toBe(page.nextAfterSeq === cut.throughSeq)
    afterSeq = page.nextAfterSeq
  }
  expect(events).toEqual(report.events.slice(0, 10))
  expect(await reader.events({ ...cut, afterSeq: 10 })).toMatchObject({ events: [], complete: true })
  await expect(reader.events({ ...cut, afterSeq: 0, maxBytes: firstBytes - 1 })).rejects.toMatchObject({
    code: 'HISTORY_LIMIT',
  })
})

it.each(['missing', 'reversed', 'duplicate', 'past-cut', 'over-limit', 'short-head'] as const)(
  'refuses %s storage evidence instead of projecting an incomplete history',
  async (mode) => {
    const report = capture.reports[0]!
    const source = ledger(sessions)
    const broken: ComparisonHistoryLedger = {
      head: (id) => (mode === 'short-head' ? Promise.resolve(2) : source.head(id)),
      async scan(id, query) {
        const rows = [...(await source.scan(id, query))]
        if (mode === 'missing') return rows.filter((row) => row.seq !== 2)
        if (mode === 'reversed') return rows.reverse()
        if (mode === 'duplicate') return rows.map((row, i) => (i === 1 ? rows[0]! : row))
        if (mode === 'past-cut') return [{ ...rows[0]!, seq: query.toSeq + 1 }]
        if (mode === 'over-limit') return Array.from({ length: query.limit + 1 }, () => rows[0]!)
        return rows
      },
    }
    const reader = createComparisonHistoryReader(broken)
    const cut = { sessionId: report.lane.sessionId, throughSeq: 3 }
    await expect(reader.projectUI(cut)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' })
    await expect(reader.events({ ...cut, afterSeq: 0, limit: 3 })).rejects.toMatchObject({
      code: 'HISTORY_INCOMPLETE',
    })
  },
)

it('rejects projection budgets and invalid coordinates without returning a truncated timeline', async () => {
  const source = ledger(sessions)
  const cut = { sessionId: capture.reports[0]!.lane.sessionId, throughSeq: 3 }
  for (const limits of [{ maxEvents: 2 }, { maxBytes: 1 }]) {
    await expect(createComparisonHistoryReader(source, limits).projectUI(cut)).rejects.toMatchObject({
      code: 'HISTORY_LIMIT',
    })
  }
  const reader = createComparisonHistoryReader(source)
  await expect(reader.projectUI({ ...cut, throughSeq: -1 })).rejects.toMatchObject({
    code: 'HISTORY_INVALID_ARGUMENT',
  })
  await expect(reader.projectUI({ ...cut, sessionId: 'missing-session' })).rejects.toMatchObject({
    code: 'HISTORY_INCOMPLETE',
  })
  await expect(reader.events({ ...cut, afterSeq: 4 })).rejects.toMatchObject({
    code: 'HISTORY_INVALID_ARGUMENT',
  })
})

it('reads real Jev tool details through the shared bounded serializer and rejects future or mismatched results', async () => {
  const reader = createComparisonHistoryReader(ledger(new Map([['archived-jev', tools.events]])))
  const cut = { sessionId: 'archived-jev', throughSeq: 57 }
  const chunks: Buffer[] = []
  let offset = 0
  for (;;) {
    const result = await reader.readToolDetail({ ...cut, callSeq: 28, resultSeq: 32, offset, maxBytes: 97 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    chunks.push(Buffer.from(result.page.data, 'base64'))
    if (result.page.nextOffset === null) break
    offset = result.page.nextOffset
  }
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({
    call: tools.events.find((row) => row.seq === 28)!.data,
    result: tools.events.find((row) => row.seq === 32)!.data,
  })
  expect(
    await reader.readToolDetail({ ...cut, callSeq: 28, resultSeq: 57, offset: 0, maxBytes: 256 }),
  ).toEqual({ ok: false, reason: 'tool-use-id-mismatch' })
  await expect(
    reader.readToolDetail({ ...cut, throughSeq: 28, callSeq: 28, resultSeq: 32, offset: 0, maxBytes: 256 }),
  ).rejects.toMatchObject({ code: 'HISTORY_INVALID_ARGUMENT' })
  const callOnly = await reader.readToolDetail({
    ...cut,
    throughSeq: 28,
    callSeq: 28,
    offset: 0,
    maxBytes: 262144,
  })
  if (!callOnly.ok) throw new Error(callOnly.reason)
  expect(JSON.parse(Buffer.from(callOnly.page.data, 'base64').toString('utf8'))).toEqual({
    call: tools.events.find((row) => row.seq === 28)!.data,
  })
})
