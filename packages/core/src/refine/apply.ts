import type { Event, EventInput, Seq } from '@agnes/core-common/types'
import type { RefineProposal } from '@agnes/core-effects/effects/seams'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { AppendOptions } from '@agnes/core-ledger/log/session-log'
import { isRegisterTombstone } from '@agnes/core-ledger/log/storage'
import { foldEntryMeta } from '@agnes/core-ledger/reduce/refinement-entry-meta'
import type { HarnessEdit, HarnessEntry, HarnessRefine } from '@agnes/core-ledger/reduce/shapes'
import { type LedgerState, REFINEMENT_ENTRY_META_EVENT } from '@agnes/core-ledger/reduce/state'
import type { SessionImpl } from '../step/session.js'

/**
 * What one refinement apply is allowed to do: at most `maxEdits` edits of at most `maxChars`
 * characters each, and at most `safetyCap` counted entries per kind (a runaway-growth guard; nothing
 * is ever evicted). `contractPrefixMarkers` defaults to `[]` when a deployment reserves no prefix
 * for its own contract-carrying content.
 */
export type ApplyLimits = {
  maxEdits: number
  maxChars: number
  safetyCap: number
  contractPrefixMarkers?: string[]
  // Test hook: stands in for the handed-off marker until it exists.
  isCounted?: (entry: HarnessEntry) => boolean
}

/**
 * Whether an entry weighs on the per-kind safety cap. Only valid, not handed-off entries should;
 * the handed-off marker does not exist yet, so for now every live entry counts. A caller can supply
 * its own predicate through `ApplyLimits.isCounted`.
 */
export const isCountedEntry = (_entry: HarnessEntry): boolean => true

/** A refinement proposal as `applyRefine` takes it: a run id is mandatory, since it is the idempotency key. */
export type ApplyProposal = RefineProposal & { runId: string }

/**
 * How the caller wants the outcome committed: guarded by a register compare-and-set (the facade uses
 * the lane's `op.state` cell, so an apply never lands in a turn another writer just opened), and
 * together with rows of its own built from the outcome, in the same transaction.
 */
export type ApplyCommit = {
  expectedRegisterSeq?: AppendOptions['expectedRegisterSeq']
  with?: (result: { outcome: HarnessRefine['outcome']; reason?: string }) => EventInput[]
}

// The NUL separator `registerKey` (log/storage.ts) joins `kind` and `id` with, spelled through
// fromCharCode rather than a `\u` escape so the character survives round-tripping as source text
// rather than risking a literal control byte landing in the file.
const SEP = String.fromCharCode(0)
/**
 * The register key a `harness/entry` cell lives under: `kind` and `id` joined with the same NUL
 * separator `registerKey` (log/storage.ts) uses when it derives the key from a committed event's
 * `data`. A slash would be ambiguous — `{kind:'a/b', id:'c'}` and `{kind:'a', id:'b/c'}` both spell
 * `a/b/c` — which is exactly why storage.ts rejected it; this mirrors that choice rather than
 * introducing a second, differently-spelled key for the same cell.
 */
export const entryKey = (e: { kind: HarnessEntry['kind']; id: string }): string => `${e.kind}${SEP}${e.id}`

/**
 * The token that changes with every write of an entry: the seq of the row that set its cell, or,
 * while it is gone, the seq of the row that recorded its removal; 0 for an id never written. A delete
 * and a re-create therefore never read as the entry that was there before, even at the same version.
 */
export function mutationToken(state: LedgerState, key: string): Seq {
  return state.registers.harnessEntries.get(key)?.seq ?? state.refinementTombstones.get(key)?.seq ?? 0
}

/** The version the next write of an entry builds on: its own, or the one it had when it was removed. */
export function lastVersion(state: LedgerState, key: string): number {
  const cell = state.registers.harnessEntries.get(key)
  if (cell) return typeof cell.value?.version === 'number' ? cell.value.version : 0
  return state.refinementTombstones.get(key)?.version ?? 0
}

