import type { Event, EventInput, Seq } from '@agnes/core-common/types'
import type { RefineProposal } from '@agnes/core-effects/effects/seams'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { AppendOptions } from '@agnes/core-ledger/log/session-log'
import { isRegisterTombstone } from '@agnes/core-ledger/log/storage'
import type { HarnessEdit, HarnessEntry, HarnessRefine } from '@agnes/core-ledger/reduce/shapes'
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
 * Applies one refinement proposal as a single ledger transaction, and at most once per `runId`.
 *
 * The caller must hold the session writer lock: this reads the register table and then appends,
 * and nothing here prevents another writer from moving the table in between. (The Core facade is
 * the only intended caller.)
 *
 * Checks, in order, each recorded as one `harness/refine` row when it fails:
 * 1. a `runId` already on the log returns that row's outcome and seq without writing;
 * 2. the whole proposal is rejected for too many edits, two edits on one key, a baseline entry no
 *    edit touches that has moved (`rejected:conflict`, reason `stale-baseline`), an unknown evidence seq
 *    (`rejected:evidence`), an oversized entry (`rejected:limit`) or a contract prefix
 *    (`rejected:prefix`);
 * 3. an edit whose own baseline version has moved rejects the whole proposal as
 *    `rejected:conflict` (reason `stale-edit`; the moved edits are listed in `rejectedEdits`, a
 *    diagnostic only: nothing is written but the control row);
 * 4. if the edits would push any kind past the safety cap the whole proposal is `rejected:limit`
 *    with reason `capacity`; nothing is deleted to make room.
 *
 * Apply is atomic: on success the transaction is the control row followed by one `harness/entry`
 * row per edit (an `upsert` bumping `version`, a `delete` writing the tombstone form).
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
      baseline: p.baseline,
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
  const baselineVersion = new Map(p.baseline.map((b) => [b.key, b.version]))
  for (const b of p.baseline)
    if (!touched.has(b.key) && (entries.get(b.key)?.value.version ?? 0) !== b.version)
      return reject('rejected:conflict', 'stale-baseline')

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
    const want = baselineVersion.get(editKey(e))
    if (want !== undefined && (entries.get(editKey(e))?.value.version ?? 0) !== want)
      rejectedEdits.push({ index, reason: 'stale-edit' })
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
      const cur = entries.get(entryKey(e.entry))?.value
      events.push(
        s.ev(
          'harness/entry',
          { ...e.entry, version: (cur?.version ?? 0) + 1 },
          { register: 'harness/entry' },
        ),
      )
    } else {
      events.push(
        s.ev('harness/entry', { kind: e.kind, id: e.id, tombstone: true }, { register: 'harness/entry' }),
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

/**
 * Undoes an earlier *applied* refine by expressing the opposite edits as a brand-new
 * `harness/refine{trigger:'rollback'}` — never by deleting or rewriting the row being undone, which
 * would erase the very history a rollback is supposed to be accountable against.
 *
 * For each original edit, the key's value immediately before `refineSeq` is read back off the
 * `harness/entry` event stream (a tombstone there counts as "did not exist"). If a value is found
 * the inverse edit restores it; otherwise the inverse edit deletes the key, which is the correct
 * undo of an edit that created it (and a harmless no-op undo of a delete that had nothing to delete
 * in the first place). `applyRefine` recomputes `version` from the *current* cell either way, so the
 * stale `version` field carried on a restored entry is never read.
 */
export async function rollbackRefine(s: SessionImpl, refineSeq: Seq): Promise<{ seq: Seq }> {
  const row = (await s.d.log.scan({ fromSeq: refineSeq, toSeq: refineSeq }))[0]
  if (row?.type !== 'harness/refine') throw new Error(`no harness/refine event at seq ${refineSeq}`)
  const d = row.data as HarnessRefine
  if (d.outcome !== 'applied')
    throw new Error(`cannot roll back refine at seq ${refineSeq}: outcome was ${d.outcome}, not applied`)

  // A repeated rollback of the same refine is the run already recorded: same seq, nothing written
  // (not even the diagnostic below).
  const prior = await findRun(s, `rollback:${refineSeq}`)
  if (prior) {
    if (prior.outcome !== 'applied')
      throw new Error(`rollback of refine at seq ${refineSeq} was itself rejected: ${prior.outcome}`)
    return { seq: prior.seq }
  }

  // One newest-first read covers every edit: the range (before refineSeq) and order are the same
  // for all of them, and it stops as soon as each edited key has its latest earlier row.
  // `refineSeq === 1` cannot happen (a harness/refine row is never the first event on a session),
  // but the guard keeps `toSeq: 0` — an inverted range — from ever reaching scan.
  const wanted = new Set(d.edits.map((e) => entryKey(e.op === 'upsert' ? e.entry : e)))
  const latest = new Map<string, Event>()
  const history =
    refineSeq > 1
      ? scanPages((q) => s.d.log.scan(q), {
          fromSeq: 1,
          toSeq: refineSeq - 1,
          type: 'harness/entry',
          order: 'desc',
        })
      : []
  for await (const page of history) {
    for (const h of page) {
      if (h.data === null) continue
      const k = entryKey(h.data as { kind: HarnessEntry['kind']; id: string })
      if (wanted.has(k) && !latest.has(k)) latest.set(k, h)
    }
    if (latest.size === wanted.size) break
  }
  const prevValue = (k: string): HarnessEntry | undefined => {
    const hit = latest.get(k)
    return hit && !isRegisterTombstone('harness/entry', hit.data) ? (hit.data as HarnessEntry) : undefined
  }

  const inverse: HarnessEdit[] = d.edits.map((e) => {
    const target = e.op === 'upsert' ? e.entry : e
    const prev = prevValue(entryKey(target))
    return prev ? { op: 'upsert', entry: prev } : { op: 'delete', kind: target.kind, id: target.id }
  })
  const baseline = inverse.map((e) => {
    const k = e.op === 'upsert' ? entryKey(e.entry) : entryKey(e)
    return { key: k, version: s.state.registers.harnessEntries.get(k)?.value.version ?? 0 }
  })

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
  )
  if (r.outcome !== 'applied')
    throw new Error(`rollback of refine at seq ${refineSeq} was itself rejected: ${r.outcome}`)
  await s.diag('refine-rollback', { rollbackOf: refineSeq, refineSeq: r.seq })
  return { seq: r.seq }
}
