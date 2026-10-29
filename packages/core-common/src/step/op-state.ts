import type { Actor, OpState } from '@agnes/protocol'
import type { EventInput, Seq } from '../types.js'

/** The non-null branch: a lane with no open turn writes `null`, which is the register's tombstone. */
export type OpStateObj = Exclude<OpState, null>
export type OpStatePhase = OpStateObj['phase']
export type CheckpointPhase = Extract<OpStatePhase, { kind: 'checkpoint' }>
export type ToolsPhase = Extract<OpStatePhase, { kind: 'tools' }>
export type ToolCallState = ToolsPhase['batch']['calls'][number]
export type OpStateMeta = OpStateObj['meta']

/** The program counter a freshly accepted turn starts from: step 0, nothing said yet. */
export function newOpState(meta: OpStateMeta, triggerSeq: Seq): OpStateObj {
  return {
    meta,
    control: { status: 'running' },
    step: 0,
    latestAssistantSeq: null,
    taint: false,
    phase: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq },
  }
}

export function withPhase(
  s: OpStateObj,
  phase: OpStatePhase,
  patch: Partial<Pick<OpStateObj, 'step' | 'latestAssistantSeq' | 'taint' | 'control'>> = {},
): OpStateObj {
  return { ...s, ...patch, phase }
}

/** One call whose status or dispatch bookkeeping a transition changed. */
export type OpMarkCall = {
  toolUseId: string
  status: ToolCallState['status']
  dispatchPhase?: ToolCallState['dispatchPhase']
  dispatchAttempt?: ToolCallState['dispatchAttempt']
}

/** What an `x/core/op-mark` row says about the transition it stands in for. */
export type OpMarkData = {
  phase: OpStatePhase['kind'] | null
  control?: 'cancel_requested'
  by?: Actor
  requestedAt?: string
  calls?: OpMarkCall[]
}

/**
 * The change from `prev` to `next` that a transition committing no row of its own leaves on the
 * ledger: the phase it enters, who asked to stop when this is the transition that records the stop
 * request, and every call whose status or dispatch bookkeeping moved while the batch stayed in tools.
 */
export function opMarkData(prev: OpStateObj | null, next: OpStateObj | null): OpMarkData {
  const data: OpMarkData = { phase: next?.phase.kind ?? null }
  if (next?.control.status === 'cancel_requested' && prev?.control.status !== 'cancel_requested') {
    data.control = 'cancel_requested'
    data.by = next.control.by
    data.requestedAt = next.control.requestedAt
  }
  if (prev?.phase.kind === 'tools' && next?.phase.kind === 'tools') {
    const before = new Map(prev.phase.batch.calls.map((call) => [call.toolUseId, call]))
    const calls: OpMarkCall[] = []
    for (const call of next.phase.batch.calls) {
      const was = before.get(call.toolUseId)
      if (
        was?.status === call.status &&
        was.dispatchPhase === call.dispatchPhase &&
        was.dispatchAttempt === call.dispatchAttempt
      )
        continue
      calls.push({
        toolUseId: call.toolUseId,
        status: call.status,
        ...(call.dispatchPhase === undefined ? {} : { dispatchPhase: call.dispatchPhase }),
        ...(call.dispatchAttempt === undefined ? {} : { dispatchAttempt: call.dispatchAttempt }),
      })
    }
    if (calls.length > 0) data.calls = calls
  }
  return data
}

/**
 * The row a transition writes when it has none of its own. Every transition commits at least one
 * row, so the ledger head and the program counter's cell seq move on together.
 */
export function opMark(
  prev: OpStateObj | null,
  next: OpStateObj | null,
  lane: string,
  actor: Actor,
): EventInput {
  return {
    type: 'x/core/op-mark',
    lane,
    origin: 'system',
    trust: 'trusted',
    actor,
    ignorable: true,
    // Optional members are left out rather than set to undefined, so the value is plain JSON.
    data: opMarkData(prev, next) as EventInput['data'],
  }
}