/** The row an apply writes right after an entry's tombstone: what the entry leaves behind. */
const tombstoneRow = (s: SessionImpl, e: { kind: HarnessEntry['kind']; id: string }, version: number) =>
  s.ev(
    REFINEMENT_ENTRY_META_EVENT,
    { version: 1, kind: e.kind, id: e.id, removed: true, entryVersion: version },
    { ignorable: true },
  )

/**
 * Applies one refinement proposal as a single ledger transaction, and at most once per `runId`.
 *
 * The caller must hold the session writer lock: this reads the register table and then appends,
 * and nothing here prevents another writer from moving the table in between. (The Core facade is
 * the only intended caller.)
 *
 * Checks, in order, each recorded as one `harness/refine` row when it fails:
 * 1. a `runId` already on the log returns that row's outcome and seq without writing;
 * 2. the whole proposal is rejected for too many edits, two edits on one key, a baseline entry no
 *    edit touches that has moved (`rejected:conflict`, reason `stale-baseline`; moved means another
 *    version or, when the baseline names one, another mutation token), an unknown evidence seq
 *    (`rejected:evidence`), an oversized entry (`rejected:limit`) or a contract prefix
 *    (`rejected:prefix`);
 * 3. an edit whose own baseline version has moved rejects the whole proposal as
 *    `rejected:conflict` (reason `stale-edit`; the moved edits are listed in `rejectedEdits`, a
 *    diagnostic only: nothing is written but the control row);
 * 4. if the edits would push any kind past the safety cap the whole proposal is `rejected:limit`
 *    with reason `capacity`; nothing is deleted to make room.
 *
 * Apply is atomic: on success the transaction is the control row followed by one `harness/entry`
 * row per edit (an `upsert` bumping `version`, a `delete` writing the tombstone form followed by the
 * metadata row that records the removal). An entry written again after a delete continues from the
 * version it was removed at, so it never reads as the removed one.
 *
 * `runId` is required: it is the idempotency key, and a caller that forgot it would silently lose
 * at-most-once. A missing or empty one throws before anything is read or written.
 */
