import type { InferenceEvent } from '@agnes/protocol'
import { sha256Hex } from './hash-sha256.js'
import { RULES } from './rules/index.js'
import {
  CAPTURE_MAX,
  type DecodeContext,
  type DecodeInput,
  type DecodeState,
  type Rule,
  TAIL_MAX,
} from './types.js'

const FENCE = '```'

export function createState(): DecodeState {
  return { mode: 'IDLE', pending: '', source: 'text' }
}

function deltaEvent(source: 'text' | 'thinking', text: string): InferenceEvent[] {
  return text ? [{ type: source === 'text' ? 'text_delta' : 'thinking_delta', delta: text }] : []
}

/**
 * Adjacent deltas of one kind, joined. Where a chunk boundary fell is not part of what the model
 * said, so a comparison against a recorded event list has to be made after this runs - otherwise two
 * chunkings of one stream would disagree about a stream they decoded identically.
 */
export function mergeDeltas(events: InferenceEvent[]): InferenceEvent[] {
  const out: InferenceEvent[] = []
  for (const e of events) {
    const last = out.at(-1)
    if (last && (e.type === 'text_delta' || e.type === 'thinking_delta') && last.type === e.type) {
      out[out.length - 1] = { type: e.type, delta: last.delta + e.delta }
      continue
    }
    out.push(e)
  }
  return out
}

/** How many characters at the end of `pending` could still turn into an opening tag or a fence. */
function tailHold(pending: string): number {
  let hold = 0
  const max = Math.min(TAIL_MAX, pending.length)
  for (let k = 1; k <= max; k++) {
    const tail = pending.slice(-k)
    // A complete fence would already have been found by the caller, so only a partial one counts.
    if (RULES.some((r) => r.couldOpen(tail)) || (FENCE.startsWith(tail) && FENCE !== tail)) hold = k
  }
  return hold
}

/** The earliest opening tag in `pending`, with rule order breaking a tie. */
function findOpen(pending: string): { rule: Rule; index: number; opened: string } | undefined {
  let best: { rule: Rule; index: number; opened: string } | undefined
  for (const rule of RULES) {
    const m = rule.open.exec(pending)
    if (m && (!best || m.index < best.index)) best = { rule, index: m.index, opened: m[0] }
  }
  return best
}

/**
 * Whether text nothing parsed still looks like an attempt at a call. Only such text is worth a
 * deviation row: counting every unparsed fragment would drown the signal the row exists to carry.
 */
export function looksLikeCall(text: string, toolNames: readonly string[]): boolean {
  return /"name"\s*:/.test(text) && toolNames.some((n) => text.includes(n))
}

/**
 * A closed capture, as events. Three outcomes: thinking leaves as thinking, a call to a tool the
 * model was actually offered leaves as a finished call, and anything else goes back out as the text
 * it was - because a decoder that promoted a name nobody disclosed would be inventing a call.
 */
function promote(
  state: DecodeState,
  ctx: DecodeContext,
  rule: Rule,
  opened: string,
  body: string,
  closed: string,
): InferenceEvent[] {
  const r = rule.extract(opened, body)
  if (r && 'thinking' in r) return deltaEvent('thinking', r.thinking)
  if (r && ctx.toolNames.includes(r.name)) {
    const ordinal = ctx.nextOrdinal()
    // The rule says which syntax was read; a stream that was reasoning says so instead, because
    // there the syntax is incidental and the field it came out of is the fact worth recording.
    const via = state.source === 'thinking' ? 'reasoning_field' : (r.via ?? rule.id)
    return [
      {
        type: 'toolcall_end',
        call: { toolUseId: `dc-${ordinal}`, name: r.name, args: r.args as never, ordinal },
        via,
      },
    ]
  }
  const raw = opened + body + closed
  const events = deltaEvent(state.source, raw)
  if (looksLikeCall(raw, ctx.toolNames))
    events.push({ type: 'deviation', rule: 'unparsed', sampleHash: sha256Hex(raw) })
  return events
}

