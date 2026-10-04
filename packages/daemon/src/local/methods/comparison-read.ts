import {
  accountComparisonLane,
  aggregateComparisonTreeAccounting,
  ComparisonJournalError,
  projectComparisonPriceDetails,
  type ScopedComparisonStore,
  verifyPreparedReceipt,
} from '@agnes/host'
import type {
  ComparisonEventsParams,
  ComparisonEventsResult,
  ComparisonJournalFact,
  ComparisonJournalParams,
  ComparisonJournalResult,
  ComparisonListParams,
  ComparisonListResult,
  ComparisonMetricsParams,
  ComparisonMetricsResult,
  ComparisonPreparedReceipt,
  ComparisonPriceDetailsParams,
  ComparisonPriceDetailsResult,
  ComparisonProjectUIParams,
  ComparisonProjectUIResult,
  ComparisonReadToolDetailParams,
  ComparisonReadToolDetailResult,
  ComparisonResultSummary,
  EventEnvelope,
} from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import type { ComparisonRecord } from '@agnes/runtime-comparison'
import { TOOL_DETAIL_PAGE_BYTES } from '@agnes/worker-runtime'
import { comparisonAccountingTree } from '../comparison-accounting-tree.js'
import { comparisonArchiveReader } from '../comparison-archive-reader.js'
import { ComparisonHistoryError, createComparisonHistoryReader } from '../comparison-history.js'
import { comparisonLaneResult } from '../comparison-results.js'
import type { LocalEndpoint } from '../endpoint.js'
import type { LocalContext } from './acp.js'
import type { ComparisonLedgerReader, ComparisonStorage } from './comparison.js'

