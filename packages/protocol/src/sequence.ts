import type { HarnessMeta } from '../gen/ts/agnes-v1.js'
import { META_KEY } from './constants.js'

/** One recorded JSON-RPC message and the direction it travelled. */
export type Frame = { dir: 'send' | 'recv'; msg: Record<string, unknown> }
export type SequenceInvariant = 'seq-monotonic' | 'quiescence-last' | 'prompt-response-after-quiescence'
type Violation = { invariant: SequenceInvariant; at: number; detail: string }

// Only `session/update` notifications carry the harness meta, and they carry it on `params._meta`.
// There is no second place to look: an earlier draft also probed a top-level `msg._meta`, which the
// `method === 'session/update'` filter below makes unreachable, so the branch was dead.
function metaOf(f: Frame): HarnessMeta | undefined {
  const params = f.msg.params as { _meta?: Record<string, unknown> } | undefined
  const raw = params?._meta?.[META_KEY]
  return raw && typeof raw === 'object' ? (raw as HarnessMeta) : undefined
}

/**
 * Checks a recorded frame sequence against the named invariants. Pure, so the same function serves
 * checked-in recordings here and live connections in the integration tests of the packages that
 * speak this protocol.
 */
export function checkSequence(
  frames: Frame[],
  invariants: SequenceInvariant[],
): { ok: boolean; violations: Violation[] } {
  const violations: Violation[] = []
  const updates = frames
    .map((f, i) => ({ f, i, meta: metaOf(f) }))
    .filter((x) => x.f.dir === 'recv' && x.f.msg.method === 'session/update' && x.meta)

  if (invariants.includes('seq-monotonic')) {
    let last = Number.NEGATIVE_INFINITY
    for (const u of updates) {
      const seq = u.meta?.eventSequence
      // A row with no eventSequence is a violation, not a free pass. Defaulting it to -1 would make
      // the first such row compare smaller than everything after it and quietly pass, which is a
      // missed report rather than a conservative one.
      if (typeof seq !== 'number') {
        violations.push({ invariant: 'seq-monotonic', at: u.i, detail: 'no eventSequence' })
        continue
      }
      if (seq <= last)
        violations.push({ invariant: 'seq-monotonic', at: u.i, detail: `eventSequence ${seq} <= ${last}` })
      last = Math.max(last, seq)
    }
  }

  if (invariants.includes('quiescence-last')) {
    const q = updates.filter((u) => u.meta?.phase === 'terminalQuiescence')
    if (q.length !== 1)
      violations.push({
        invariant: 'quiescence-last',
        at: q[0]?.i ?? frames.length,
        detail: `terminalQuiescence count ${q.length}, expected 1`,
      })
    else if (updates[updates.length - 1]?.i !== q[0]?.i)
      violations.push({
        invariant: 'quiescence-last',
        at: q[0]?.i ?? frames.length,
        detail: 'updates after terminalQuiescence',
      })
  }

  if (invariants.includes('prompt-response-after-quiescence')) {
    const promptIdx = frames.findIndex((f) => f.dir === 'send' && f.msg.method === 'session/prompt')
    // Without a prompt frame this invariant has nothing to be about, and matching "the first result
    // frame with a matching id" against `undefined` would match the first id-less result instead -
    // a false positive dressed up as a finding. Refuse the input rather than guess at it.
    if (promptIdx < 0)
      throw new Error('prompt-response-after-quiescence needs a session/prompt frame in the sequence')
    const id = frames[promptIdx]?.msg.id
    const respIdx = frames.findIndex(
      (f) => f.dir === 'recv' && f.msg.id === id && ('result' in f.msg || 'error' in f.msg),
    )
    const qIdx = updates.find((u) => u.meta?.phase === 'terminalQuiescence')?.i ?? -1
    if (respIdx >= 0 && (qIdx < 0 || respIdx < qIdx))
      violations.push({
        invariant: 'prompt-response-after-quiescence',
        at: respIdx,
        detail: 'prompt response before terminalQuiescence',
      })
  }

  return { ok: violations.length === 0, violations }
}
