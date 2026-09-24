import type { RefineProposal } from '../effects/seams.js'
import { scanPages } from '../log/scan-pages.js'
import { isRegisterTombstone } from '../log/storage.js'
import type { HarnessEdit, HarnessEntry, HarnessRefine } from '../reduce/shapes.js'
import type { SessionImpl } from '../step/session.js'
import type { Event, EventInput, Seq } from '../types.js'

/**
 * Per-kind entry caps, the shared per-entry char cap, and the contract-prefix denylist a Refine
 * proposal must respect. Supplied by the preset (`harness.*`); `contractPrefixMarkers` defaults to
 * `[]` when a deployment reserves no prefix for its own contract-carrying content.
 */
export type RefineLimits = {
  maxEntries: Record<HarnessEntry['kind'], number>
  maxCharsPerEntry: number
  contractPrefixMarkers: string[]
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
const entryKey = (e: { kind: HarnessEntry['kind']; id: string }): string => `${e.kind}${SEP}${e.id}`

/**
 * Applies one Refine proposal in a single ledger transaction: `baseline` is checked against the
 * live register table, `evidenceSeqs` against the log, and the edits against `limits`, in that
 * order. Any failure rejects the *whole* proposal — no partial apply — and still writes one
 * `harness/refine` row recording which outcome fired, so a rejection is auditable rather than
 * silent. On success the transaction is one `harness/refine{outcome:'applied'}` row followed by one
 * `harness/entry` row per edit (an `upsert` bumping `version`, a `delete` writing the tombstone
 * form), which is what "fold entries with a version bump" means for this register.
 */
export async function applyRefine(
  s: SessionImpl,
  p: RefineProposal,
  limits: RefineLimits,
): Promise<{ outcome: HarnessRefine['outcome']; seq: Seq }> {
  const entries = s.state.registers.harnessEntries

  const buildRefineEvent = (outcome: HarnessRefine['outcome']): EventInput =>
    s.ev('harness/refine', {
      proposalId: p.proposalId,
      trigger: p.trigger,
      outcome,
      edits: p.edits,
      baseline: p.baseline,
      rationale: p.rationale,
      evidenceSeqs: p.evidenceSeqs,
      ...(p.rollbackOf !== undefined ? { rollbackOf: p.rollbackOf } : {}),
    })
  // A rejection is recorded, not swallowed: the whole point of "whole-proposal rejection" is that
  // the attempt (and why it failed) stays on the ledger even though no harness/entry row is written.
  const reject = async (
    outcome: Exclude<HarnessRefine['outcome'], 'applied'>,
  ): Promise<{ outcome: HarnessRefine['outcome']; seq: Seq }> => {
    const r = await s.d.log.append([buildRefineEvent(outcome)], { refineCaller: true })
    return { outcome, seq: r.firstSeq }
  }

  // ① baseline: every key the proposal was computed against must still read the version it read
  // then, or the proposal was built on a table that has since moved.
  for (const b of p.baseline)
    if ((entries.get(b.key)?.value.version ?? 0) !== b.version) return reject('rejected:conflict')

  // ② evidence: every cited seq must be a real row already on this log — an exact lookup, not a
  // type check, because the proposal is citing *why* it exists, not what kind of row that is.
  for (const seq of p.evidenceSeqs) {
    if (seq < 1 || seq > s.lastSeq) return reject('rejected:evidence')
    const hit = await s.d.log.scan({ fromSeq: seq, toSeq: seq })
    if (hit.length === 0) return reject('rejected:evidence')
  }

  // ③ per-edit content checks, plus the running per-kind count an edit would leave behind.
  const counts = new Map<HarnessEntry['kind'], number>()
  for (const cell of entries.values()) counts.set(cell.value.kind, (counts.get(cell.value.kind) ?? 0) + 1)
  for (const e of p.edits) {
    if (e.op === 'upsert') {
      if (e.entry.content.length > limits.maxCharsPerEntry) return reject('rejected:limit')
      if (limits.contractPrefixMarkers.some((m) => e.entry.content.includes(m)))
        return reject('rejected:prefix')
      if (!entries.has(entryKey(e.entry))) counts.set(e.entry.kind, (counts.get(e.entry.kind) ?? 0) + 1)
    } else if (entries.has(entryKey(e))) {
      counts.set(e.kind, (counts.get(e.kind) ?? 0) - 1)
    }
  }
  // ④ aggregate cap: the count each kind would hold *after* every edit in the proposal applies.
  for (const [kind, n] of counts) if (n > limits.maxEntries[kind]) return reject('rejected:limit')

  // ⑤ passed every check: one transaction, the control row first so a reader scanning forward sees
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
  const r = await s.d.log.append(events, { refineCaller: true })
  return { outcome: 'applied', seq: r.firstSeq }
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
  const noLimits: RefineLimits = {
    maxEntries: {
      prompt: Number.MAX_SAFE_INTEGER,
      memory: Number.MAX_SAFE_INTEGER,
      skill: Number.MAX_SAFE_INTEGER,
      subagent: Number.MAX_SAFE_INTEGER,
    },
    maxCharsPerEntry: Number.MAX_SAFE_INTEGER,
    contractPrefixMarkers: [],
  }
  const r = await applyRefine(
    s,
    {
      proposalId: `rollback:${refineSeq}`,
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