export async function applyRefine(
  s: SessionImpl,
  p: ApplyProposal,
  l: ApplyLimits,
  commit: ApplyCommit = {},
): Promise<{ outcome: HarnessRefine['outcome']; reason?: string; seq: Seq }> {
  if (typeof p.runId !== 'string' || p.runId === '') throw new TypeError('applyRefine requires a runId')
  const limits = {
    maxEdits: l.maxEdits,
    maxChars: l.maxChars,
    safetyCap: l.safetyCap,
    markers: l.contractPrefixMarkers ?? [],
    isCounted: l.isCounted ?? isCountedEntry,
  }
  const entries = s.state.registers.harnessEntries
  const editKey = (e: HarnessEdit): string => entryKey(e.op === 'upsert' ? e.entry : e)
  const append = (events: EventInput[], result: { outcome: HarnessRefine['outcome']; reason?: string }) =>
    s.d.log.append([...events, ...(commit.with?.(result) ?? [])], {
      refineCaller: true,
      ...(commit.expectedRegisterSeq ? { expectedRegisterSeq: commit.expectedRegisterSeq } : {}),
    })

  const prior = await findRun(s, p.runId)
  if (prior) return prior

  const buildRefineEvent = (
    outcome: HarnessRefine['outcome'],
    extra: { reason?: string; rejectedEdits?: HarnessRefine['rejectedEdits'] } = {},
  ): EventInput =>
    s.ev('harness/refine', {
      proposalId: p.proposalId,
      trigger: p.trigger,
      outcome,
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      runId: p.runId,
      edits: p.edits,
      baseline: p.baseline.map(({ key, version }) => ({ key, version })),
      ...(extra.rejectedEdits !== undefined ? { rejectedEdits: extra.rejectedEdits } : {}),
      rationale: p.rationale,
      evidenceSeqs: p.evidenceSeqs,
      ...(p.rollbackOf !== undefined ? { rollbackOf: p.rollbackOf } : {}),
    })
  // A rejection is recorded, not swallowed: the attempt (and why it failed) stays on the ledger even
  // though no harness/entry row is written.
  const reject = async (
    outcome: Exclude<HarnessRefine['outcome'], 'applied'>,
    reason: string,
    extra: Parameters<typeof buildRefineEvent>[1] = {},
  ): Promise<{ outcome: HarnessRefine['outcome']; reason: string; seq: Seq }> => {
    const r = await append([buildRefineEvent(outcome, { ...extra, reason })], { outcome, reason })
    return { outcome, reason, seq: r.firstSeq }
  }

  if (p.edits.length > limits.maxEdits) return reject('rejected:limit', 'max-edits')
  const touched = new Set<string>()
  for (const e of p.edits) {
    const k = editKey(e)
    if (touched.has(k)) return reject('rejected:conflict', 'duplicate-key')
    touched.add(k)
  }

  // A baseline entry that no edit touches is something the proposal relied on without changing; if
  // it moved, the whole plan was made against a table that no longer exists.
  const moved = (b: ApplyProposal['baseline'][number]) =>
    (entries.get(b.key)?.value.version ?? 0) !== b.version ||
    (b.seq !== undefined && mutationToken(s.state, b.key) !== b.seq)
  const baselineOf = new Map(p.baseline.map((b) => [b.key, b]))
  for (const b of p.baseline)
    if (!touched.has(b.key) && moved(b)) return reject('rejected:conflict', 'stale-baseline')

  // Every cited seq must be a real row already on this log: an exact lookup, not a type check,
  // because the proposal is citing *why* it exists, not what kind of row that is.
  for (const seq of p.evidenceSeqs) {
    if (seq < 1 || seq > s.lastSeq) return reject('rejected:evidence', 'unknown-evidence')
    const hit = await s.d.log.scan({ fromSeq: seq, toSeq: seq })
    if (hit.length === 0) return reject('rejected:evidence', 'unknown-evidence')
  }

  for (const e of p.edits) {
    if (e.op !== 'upsert') continue
    if (e.entry.content.length > limits.maxChars) return reject('rejected:limit', 'max-chars')
    if (limits.markers.some((m) => e.entry.content.includes(m))) return reject('rejected:prefix', 'prefix')
  }

  // An edit whose own baseline version has moved was planned against an entry that has since
  // changed; the proposal is atomic, so it is rejected whole. The moved edits are listed for
  // diagnosis.
  const rejectedEdits: { index: number; reason: string }[] = []
  p.edits.forEach((e, index) => {
    const want = baselineOf.get(editKey(e))
    if (want !== undefined && moved(want)) rejectedEdits.push({ index, reason: 'stale-edit' })
  })
  if (rejectedEdits.length > 0) return reject('rejected:conflict', 'stale-edit', { rejectedEdits })

  // Safety cap: what each kind would hold after the edits, counting only entries that
  // weigh on it. Only a kind that grows can trip it, so tidying an over-cap kind always works.
  const growth = new Map<HarnessEntry['kind'], number>()
  const counted = new Map<HarnessEntry['kind'], number>()
  for (const cell of entries.values())
    if (limits.isCounted(cell.value)) counted.set(cell.value.kind, (counted.get(cell.value.kind) ?? 0) + 1)
  for (const e of p.edits) {
    const cur = entries.get(editKey(e))?.value
    const before = cur && limits.isCounted(cur) ? 1 : 0
    const kind = e.op === 'upsert' ? e.entry.kind : e.kind
    const after = e.op === 'upsert' && limits.isCounted(e.entry) ? 1 : 0
    growth.set(kind, (growth.get(kind) ?? 0) + after - before)
  }
  for (const [kind, g] of growth)
    if (g > 0 && (counted.get(kind) ?? 0) + g > limits.safetyCap) return reject('rejected:limit', 'capacity')

  // Passed every check: one transaction, the control row first so a reader scanning forward sees
  // the outcome before the rows it produced.
  const events: EventInput[] = [buildRefineEvent('applied')]
  for (const e of p.edits) {
    if (e.op === 'upsert') {
      const version = lastVersion(s.state, entryKey(e.entry)) + 1
      events.push(s.ev('harness/entry', { ...e.entry, version }, { register: 'harness/entry' }))
    } else {
      events.push(
        s.ev('harness/entry', { kind: e.kind, id: e.id, tombstone: true }, { register: 'harness/entry' }),
        tombstoneRow(s, e, lastVersion(s.state, entryKey(e))),
      )
    }
  }
  const r = await append(events, { outcome: 'applied' })
  return { outcome: 'applied', seq: r.firstSeq }
}

