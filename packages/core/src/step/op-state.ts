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

export function opStateEvent(lane: string, state: OpStateObj | null, actor: Actor): EventInput {
  return {
    type: 'op.state',
    register: 'op.state',
    lane,
    origin: 'system',
    trust: 'trusted',
    actor,
    data: state,
  }
}
