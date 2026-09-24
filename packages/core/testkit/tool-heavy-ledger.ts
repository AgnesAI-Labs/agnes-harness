// A long, tool-call-heavy ledger for fold scaling tests, generated lazily so a caller can fold
// tens of thousands of calls without holding the whole ledger in memory. Each call replays the
// tool step of a real recorded session (the `batch-k1` golden recording): the same row types in the
// same order, with ids, seqs and turn/step numbers rewritten. Op-mark rows keep the recorded shape
// with only the call ids updated; nothing here folds them further.
import type { Event, Seq } from '../src/types.js'
import { expectedFromGolden, readGolden } from './record-transitions.js'

type Row = Omit<Event, 'seq' | 'id' | 'ts'> & { seq: Seq }

/**
 * A golden recording as a ledger in the current format: every commit's rows in order, with an
 * op-mark where a transition had no row of its own. Rows carry no id or timestamp.
 */
export function goldenLedger(name: string): Event[] {
  return recordedRows(name) as Event[]
}

function recordedRows(name: string): Row[] {
  return expectedFromGolden(readGolden(name)).flatMap((commit) => commit.events as Row[])
}

type Templates = {
  head: Row[]
  turnStart: Row
  step: Row[]
  turnEnd: Row
  actor: Event['actor']
}

let cached: Templates | undefined
function templates(): Templates {
  if (cached) return cached
  const rows = recordedRows('batch-k1')
  const turnStartAt = rows.findIndex((r) => r.type === 'turn/start')
  const firstStep = rows.findIndex((r) => r.type === 'step/start')
  const stepEnd = rows.findIndex((r, i) => i > firstStep && r.type === 'step/end')
  const turnEndAt = rows.findIndex((r) => r.type === 'turn/end')
  const turnStart = rows[turnStartAt] as Row
  cached = {
    head: rows.slice(0, turnStartAt),
    turnStart,
    // The rows between turn/start and the first step (op-marks, budget, context breakdown) recur
    // before every step of a long turn, so they belong to the replicated block.
    step: rows.slice(turnStartAt + 1, stepEnd + 1),
    turnEnd: rows[turnEndAt] as Row,
    actor: turnStart.actor as Event['actor'],
  }
  return cached
}

const SEQ_FIELDS = ['requestSeq', 'argsSeq', 'lastAssistantSeq'] as const

/** Copies one template row to `seq`, moving every seq it references by the same distance. */
function place(row: Row, seq: Seq, shift: number, patch: Record<string, unknown> = {}): Event {
  const data =
    row.data && typeof row.data === 'object' ? { ...(row.data as Record<string, unknown>) } : row.data
  if (data && typeof data === 'object')
    for (const field of SEQ_FIELDS) {
      const value = (data as Record<string, unknown>)[field]
      if (typeof value === 'number') (data as Record<string, unknown>)[field] = value + shift
    }
  return {
    ...row,
    ...(row.sourceEventSeqs ? { sourceEventSeqs: row.sourceEventSeqs.map((s) => s + shift) } : {}),
    data: data && typeof data === 'object' ? { ...data, ...patch } : data,
    seq,
    id: `tool-heavy-${seq}`,
    ts: '2025-09-07T00:00:00.000Z',
  } as Event
}

/**
 * Yields a session of `calls` tool calls: one per step, a new turn every `perTurn` calls, and an
 * approval asked and decided every `approvalEvery` calls. Ids are unique per call, so the fold keeps
 * one `toolCalls` entry per call and one `decisions` entry per approval.
 */
export function* toolHeavyLedger(opts: {
  calls: number
  perTurn?: number
  approvalEvery?: number
}): Generator<Event> {
  const { calls, perTurn = 50, approvalEvery = 10 } = opts
  const t = templates()
  let seq = 0
  yield {
    v: 1,
    type: 'session/start',
    origin: 'system',
    trust: 'trusted',
    actor: t.actor,
    data: { key: 'tool-heavy', resolvedProfileHash: null, preset: 'standard', agnesVersion: '0.0.1' },
    seq: ++seq,
    id: `tool-heavy-${seq}`,
    ts: '2025-09-07T00:00:00.000Z',
  } as Event
  let turn = 0
  let step = 0
  let lastAssistant = 0
  for (let call = 0; call < calls; call++) {
    if (call % perTurn === 0) {
      if (turn > 0) {
        yield place(t.turnEnd, ++seq, 0, { lastAssistantSeq: lastAssistant })
      }
      turn++
      step = 0
      for (const row of t.head) yield place(row, ++seq, seq - row.seq)
      yield place(t.turnStart, ++seq, seq - t.turnStart.seq, { turn })
    }
    step++
    const origin = (t.step[0] as Row).seq
    const base = seq + 1
    const toolUseId = `t-call-${call}`
    for (const row of t.step) {
      const at = base + (row.seq - origin)
      const shift = at - row.seq
      const d = (row.data ?? {}) as Record<string, unknown>
      const patch: Record<string, unknown> = {}
      if (typeof d.effectId === 'string') patch.effectId = `${d.effectId}-${call}`
      if (typeof d.toolUseId === 'string') patch.toolUseId = toolUseId
      if (d.tool && typeof d.tool === 'object') patch.tool = { ...(d.tool as object), toolUseId }
      if (row.type === 'step/start' || row.type === 'step/end') Object.assign(patch, { turn, step })
      if (Array.isArray(d.calls)) patch.calls = (d.calls as object[]).map((call) => ({ ...call, toolUseId }))
      if (row.type === 'assistant/message') lastAssistant = at
      yield place(row, at, shift, patch)
    }
    seq = base + ((t.step.at(-1) as Row).seq - origin)
    if (call % approvalEvery === approvalEvery - 1) {
      const requestId = `req-${call}`
      const common = { lane: 'main', v: 1, origin: 'system', trust: 'trusted', actor: t.actor } as const
      yield {
        ...common,
        type: 'approval/asked',
        data: { requestId, toolUseId, tool: 'read', bindingHash: 'h', scopes: [] },
        seq: ++seq,
        id: `tool-heavy-${seq}`,
        ts: '2025-09-07T00:00:00.000Z',
      } as Event
      yield {
        ...common,
        type: 'approval/decided',
        data: { requestId, verdict: 'allowed-once', via: 'sync', by: t.actor },
        seq: ++seq,
        id: `tool-heavy-${seq}`,
        ts: '2025-09-07T00:00:00.000Z',
      } as Event
    }
  }
}
