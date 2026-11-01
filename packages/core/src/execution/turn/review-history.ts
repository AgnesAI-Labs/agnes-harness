import { CoreError, type Event, type Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { sessionIdentity } from '../../loop/scope.js'
import type { SessionImpl } from '../../step/session.js'

type Group = { rows: Event[]; hasReview: boolean; revision: number }
type Batch = { from: Seq; through: Seq; rows: Event[] }
type History = {
  head: Seq
  boundary: number
  roots: Map<number, number>
  groups: Map<number, Group>
  current?: number
  loading?: Promise<void>
  pending: Batch[]
  dispose: () => void
}
const histories = new WeakMap<object, Map<string, History>>()
const types = [
  'turn/start',
  'turn/end',
  'tool/call',
  'effect/intent',
  'x/core/completion-gate',
  'x/core/completion-review-anchor',
  'x/core/completion-review-stop',
]
const object = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

function indexRow(history: History, row: Event): void {
  if (row.type === 'turn/start') {
    const data = object(row.data)
    const turn = data?.turn
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return
    const previous = object(data?.continues)?.turn
    // This index groups candidate lineage only. The reader validates trust, provenance and anchors.
    const root =
      history.roots.get(turn) ??
      (data?.trigger === 'approval-resume' && typeof previous === 'number'
        ? history.roots.get(previous)
        : undefined) ??
      turn
    history.roots.set(turn, root)
    history.current = root
  }
  if (history.current === undefined) return
  let group = history.groups.get(history.current)
  if (!group) {
    group = { rows: [], hasReview: false, revision: 0 }
    history.groups.set(history.current, group)
  }
  group.rows.push(row)
  group.revision++
  if (
    row.type === 'x/core/completion-review-anchor' ||
    row.type === 'x/core/completion-review-stop' ||
    (row.type === 'x/core/completion-gate' &&
      row.origin === 'system' &&
      row.trust === 'trusted' &&
      object(row.data)?.diagnostic === 'completion_gate_contract_review' &&
      object(row.data)?.status === 'ran')
  )
    group.hasReview = true
}

/** Advance only over complete committed batches; a gap must first be recovered from the ledger. */
function applyPending(history: History): void {
  while (history.pending.length) {
    const batch = history.pending[0]
    if (!batch || batch.from > history.head + 1) return
    history.pending.shift()
    if (batch.through <= history.head) continue
    for (const row of batch.rows) if (row.seq > history.head) indexRow(history, row)
    history.head = batch.through
  }
}

/** Subscribe before the owner can append, including while its cold prefix is still unread. */
export function observeReviewHistory(s: SessionImpl): History {
  const identity = sessionIdentity(s)
  let lanes = histories.get(identity)
  if (!lanes) {
    lanes = new Map()
    histories.set(identity, lanes)
  }
  const boundary = s.d.log.parent?.boundarySeq ?? 0
  let history = lanes.get(s.lane)
  if (!history || history.boundary !== boundary || history.head > s.lastSeq) {
    if (s.closingOrClosed) throw new CoreError('E_CLOSED', 'Session closed')
    history?.dispose()
    history = {
      head: boundary,
      boundary,
      roots: new Map(),
      groups: new Map(),
      pending: [],
      dispose: () => undefined,
    }
    lanes.set(s.lane, history)
    const stable = history
    stable.dispose = s.onAppended((rows) => {
      const first = rows[0]
      const last = rows.at(-1)
      if (histories.get(identity)?.get(s.lane) !== stable || !first || !last) return
      // observeCommitted gives this owner its own snapshot, isolated from append callers and readers.
      stable.pending.push({
        from: first.seq,
        through: last.seq,
        rows: rows.filter((row) => (row.lane ?? 'main') === s.lane && types.includes(row.type)),
      })
      if (!stable.loading) applyPending(stable)
    })
  }
  return history
}

export function disposeReviewHistory(s: SessionImpl): void {
  const identity = sessionIdentity(s)
  for (const history of histories.get(identity)?.values() ?? []) {
    history.dispose()
    history.pending.length = 0
  }
  histories.delete(identity)
}

/** Reuse committed snapshots; read only missing ranges, never an already observed hot tail. */
export async function reviewHistory(s: SessionImpl, turn: number): Promise<Group | undefined> {
  s.d.log.sealCheck()
  const stable = observeReviewHistory(s)
  const target = s.lastSeq
  while (stable.head < target) {
    if (!stable.loading) {
      applyPending(stable)
      if (stable.head >= target) break
      const through = Math.min(target, (stable.pending[0]?.from ?? target + 1) - 1)
      stable.loading = scanAll(async (query) => structuredClone(await s.d.log.scan(query)), {
        lane: s.lane,
        fromSeq: stable.head + 1,
        toSeq: through,
        type: types,
      })
        .then((rows) => {
          for (const row of rows) indexRow(stable, row)
          stable.head = through
        })
        .finally(() => {
          delete stable.loading
          applyPending(stable)
        })
    }
    await stable.loading
  }
  s.d.log.sealCheck()
  if (histories.get(sessionIdentity(s))?.get(s.lane) !== stable)
    throw new CoreError('E_CLOSED', 'Review history owner closed or replaced')
  const root = stable.roots.get(turn)
  return root === undefined ? undefined : stable.groups.get(root)
}