// Leave room for JSON-RPC framing below the transport's 2 MiB ceiling.
const MAX_HISTORY_RESPONSE_BYTES = 1536 * 1024
// Same binary omission contract as diagnostics.events; text and ledger coordinates are retained.
function sanitizeHistory(value: unknown): unknown {
  if (value instanceof Uint8Array) return `[OMITTED:binary:${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.map(sanitizeHistory)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ((record.type === 'image' || record.type === 'audio') && typeof record.data === 'string')
    return { ...record, data: `[OMITTED:${record.type}:base64]` }
  if (record.type === 'base64' && typeof record.data === 'string')
    return { ...record, data: '[OMITTED:binary:base64]' }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitizeHistory(child)]))
}

/** Both aggregate and detail readers validate the same bounded, contiguous source prefix. */
async function accountingPrefix(
  ledger: ComparisonLedgerReader,
  sessionId: string,
  throughSeq: number,
  budget = { events: 100_000, bytes: 16 * 1024 * 1024 },
) {
  const events: EventEnvelope[] = []
  let next = 1
  let bytes = 0
  let complete = true
  while (next <= throughSeq) {
    if (events.length >= 100_000 || bytes >= 16 * 1024 * 1024 || budget.events <= 0 || budget.bytes <= 0) {
      complete = false
      break
    }
    const page = await ledger.scan(sessionId, {
      fromSeq: next,
      toSeq: throughSeq,
      order: 'asc',
      limit: Math.min(128, throughSeq - next + 1, 100_000 - events.length, budget.events),
    })
    if (!page.length) {
      complete = false
      break
    }
    for (const event of page) {
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
      if (
        event.seq !== next ||
        event.seq > throughSeq ||
        events.length >= 100_000 ||
        bytes + size > 16 * 1024 * 1024 ||
        budget.bytes < size ||
        budget.events <= 0
      ) {
        complete = false
        break
      }
      events.push(event)
      bytes += size
      budget.bytes -= size
      budget.events--
      next++
    }
    if (!complete) break
  }
  return { events, complete }
}

/** Fixed durable cuts only: these handlers never create a coordinator, open a session or reconcile. */
export function registerComparisonRead(
  endpoint: LocalEndpoint,
  ownership: LocalContext['sessionOwnership'],
  storage?: ComparisonStorage,
  ledger?: ComparisonLedgerReader,
): void {
  async function readJournal<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ComparisonJournalError) throw rpcError('SEMANTIC_REJECTED', { code: error.code })
      throw error
    }
  }
  async function owned(id: string): Promise<{ store: ScopedComparisonStore; record: ComparisonRecord }> {
    if (!storage) throw rpcError('CAPABILITY_DENIED', { reason: 'durable comparison storage unavailable' })
    const principal = endpoint.conn.principalId
    const store = storage.scoped(principal)
    const record = await store.read(id)
    if (!record) throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_NOT_FOUND' })
    if (record.retirement?.state === 'removed' || record.retirement?.state === 'removing')
      throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_RETIRED' })
    for (const lane of Object.values(record.lanes)) {
      if (lane && ownership?.resolve(lane.sessionId)?.principalId !== principal)
        throw rpcError('CAPABILITY_DENIED')
    }
    return { store, record }
  }
  async function history<T>(
    input: { id: string; side: 'left' | 'right'; atSeq: number; memberSessionId?: string },
    operation: (source: ComparisonLedgerReader, cut: { sessionId: string; throughSeq: number }) => Promise<T>,
  ) {
    const { store, record } = await owned(input.id)
    const cuts = await readJournal(() => store.journal.cutsAt(input.id, input.atSeq))
    const lane = record.lanes[input.side]
    if (!lane) throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_NOT_READY' })
    let cut = { sessionId: lane.sessionId, throughSeq: cuts[input.side] }
    try {
      const source = comparisonArchiveReader(store, record, input.side, ledger)
      if (input.memberSessionId !== undefined && input.memberSessionId !== lane.sessionId) {
        const archive = store.archive.read(record.id, input.side)
        const tree = store.treeArchive.read(record.id, input.side)
        const proof = tree?.proof.members.find((member) => member.sessionKey === input.memberSessionId)
        const observed = (await store.journal.treeCutsAt(record.id, input.atSeq))?.[input.side]?.members.find(
          (member) => member.sessionId === input.memberSessionId,
        )
        const final =
          (await store.journal.head(record.id))?.seq === input.atSeq &&
          cut.throughSeq === archive?.manifest.throughSeq
        if (
          record.retirement?.state !== 'released' ||
          !archive ||
          !tree ||
          !proof ||
          (observed
            ? observed.parentSessionId !== proof.parentKey || observed.throughSeq > proof.finalSeq
            : !final)
        )
          throw new ComparisonHistoryError('HISTORY_INCOMPLETE')
        // A child's durable observation belongs to the selected global cursor. Equal root
        // cuts do not authorize final child history at an earlier coordinator position.
        cut = { sessionId: input.memberSessionId, throughSeq: final ? proof.finalSeq : observed!.throughSeq }
      }
      const result = {
        id: input.id,
        side: input.side,
        atSeq: input.atSeq,
        ...cut,
        ...(await operation(source, cut)),
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES)
        throw new ComparisonHistoryError('HISTORY_LIMIT')
      return result
    } catch (error) {
      throw rpcError('SEMANTIC_REJECTED', {
        code: error instanceof ComparisonHistoryError ? error.code : 'HISTORY_UNAVAILABLE',
      })
    }
  }
  endpoint.register('_agnes/v1/comparison.events', async (params): Promise<ComparisonEventsResult> => {
    const input = params as ComparisonEventsParams
    return history(input, async (source, cut) => {
      const reader = createComparisonHistoryReader({
        head: (id) => source.head(id),
        async scan(id, query) {
          return (await source.scan(id, query)).map((row) => {
            const { _meta: _dropped, ...event } = sanitizeHistory(row) as EventEnvelope & { _meta?: unknown }
            return event
          })
        },
      })
      return reader.events({
        ...cut,
        afterSeq: input.afterSeq,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        maxBytes: Math.min(input.maxBytes ?? 1024 * 1024, MAX_HISTORY_RESPONSE_BYTES - 4096),
      })
    })
  })
  endpoint.register('_agnes/v1/comparison.projectUI', async (params): Promise<ComparisonProjectUIResult> => {
    const input = params as ComparisonProjectUIParams
    return history(input, async (source, cut) => ({
      timeline: await createComparisonHistoryReader(source).projectUI(cut),
    }))
  })
  endpoint.register(
    '_agnes/v1/comparison.readToolDetail',
    async (params): Promise<ComparisonReadToolDetailResult> => {
      const input = params as ComparisonReadToolDetailParams
      return history(input, (source, cut) =>
        createComparisonHistoryReader(source).readToolDetail({
          ...cut,
          callSeq: input.callSeq,
          ...(input.resultSeq === undefined ? {} : { resultSeq: input.resultSeq }),
          offset: input.offset ?? 0,
          maxBytes: input.maxBytes ?? TOOL_DETAIL_PAGE_BYTES,
        }),
      )
    },
  )
  endpoint.register('_agnes/v1/comparison.list', async (params): Promise<ComparisonListResult> => {
    if (!storage) throw rpcError('CAPABILITY_DENIED', { reason: 'durable comparison storage unavailable' })
    return readJournal(() => storage.scoped(endpoint.conn.principalId).list(params as ComparisonListParams))
  })
  endpoint.register('_agnes/v1/comparison.journal', async (params): Promise<ComparisonJournalResult> => {
    const { id, ...page } = params as ComparisonJournalParams
    const { store } = await owned(id)
    return { id, ...(await readJournal(() => store.journal.read(id, page))) }
  })
  endpoint.register(
    '_agnes/v1/comparison.priceDetails',
    async (params): Promise<ComparisonPriceDetailsResult> => {
      const input = params as ComparisonPriceDetailsParams
      const { store, record } = await owned(input.id)
      const cuts = await readJournal(() => store.journal.cutsAt(input.id, input.atSeq))
      const lane = record.lanes[input.side]
      if (!lane) throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_NOT_READY' })
      const tree = await comparisonAccountingTree(store, record, input.side, input.atSeq, cuts[input.side])
      const member = tree.members.find(
        (value) => value.sessionId === (input.memberSessionId ?? lane.sessionId),
      )
      if (!member) throw rpcError('SEMANTIC_REJECTED', { code: 'HISTORY_UNAVAILABLE' })
      const throughSeq = member.throughSeq
      const afterSeq = input.afterSeq ?? 0
      if (afterSeq > throughSeq) throw rpcError('SEMANTIC_REJECTED', { code: 'INVALID_WINDOW' })
      let prefix: Awaited<ReturnType<typeof accountingPrefix>>
      try {
        prefix = await accountingPrefix(
          comparisonArchiveReader(store, record, input.side, ledger),
          member.sessionId,
          throughSeq,
        )
      } catch {
        throw rpcError('SEMANTIC_REJECTED', { code: 'HISTORY_UNAVAILABLE' })
      }
      const projection = projectComparisonPriceDetails({
        sessionId: member.sessionId,
        runtime: member.runtime,
        afterSeq: member.inheritedThroughSeq,
        inheritedThroughSeq: member.inheritedThroughSeq,
        throughSeq,
        ...prefix,
      })
      const candidates = projection.entries.filter((entry) => entry.originSeq > afterSeq)
      const entries: ComparisonPriceDetailsResult['entries'] = []
      let bytes = 2
      for (const entry of candidates) {
        if (entries.length >= (input.limit ?? 25)) break
        const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (entries.length ? 1 : 0)
        if (bytes + size > (input.maxBytes ?? 256 * 1024)) {
          if (!entries.length) throw rpcError('SEMANTIC_REJECTED', { code: 'PRICE_DETAIL_LIMIT' })
          break
        }
        entries.push(entry)
        bytes += size
      }
      const complete = entries.length === candidates.length
      return {
        id: input.id,
        side: input.side,
        atSeq: input.atSeq,
        sessionId: member.sessionId,
        runtime: member.runtime,
        throughSeq,
        afterSeq,
        entries,
        nextAfterSeq: complete ? throughSeq : (entries.at(-1)?.originSeq ?? afterSeq),
        complete,
        evidenceComplete: projection.evidenceComplete,
        issues: projection.issues,
      }
    },
  )
  endpoint.register('_agnes/v1/comparison.metrics', async (params): Promise<ComparisonMetricsResult> => {
    const { id, atSeq } = params as ComparisonMetricsParams
    const { store, record } = await owned(id)
    const cuts = await readJournal(() => store.journal.cutsAt(id, atSeq))
    // This is coordinator publication evidence at the requested prefix, never the current record.
    const prepared: Partial<Record<'left' | 'right', ComparisonPreparedReceipt>> = {}
    let coordinator: Extract<ComparisonJournalFact, { kind: 'coordinator' }> | undefined
    let coordinatorSeq = 0
    const rounds = new Map<
      string,
      NonNullable<Extract<ComparisonJournalFact, { kind: 'coordinator' }>['latestRound']>
    >()
    let afterSeq = 0
    while (afterSeq < atSeq) {
      if (afterSeq >= 100_000) throw rpcError('SEMANTIC_REJECTED', { code: 'JOURNAL_LIMIT' })
      const page = await readJournal(() =>
        store.journal.read(id, { afterSeq, throughSeq: atSeq, limit: 1000 }),
      )
      for (const entry of page.entries)
        if (entry.fact.kind === 'coordinator') {
          coordinator = entry.fact
          coordinatorSeq = entry.seq
          if (entry.fact.latestRound) rounds.set(entry.fact.latestRound.inputId, entry.fact.latestRound)
          for (const side of ['left', 'right'] as const) {
            const receipt = entry.fact.latestRound?.prepared?.[side] ?? entry.fact.prepared?.[side]
            if (receipt) prepared[side] = receipt
          }
        }
      if (page.complete) break
      if (page.nextAfterSeq <= afterSeq) throw rpcError('SEMANTIC_REJECTED', { code: 'JOURNAL_INCOMPLETE' })
      afterSeq = page.nextAfterSeq
    }
    const lanes: ComparisonMetricsResult['lanes'] = []
    const summary: ComparisonResultSummary = {
      coordinatorSeq,
      roundCount: coordinator?.roundCount ?? 0,
      inputId: coordinator?.latestRound?.inputId ?? null,
      lanes: [],
    }
    for (const side of ['left', 'right'] as const) {
      const lane = record.lanes[side]
      const binding = coordinator?.lanes[side]
      if (!lane || !binding) continue
      if (
        binding.sessionId !== lane.sessionId ||
        binding.runtime.id !== lane.runtime.id ||
        binding.runtime.version !== lane.runtime.version
      )
        throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_BINDING_CHANGED' })
      const budget = { events: 50_000, bytes: 8 * 1024 * 1024 }
      const throughSeq = cuts[side]
      const tree = await comparisonAccountingTree(store, record, side, atSeq, throughSeq)
      const source = comparisonArchiveReader(store, record, side, ledger)
      const members: NonNullable<ComparisonMetricsResult['lanes'][number]['members']> = []
      const accountings: ReturnType<typeof accountComparisonLane>[] = []
      let rootEvents: EventEnvelope[] = []
      let rootComplete = false
      for (const member of tree.members) {
        let prefix: Awaited<ReturnType<typeof accountingPrefix>>
        try {
          prefix = await accountingPrefix(source, member.sessionId, member.throughSeq, budget)
        } catch {
          prefix = { events: [], complete: false }
        }
        if (member.sessionId === lane.sessionId) {
          rootEvents = prefix.events
          rootComplete = prefix.complete
        }
        const accounting = accountComparisonLane({
          ...member,
          afterSeq: member.inheritedThroughSeq,
          ...prefix,
        })
        accountings.push(accounting)
        members.push({
          ...member,
          accounting,
          complete: prefix.complete && !accounting.issues.length,
          issues: accounting.issues,
        })
      }
      const treeComplete = tree.complete && members.every((member) => member.complete)
      const aggregate = aggregateComparisonTreeAccounting(accountings, throughSeq, treeComplete)
      aggregate.issues = [...new Set([...aggregate.issues, ...tree.issues])]
      summary.lanes.push(
        await comparisonLaneResult({
          side,
          sessionId: lane.sessionId,
          throughSeq,
          events: rootEvents,
          complete: rootComplete,
          ...(coordinator ? { coordinator } : {}),
          rounds,
        }),
      )
      const receipt = prepared[side]
      lanes.push({
        side,
        sessionId: lane.sessionId,
        runtime: lane.runtime,
        treeComplete,
        members,
        prepared:
          receipt &&
          receipt.sessionId === lane.sessionId &&
          receipt.sourceSeq <= throughSeq &&
          receipt.configuration.runtime.id === lane.runtime.id &&
          receipt.configuration.runtime.version === lane.runtime.version &&
          verifyPreparedReceipt(receipt, rootEvents)
            ? receipt
            : null,
        accounting: aggregate,
      })
    }
    const result = { id, atSeq, cuts, lanes, summary }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES)
      throw rpcError('SEMANTIC_REJECTED', { code: 'METRICS_LIMIT' })
    return result
  })
}