/**
 * One chunk of a model's output, as events. Pure: the state it returns is the only thing carried
 * from one chunk to the next, so the same stream decodes identically however it was split.
 */
export function step(
  state: DecodeState,
  input: DecodeInput,
  ctx: DecodeContext,
): { state: DecodeState; events: InferenceEvent[] } {
  const events: InferenceEvent[] = []
  let s: DecodeState = { ...state, source: input.kind, pending: state.pending + input.delta }
  for (;;) {
    if (s.mode === 'CAPTURE' && s.capture) {
      const captured = s.capture.opened + s.pending
      const closeAt = s.capture.rule.closeAt?.(captured)
      const m = closeAt === undefined ? s.capture.rule.close.exec(s.pending) : undefined
      if ((closeAt === undefined && !m) || closeAt === -1) {
        if (s.pending.length > CAPTURE_MAX) {
          events.push(...deltaEvent(s.source, s.capture.opened + s.pending))
          s = { mode: 'IDLE', pending: '', source: s.source }
          continue
        }
        return { state: s, events }
      }
      const bodyEnd = closeAt === undefined ? (m?.index ?? 0) : closeAt - s.capture.opened.length
      const closed = closeAt === undefined ? (m?.[0] ?? '') : s.pending.slice(bodyEnd, bodyEnd + 1)
      events.push(...promote(s, ctx, s.capture.rule, s.capture.opened, s.pending.slice(0, bodyEnd), closed))
      s = {
        mode: 'IDLE',
        pending: s.pending.slice(bodyEnd + closed.length),
        source: s.source,
      }
      continue
    }
    if (s.mode === 'FENCE') {
      const i = s.pending.indexOf(FENCE)
      if (i < 0) {
        const hold = tailHold(s.pending)
        events.push(...deltaEvent(s.source, s.pending.slice(0, s.pending.length - hold)))
        return { state: { ...s, pending: s.pending.slice(s.pending.length - hold) }, events }
      }
      events.push(...deltaEvent(s.source, s.pending.slice(0, i + FENCE.length)))
      s = { ...s, mode: 'IDLE', pending: s.pending.slice(i + FENCE.length) }
      continue
    }
    const fenceAt = s.pending.indexOf(FENCE)
    const open = findOpen(s.pending)
    // A fenced block is quoted material, not output: whatever it holds is passed through untouched,
    // which is what stops a code sample that shows a call from being read as one.
    if (fenceAt >= 0 && (!open || fenceAt < open.index)) {
      events.push(...deltaEvent(s.source, s.pending.slice(0, fenceAt + FENCE.length)))
      s = { ...s, mode: 'FENCE', pending: s.pending.slice(fenceAt + FENCE.length) }
      continue
    }
    if (open) {
      events.push(...deltaEvent(s.source, s.pending.slice(0, open.index)))
      s = {
        ...s,
        mode: 'CAPTURE',
        pending: s.pending.slice(open.index + open.opened.length),
        capture: { rule: open.rule, opened: open.opened },
      }
      continue
    }
    const hold = tailHold(s.pending)
    events.push(...deltaEvent(s.source, s.pending.slice(0, s.pending.length - hold)))
    return { state: { ...s, pending: s.pending.slice(s.pending.length - hold) }, events }
  }
}

/**
 * End of stream. Whatever was being held back - a tail that might have been an opening tag, a
 * capture whose closing tag never came - leaves as the text it always was, so nothing the model
 * wrote is dropped on the way out.
 */
export function finish(
  state: DecodeState,
  ctx: DecodeContext,
): { state: DecodeState; events: InferenceEvent[] } {
  const trailing =
    state.mode === 'CAPTURE' && state.capture ? state.capture.opened + state.pending : state.pending
  const events = deltaEvent(state.source, trailing)
  if (looksLikeCall(trailing, ctx.toolNames))
    events.push({ type: 'deviation', rule: 'unparsed', sampleHash: sha256Hex(trailing) })
  return { state: createState(), events }
}

export type { DecodeContext, DecodeInput, DecodeState } from './types.js'