/**
 * The `harness/refine` row an earlier call with this `runId` wrote, as that call returned it. A run
 * is final once it has a row, whatever its outcome: a replay must not re-evaluate it against a
 * table that has since moved.
 */
async function findRun(
  s: SessionImpl,
  runId: string,
): Promise<{ outcome: HarnessRefine['outcome']; reason?: string; seq: Seq } | undefined> {
  for await (const page of scanPages((q) => s.d.log.scan(q), { fromSeq: 1, type: 'harness/refine' })) {
    for (const row of page) {
      const d = row.data as HarnessRefine | null
      if (d?.runId === runId)
        return { outcome: d.outcome, ...(d.reason !== undefined ? { reason: d.reason } : {}), seq: row.seq }
    }
  }
  return undefined
}

/** How a rollback ended: written, or refused because a later change touched what it would undo. */
export type RollbackOutcome =
  | { outcome: 'applied'; seq: Seq }
  | {
      outcome: 'rejected:conflict'
      reason: 'changed-since'
      changed: { kind: HarnessEntry['kind']; id: string }[]
    }

/** What a rollback refuses to undo: a row that is not an applied refine, or a rollback itself. */
export type RollbackProblem = 'not-found' | 'not-applied' | 'is-rollback' | 'rejected'

/** Why `rollbackRefine` cannot start, or undefined when the row at `refineSeq` can be rolled back. */
export async function rollbackProblem(s: SessionImpl, refineSeq: Seq): Promise<RollbackProblem | undefined> {
  if (!Number.isSafeInteger(refineSeq) || refineSeq < 1 || refineSeq > s.lastSeq) return 'not-found'
  const row = (await s.d.log.scan({ fromSeq: refineSeq, toSeq: refineSeq }))[0]
  if (row?.type !== 'harness/refine') return 'not-found'
  const d = row.data as HarnessRefine
  if (d.outcome !== 'applied') return 'not-applied'
  if (d.trigger === 'rollback') return 'is-rollback'
  const prior = await findRun(s, `rollback:${refineSeq}`)
  return prior && prior.outcome !== 'applied' ? 'rejected' : undefined
}

/**
 * Undoes an earlier *applied* refine by expressing the opposite edits as a brand-new
 * `harness/refine{trigger:'rollback'}` — never by deleting or rewriting the row being undone, which
 * would erase the very history a rollback is supposed to be accountable against.
 *
 * A rollback undoes only what that refine left: every entry it wrote must still be exactly as it
 * wrote it (the cell set by its own row, or, for a delete, still gone since that delete). If anything
 * changed one of them since, nothing is written and the result is `rejected:conflict` with reason
 * `changed-since`: undoing it now would overwrite a later change, and a person has to decide.
 *
 * For each original edit, the key's value immediately before `refineSeq` is read back off the
 * `harness/entry` event stream (a tombstone there counts as "did not exist"). If a value is found
 * the inverse edit restores it, together with the validity metadata that was bound to it (so a
 * restored task-level entry stays bound to its task); otherwise the inverse edit deletes the key,
 * which is the correct undo of an edit that created it. `applyRefine` recomputes `version` from the
 * current cell (or the removed one) either way, so the stale `version` on a restored entry is never
 * read. The caller holds the session writer lock.
 */
