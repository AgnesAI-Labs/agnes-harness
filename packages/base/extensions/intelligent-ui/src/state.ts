import type { ProjectionDef } from '@agnes/extension-api'
import type { DeferredToolInvocation } from '@agnes/plugin-runtime/deferred-contract'
import { UI_EVENTS, UI_OWNER, UI_PREFIX } from '@agnes/intelligent-ui-contract'
import type { EventEnvelope, JsonValue, UiActionParams, UiSurfaceRecord } from '@agnes/protocol'
import { jcs, type UiRefusal, validateAgainst } from '@agnes/protocol'
import { UiActionReceipt } from '@agnes/protocol/gen/intelligent-ui'

export { UI_EVENTS, UI_OWNER, UI_PREFIX }
export interface ActionRecord {
  request: UiActionParams
  actor: import('@agnes/protocol').Actor
  receivedSeq: number
  receivedAt: number
  taskId?: string
  surfaceSeq?: number
  invocation?: DeferredToolInvocation
  receipt: UiActionReceipt
  deliveredSeq?: number
  deferredSeq?: number
  refusalPending?: UiRefusal
}
export interface UiState {
  lastSeq: number
  surfaces: Record<string, UiSurfaceRecord>
  actions: Record<string, ActionRecord>
}
export const initialUiState = (): UiState => ({ lastSeq: 0, surfaces: {}, actions: {} })
/** Namespace provenance, lane filtering by Host, sequence stamps from the ledger, not the payload. */
export function foldUiEvent(state: UiState, event: EventEnvelope): UiState {
  if (event.origin !== `ext:${UI_OWNER}` || !event.type.startsWith(UI_PREFIX)) return state
  const name = event.type.slice(UI_PREFIX.length)
  if (!UI_EVENTS.includes(name)) return state
  const next = { ...state, lastSeq: event.seq }
  const data = event.data as unknown as Record<string, unknown>
  if (name.startsWith('surface.')) {
    const record = data.record as UiSurfaceRecord
    const old = state.surfaces[record.surface.id]
    if (
      name === 'surface.opened'
        ? !!old || record.surface.revision !== 1 || record.status !== 'open'
        : !old ||
          old.status !== 'open' ||
          record.owner !== old.owner ||
          record.lane !== old.lane ||
          record.taskId !== old.taskId ||
          (name === 'surface.updated'
            ? record.surface.revision !== old.surface.revision + 1 || record.status !== 'open'
            : record.status !== 'closed' || jcs(record.surface) !== jcs(old.surface))
    )
      throw new Error('UI surface ledger chain is corrupt')
    next.surfaces = {
      ...state.surfaces,
      [record.surface.id]: {
        ...record,
        createdSeq: old?.createdSeq ?? event.seq,
        updatedSeq: event.seq,
      },
    }
  } else if (name === 'action.received' || name === 'action.rejected') {
    const record = data.record as ActionRecord
    const old = state.actions[record.request.commandId]
    if (
      name === 'action.received'
        ? !!old
        : !old || ['rejected', 'succeeded', 'failed'].includes(old.receipt.status)
    )
      throw new Error('UI action ledger chain is corrupt')
    if (old && jcs(old.request) !== jcs(record.request)) throw new Error('UI action binding changed')
    next.actions = {
      ...state.actions,
      [record.request.commandId]: {
        ...record,
        receivedSeq: old?.receivedSeq ?? event.seq,
        receipt: { ...record.receipt, seq: event.seq, duplicate: false },
      },
    }
  } else {
    const id = data.commandId as string,
      old = state.actions[id]
    if (!old) throw new Error('UI action predecessor is missing')
    next.actions = {
      ...state.actions,
      [id]:
        name === 'action.delivered'
          ? { ...old, deliveredSeq: event.seq }
          : name === 'action.retried'
            ? old
            : {
                ...old,
                ...(typeof data.deferredSeq === 'number' ? { deferredSeq: data.deferredSeq } : {}),
                receipt: { ...(data.receipt as UiActionReceipt), seq: event.seq, duplicate: false },
              },
    }
  }
  if (name.startsWith('action.') && name !== 'action.retried' && name !== 'action.delivered') {
    const receipt = Object.values(next.actions).find((record) => record.receipt.seq === event.seq)!.receipt
    if (
      !validateAgainst(UiActionReceipt, receipt).ok ||
      (receipt.status === 'succeeded' && !receipt.resultSeq) ||
      (receipt.status === 'failed' &&
        (!receipt.failure || (receipt.failure.outcomeUnknown && receipt.failure.retryable))) ||
      (receipt.status === 'rejected' && !receipt.refusal) ||
      (receipt.status === 'pending-approval' && (!receipt.invocationId || !receipt.approvalId))
    )
      throw new Error('UI action receipt is corrupt')
  }
  return next
}
/** Projection holds current surfaces and the latest bounded receipt page; history stays in facts. */
export const uiProjection: ProjectionDef = {
  name: 'surfaces',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['lastSeq', 'surfaces', 'actions'],
    additionalProperties: false,
    properties: { lastSeq: { type: 'integer' }, surfaces: { type: 'object' }, actions: { type: 'object' } },
  },
  init: () => ({ lastSeq: 0, surfaces: {}, actions: {} }),
  apply(state, event) {
    if (event.origin !== `ext:${UI_OWNER}` || !event.type.startsWith(UI_PREFIX)) return state as JsonValue
    const current = state as {
      lastSeq: number
      surfaces: Record<string, UiSurfaceRecord>
      actions: Record<string, { receipt: UiActionReceipt }>
    }
    const next = {
      ...current,
      lastSeq: event.seq,
      surfaces: { ...current.surfaces },
      actions: { ...current.actions },
    }
    const name = event.type.slice(UI_PREFIX.length)
    if (!UI_EVENTS.includes(name)) return state as JsonValue
    const data = event.data as unknown as {
      record?: UiSurfaceRecord | ActionRecord
      receipt?: UiActionReceipt
      commandId?: string
    }
    if (name.startsWith('surface.')) {
      const record = data.record as UiSurfaceRecord,
        old = next.surfaces[record.surface.id]
      if (record.status === 'closed') delete next.surfaces[record.surface.id]
      else
        next.surfaces[record.surface.id] = {
          ...record,
          createdSeq: old?.createdSeq ?? event.seq,
          updatedSeq: event.seq,
        }
    } else {
      const receipt = data.receipt ?? (data.record as ActionRecord | undefined)?.receipt
      if (receipt)
        next.actions[receipt.commandId] = { receipt: { ...receipt, seq: event.seq, duplicate: false } }
    }
    const ordered = Object.entries(next.actions).sort((a, b) => b[1].receipt.seq - a[1].receipt.seq)
    const pending = ordered.filter(([, entry]) =>
      ['received', 'executing', 'pending-approval'].includes(entry.receipt.status),
    )
    const terminal = ordered
      .filter(([, entry]) => !['received', 'executing', 'pending-approval'].includes(entry.receipt.status))
      .slice(0, 64)
    next.actions = Object.fromEntries([...pending, ...terminal])
    while (new TextEncoder().encode(JSON.stringify(next)).byteLength > 262144 && terminal.length) {
      const [id] = terminal.pop()!
      delete next.actions[id]
    }
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 262144)
      throw new Error('UI projection capacity exceeded')
    return next as unknown as JsonValue
  },
  view: (state) => state as JsonValue,
}
