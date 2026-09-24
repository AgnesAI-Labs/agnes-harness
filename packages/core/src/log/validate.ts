import { isEventType, validateEvent } from '@agnes/protocol'
import { type Clock, CoreError, type EventInput, type IdMinter, type PreparedEvent } from '../types.js'

/** The only three event types the model ever sees, and therefore the only ones a surfaceOp may edit. */
export const MODEL_VISIBLE = ['user/message', 'assistant/message', 'tool/result'] as const

const DECIDED_VIA = new Set(['sync', 'callback', 'timeout', 'guardian'])

/**
 * Turns a batch of caller input into ledger rows and rejects the whole batch if any row is invalid,
 * so a failed append leaves nothing behind. Defaults are filled first (`lane`, `v`, `ts`, `id`); the
 * checks that follow are the ones protocol's schemas cannot express.
 */
export function prepareEvents(
  inputs: EventInput[],
  ctx: { ids: IdMinter; clock: Clock; refineCaller: boolean },
): PreparedEvent[] {
  let replaces = 0
  const out: PreparedEvent[] = []
  for (const input of inputs) {
    const e = {
      lane: 'main',
      v: 1,
      ...input,
      ts: input.ts ?? new Date(ctx.clock()).toISOString(),
      id: input.id ?? ctx.ids.ulid(),
    } as PreparedEvent
    if (!isEventType(e.type) && e.ignorable !== true) throw new CoreError('E_UNKNOWN_EVENT', e.type)
    // The program counter is a register cell committed beside the rows; no row may write it.
    if (e.register === 'op.state')
      throw new CoreError('E_ENVELOPE', 'the op.state register is not written by rows')
    // The envelope schema requires seq >= 1, but storage does not assign one until the commit
    // transaction. Validate a probe carrying the smallest legal seq; the row handed back has no
    // seq at all, so the probe value cannot be mistaken for the sequence it is written at.
    const r = validateEvent({ ...e, seq: 1 })
    // An ignorable event of an unknown type fails the envelope only on `/type`; anything else it got
    // wrong is still a rejection, so the pass is narrowed to batches where `/type` is the sole error.
    if (!r.ok && !(e.ignorable === true && r.errors.every((x) => x.path === '/type')))
      throw new CoreError('E_ENVELOPE', r.errors[0]?.message ?? 'invalid', { errors: r.errors })
    const d = e.data as Record<string, unknown> | null
    if (e.type === 'approval/decided' && !DECIDED_VIA.has(String(d?.via)))
      throw new CoreError('E_ENVELOPE', 'approval/decided.via out of set')
    // Self-improvement rows may only be written by the Refine operation, which says so by passing
    // refineCaller; nothing else in the process is allowed to rewrite the harness from the ledger.
    if (e.type === 'harness/refine' && !ctx.refineCaller)
      throw new CoreError('E_ENVELOPE', 'harness/refine only from Refine Operation')
    if (e.surfaceOp !== undefined) {
      if (!(MODEL_VISIBLE as readonly string[]).includes(e.type))
        throw new CoreError('E_SURFACE_RANGE', 'surfaceOp only on model-visible events', { type: e.type })
      if (typeof e.surfaceOp === 'object') {
        replaces++
        if (replaces > 1) throw new CoreError('E_SURFACE_RANGE', 'at most one replace per transaction')
        if (!e.sourceEventSeqs?.length)
          throw new CoreError('E_SURFACE_RANGE', 'replace needs sourceEventSeqs')
      }
    }
    out.push(e)
  }
  return out
}