export async function rollbackRefine(s: SessionImpl, refineSeq: Seq): Promise<RollbackOutcome> {
  const problem = await rollbackProblem(s, refineSeq)
  if (problem === 'not-found') throw new Error(`no harness/refine event at seq ${refineSeq}`)
  if (problem === 'not-applied' || problem === 'is-rollback')
    throw new Error(`cannot roll back refine at seq ${refineSeq}: ${problem}`)
  if (problem === 'rejected') throw new Error(`rollback of refine at seq ${refineSeq} was itself rejected`)
  const row = (await s.d.log.scan({ fromSeq: refineSeq, toSeq: refineSeq }))[0] as Event
  const d = row.data as HarnessRefine

  // A repeated rollback of the same refine is the run already recorded: same seq, nothing written
  // (not even the diagnostic below).
  const prior = await findRun(s, `rollback:${refineSeq}`)
  if (prior) return { outcome: 'applied', seq: prior.seq }

  const keyOf = (e: HarnessEdit) => entryKey(e.op === 'upsert' ? e.entry : e)
  const changed = await changedSince(s, refineSeq, d.edits)
  if (changed.length > 0) return { outcome: 'rejected:conflict', reason: 'changed-since', changed }

  // One newest-first read covers every edit: the range (before refineSeq) and order are the same
  // for all of them, and it stops as soon as each edited key has its latest earlier row.
  const wanted = new Set(d.edits.map(keyOf))
  const latest = new Map<string, Event>()
  for await (const page of scanPages((q) => s.d.log.scan(q), {
    fromSeq: 1,
    toSeq: refineSeq - 1,
    type: 'harness/entry',
    order: 'desc',
  })) {
    for (const h of page) {
      if (h.data === null) continue
      const k = entryKey(h.data as { kind: HarnessEntry['kind']; id: string })
      if (wanted.has(k) && !latest.has(k)) latest.set(k, h)
    }
    if (latest.size === wanted.size) break
  }
  const prevRow = (k: string): Event | undefined => {
    const hit = latest.get(k)
    return hit && !isRegisterTombstone('harness/entry', hit.data) ? hit : undefined
  }

  const inverse: HarnessEdit[] = d.edits.map((e) => {
    const target = e.op === 'upsert' ? e.entry : e
    const prev = prevRow(entryKey(target))
    return prev
      ? { op: 'upsert', entry: prev.data as HarnessEntry }
      : { op: 'delete', kind: target.kind, id: target.id }
  })
  // Checked above: every key is as the refine left it, so the baseline is the state it left.
  const baseline = inverse.map((e) => {
    const k = keyOf(e)
    return {
      key: k,
      version: s.state.registers.harnessEntries.get(k)?.value.version ?? 0,
      seq: mutationToken(s.state, k),
    }
  })
  const meta = await restoredMeta(s, refineSeq, inverse, prevRow)

  // A rollback undoes what an already-validated refine did, so it is not re-run past the caller's
  // current caps: those could have tightened since, and a rollback that a tightened cap can reject
  // is a rollback that does not reliably work.
  const noLimits: ApplyLimits = {
    maxEdits: Number.MAX_SAFE_INTEGER,
    maxChars: Number.MAX_SAFE_INTEGER,
    safetyCap: Number.MAX_SAFE_INTEGER,
  }
  const r = await applyRefine(
    s,
    {
      proposalId: `rollback:${refineSeq}`,
      runId: `rollback:${refineSeq}`,
      trigger: 'rollback',
      edits: inverse,
      baseline,
      rationale: `rollback of refine at seq ${refineSeq}`,
      evidenceSeqs: [refineSeq],
      rollbackOf: refineSeq,
    },
    noLimits,
    { with: (o) => (o.outcome === 'applied' ? meta : []) },
  )
  if (r.outcome !== 'applied')
    throw new Error(`rollback of refine at seq ${refineSeq} was itself rejected: ${r.outcome}`)
  await s.diag('refine-rollback', { rollbackOf: refineSeq, refineSeq: r.seq })
  return { outcome: 'applied', seq: r.seq }
}

