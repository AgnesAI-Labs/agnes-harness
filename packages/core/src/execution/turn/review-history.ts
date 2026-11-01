import type { Event, Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { sessionIdentity } from '../../loop/scope.js'
import type { SessionImpl } from '../../step/session.js'

type Group = { rows: Event[]; hasReview: boolean; revision: number }
type History = {
  head: Seq
  boundary: number
  roots: Map<number, number>
  groups: Map<number, Group>
  current?: number
  loading?: Promise<void>
}
const histories = new WeakMap<object, Map<string, History>>()
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

/** Reuse only committed, immutable prefixes. Every subsequent read includes the newly committed tail. */
export async function reviewHistory(s: SessionImpl, turn: number): Promise<Group | undefined> {
  const identity = sessionIdentity(s)
  let lanes = histories.get(identity)
  if (!lanes) {
    lanes = new Map()
    histories.set(identity, lanes)
  }
  const boundary = s.d.log.parent?.boundarySeq ?? 0
  let history = lanes.get(s.lane)
  if (!history || history.boundary !== boundary || history.head > s.lastSeq) {
    history = { head: boundary, boundary, roots: new Map(), groups: new Map() }
    lanes.set(s.lane, history)
  }
  const stable = history
  const target = s.lastSeq
  while (stable.head < target) {
    if (!stable.loading) {
      const through = s.lastSeq
      stable.loading = scanAll((query) => s.d.log.scan(query), {
        lane: s.lane,
        fromSeq: stable.head + 1,
        toSeq: through,
        type: [
          'turn/start',
          'turn/end',
          'tool/call',
          'effect/intent',
          'x/core/completion-gate',
          'x/core/completion-review-anchor',
          'x/core/completion-review-stop',
        ],
      })
        .then((rows) => {
          for (const row of rows) indexRow(stable, row)
          stable.head = through
        })
        .finally(() => {
          delete stable.loading
        })
    }
    await stable.loading
  }
  const root = stable.roots.get(turn)
  return root === undefined ? undefined : stable.groups.get(root)
}
