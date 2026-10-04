import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComparisonStore } from '@agnes/host'
import type {
  ComparisonMetricsResult,
  ComparisonPriceDetailsResult,
  ComparisonTreeCuts,
  EventEnvelope,
  RuntimeIdentity,
} from '@agnes/protocol'
import type { ComparisonRecord } from '@agnes/runtime-comparison'
import { expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import type { LocalContext } from '../src/local/methods/acp.js'
import { registerComparisonRead } from '../src/local/methods/comparison-read.js'
import type { JsonRpcResponse } from '../src/rpc.js'

const recorded = JSON.parse(
  readFileSync('packages/host/test/fixtures/comparison-tree-accounting-real.json', 'utf8'),
) as {
  members: Array<{
    side: 'left' | 'right'
    sessionId: string
    parentSessionId: string | null
    runtime: RuntimeIdentity
    inheritedThroughSeq: number
    throughSeq: number
    events: EventEnvelope[]
  }>
}
it('accounts all four real captured sessions only at their journal cuts and pages member prices identically after release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-tree-metrics-'))
  const storage = createComparisonStore(join(dir, 'index.sqlite'))
  const endpoint = new LocalEndpoint({ principalId: 'owner', clock: Date.now })
  endpoint.conn.initialized = true
  const store = storage.scoped('owner')
  const rows = new Map(recorded.members.map((member) => [member.sessionId, member.events]))
  let missingChild = false
  const forbidden = (): never => {
    throw new Error('No ownership mutation')
  }
  const ownership: NonNullable<LocalContext['sessionOwnership']> = {
    resolve: () => ({ active: true, principalId: 'owner' }),
    bindNew: forbidden,
    ownsNewReservation: forbidden,
    activateNew: forbidden,
    inherit: forbidden,
    activateFork: forbidden,
    activeSessionIds: forbidden,
  }
  registerComparisonRead(endpoint, ownership, storage, {
    head: async (key) => rows.get(key)?.length ?? 0,
    scan: async (key, query) =>
      missingChild && key === 'captured-left-child'
        ? []
        : (rows.get(key) ?? [])
            .filter((row) => row.seq >= (query.fromSeq ?? 1) && row.seq <= (query.toSeq ?? Infinity))
            .slice(0, query.limit ?? 1000),
  })
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const reply = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 1,
      method: `_agnes/v1/comparison.${method}`,
      params,
    })) as JsonRpcResponse
    if (reply.error) throw new Error(JSON.stringify(reply.error))
    return reply.result as T
  }
  try {
    let record: ComparisonRecord = {
      id: 'pair',
      revision: 0,
      creation: 'ready',
      createPayload: '{}',
      rounds: [],
      cancellation: {},
      cleanup: { exited: [], released: false },
      lanes: {},
    }
    const treeCuts: ComparisonTreeCuts = {}
    for (const side of ['left', 'right'] as const) {
      const root = recorded.members.find((member) => member.side === side && !member.parentSessionId)
      if (!root) throw new Error('Missing root')
      record.lanes[side] = {
        side,
        sessionId: root.sessionId,
        runtime: root.runtime,
        workspaceLabel: side,
        phase: 'idle',
        lastSeq: root.throughSeq,
      }
      treeCuts[side] = {
        complete: true,
        issues: [],
        members: recorded.members
          .filter((member) => member.side === side)
          .map(({ events: _events, side: _side, ...member }) => member),
      }
    }
    await store.compareAndSwap('pair', null, record)
    const cuts = { left: 115, right: 120 }
    const old = await store.journal.checkpoint('pair', { reason: 'recovery', cuts })
    const oldMetrics = await call<ComparisonMetricsResult>('metrics', { id: 'pair', atSeq: old.seq })
    expect(oldMetrics.lanes.map((lane) => lane.treeComplete)).toEqual([false, false])
    expect(oldMetrics.lanes[0]?.accounting.llm.attempts).toBe(6)
    const earlier = structuredClone(treeCuts)
    const earlyChild = earlier.left?.members.find((member) => member.parentSessionId)
    if (!earlyChild) throw new Error('Missing child')
    earlyChild.throughSeq = 1
    const early = await store.journal.checkpoint('pair', { reason: 'recovery', cuts, treeCuts: earlier })
    const frozen = await call<ComparisonMetricsResult>('metrics', { id: 'pair', atSeq: early.seq })
    expect(frozen.lanes[0]?.accounting.llm.attempts).toBe(6)
    const full = await store.journal.checkpoint('pair', { reason: 'recovery', cuts, treeCuts })
    const metrics = await call<ComparisonMetricsResult>('metrics', { id: 'pair', atSeq: full.seq })
    expect(metrics.lanes.map((lane) => lane.treeComplete)).toEqual([true, true])
    expect(metrics.lanes.map((lane) => lane.members?.length)).toEqual([2, 2])
    expect(metrics.lanes[0]?.accounting.llm.attempts).toBe(9)
    expect(metrics.lanes[1]?.accounting.llm.attempts).toBe(7)
    expect(metrics.lanes[1]?.accounting.jev.attempts).toBe(6)
    expect(await call('metrics', { id: 'pair', atSeq: early.seq })).toEqual(frozen)
    const details = async (atSeq: number) => {
      const result: Record<string, ComparisonPriceDetailsResult['entries']> = {}
      for (const member of recorded.members) {
        const entries: ComparisonPriceDetailsResult['entries'] = []
        let afterSeq = 0
        for (let n = 0; n < 30; n++) {
          const page = await call<ComparisonPriceDetailsResult>('priceDetails', {
            id: 'pair',
            side: member.side,
            atSeq,
            memberSessionId: member.sessionId,
            afterSeq,
            limit: 1,
          })
          expect(page.sessionId).toBe(member.sessionId)
          expect(page.throughSeq).toBe(member.throughSeq)
          entries.push(...page.entries)
          if (page.complete) break
          expect(page.nextAfterSeq).toBeGreaterThan(afterSeq)
          afterSeq = page.nextAfterSeq
        }
        result[member.sessionId] = entries
      }
      return result
    }
    const liveDetails = await details(full.seq)
    expect(Object.values(liveDetails).map((entries) => entries.length)).toEqual([6, 3, 7, 6])
    await expect(
      call('priceDetails', {
        id: 'pair',
        side: 'left',
        atSeq: full.seq,
        memberSessionId: 'captured-right-child',
      }),
    ).rejects.toThrow('HISTORY_UNAVAILABLE')
    missingChild = true
    const partial = await call<ComparisonMetricsResult>('metrics', { id: 'pair', atSeq: full.seq })
    expect(partial.lanes[0]?.treeComplete).toBe(false)
    expect(partial.lanes[0]?.accounting.issues).toContain('incomplete_tree')
    missingChild = false
    record = { ...record, revision: 1, retirement: { state: 'releasing', epoch: 1 } }
    await store.compareAndSwap('pair', 0, record)
    for (const side of ['left', 'right'] as const) {
      const members = recorded.members.filter((member) => member.side === side)
      const root = members.find((member) => !member.parentSessionId)
      if (!root) throw new Error('Missing root')
      store.archive.write('pair', side, {
        sessionId: root.sessionId,
        epoch: 1,
        throughSeq: root.throughSeq,
        rows: root.events.map((event) => ({ sessionKey: root.sessionId, event, integrity: null })),
      })
      store.treeArchive.write('pair', side, {
        proof: {
          rootSessionKey: root.sessionId,
          retirementId: `comparison:pair:${side}`,
          epoch: 1,
          members: members.map((member) => ({
            sessionKey: member.sessionId,
            parentKey: member.parentSessionId,
            kind: member.parentSessionId ? 'delegated' : 'root',
            finalSeq: member.throughSeq,
            owner: { sessionKey: member.sessionId, writerRunId: 'fixture-owner', ownerEpoch: 1 },
          })),
        },
        members: members.map((member) => ({
          sessionKey: member.sessionId,
          rows: member.events.map((event) => ({ sessionKey: member.sessionId, event, integrity: null })),
        })),
      })
    }
    await store.compareAndSwap('pair', 1, {
      ...record,
      revision: 2,
      retirement: { state: 'released', epoch: 1 },
    })
    const final = await store.journal.head('pair')
    if (!final) throw new Error('Missing journal')
    rows.clear()
    const archived = await call<ComparisonMetricsResult>('metrics', { id: 'pair', atSeq: final.seq })
    expect(archived.lanes).toEqual(metrics.lanes)
    expect(await details(final.seq)).toEqual(liveDetails)
    expect(await call('metrics', { id: 'pair', atSeq: old.seq })).toEqual(oldMetrics)
    expect(await call('metrics', { id: 'pair', atSeq: early.seq })).toEqual(frozen)
  } finally {
    await endpoint.close()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