/**
 * The entries a refine wrote that have changed since: an upsert whose cell was set by a later row, a
 * delete whose entry exists again (or was written and removed again). The refine's own rows are the
 * first `harness/entry` rows after its control row, in edit order: one transaction wrote them all.
 */
async function changedSince(
  s: SessionImpl,
  refineSeq: Seq,
  edits: readonly HarnessEdit[],
): Promise<{ kind: HarnessEntry['kind']; id: string }[]> {
  const written: Event[] = []
  for await (const page of scanPages((q) => s.d.log.scan(q), {
    fromSeq: refineSeq + 1,
    toSeq: s.lastSeq,
    type: 'harness/entry',
  })) {
    written.push(...page.slice(0, edits.length - written.length))
    if (written.length >= edits.length) break
  }
  const changed: { kind: HarnessEntry['kind']; id: string }[] = []
  edits.forEach((e, i) => {
    const target = e.op === 'upsert' ? e.entry : e
    const k = entryKey(target)
    const own = written[i]
    const ownKey = own?.data ? entryKey(own.data as { kind: HarnessEntry['kind']; id: string }) : undefined
    const cell = s.state.registers.harnessEntries.get(k)
    const gone = s.state.refinementTombstones.get(k)
    const intact =
      own !== undefined &&
      ownKey === k &&
      (e.op === 'upsert'
        ? cell?.seq === own.seq
        : // The removal row follows the tombstone in the same transaction; a later removal is another one.
          cell === undefined && (gone === undefined || gone.seq === own.seq + 1))
    if (!intact) changed.push({ kind: target.kind, id: target.id })
  })
  return changed
}

/**
 * The metadata rows a rollback writes after its entry rows: for each entry it restores, the validity
 * metadata that was bound to the restored version when the refine replaced it (the newest metadata
 * row for that key between the restored row and the refine). An entry that had none is restored
 * without, as it was.
 */
async function restoredMeta(
  s: SessionImpl,
  refineSeq: Seq,
  inverse: readonly HarnessEdit[],
  prevRow: (k: string) => Event | undefined,
): Promise<EventInput[]> {
  const restored = inverse.flatMap((e) => {
    if (e.op !== 'upsert') return []
    const prev = prevRow(entryKey(e.entry))
    return prev ? [{ key: entryKey(e.entry), prev }] : []
  })
  if (restored.length === 0) return []
  const from = Math.min(...restored.map((r) => r.prev.seq))
  const found = new Map<string, Record<string, unknown>>()
  for await (const page of scanPages((q) => s.d.log.scan(q), {
    fromSeq: from,
    toSeq: refineSeq - 1,
    type: REFINEMENT_ENTRY_META_EVENT,
    order: 'desc',
  })) {
    for (const row of page) {
      const d = row.data as { kind?: unknown; id?: unknown } | null
      const key = `${String(d?.kind ?? '')}${SEP}${String(d?.id ?? '')}`
      const hit = restored.find((r) => r.key === key)
      if (!hit || found.has(key) || row.seq < hit.prev.seq) continue
      // Read as the reducer folded it then: bound to the restored row, every field checked.
      const meta = foldEntryMeta({ seq: hit.prev.seq, value: hit.prev.data }, row)
      if (!meta) continue
      const { entrySeq: _entry, seq: _seq, ...fields } = meta
      found.set(key, fields)
    }
    if (found.size === restored.length) break
  }
  return [...found.values()].map((fields) =>
    s.ev(REFINEMENT_ENTRY_META_EVENT, { version: 1, ...fields }, { ignorable: true }),
  )
}
