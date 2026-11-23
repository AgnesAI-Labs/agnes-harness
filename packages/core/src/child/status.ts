import {
  projectChildStatus,
  resolveTerminalChildState,
} from '@agnes/core-child-control/child/status-projection'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ChildStatus } from '@agnes/core-effects/effects/tool-context'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import type {
  ChildAgentToolFilter,
  ChildCheckpointRecord,
  ChildExecutionState,
  DecisionSnapshot,
  NonInterruptibleStopReceipt,
} from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'
import { childResultSequence } from './collected-result.js'
import { childCompletionId } from './completion-notice.js'
import { childControlMetrics } from './control-metrics.js'
import { childExecutionReceipt } from './execution-receipt.js'
import { type ChildEnd, lastChildEnd } from './failure.js'
import { retiredCompletionIdentity } from './idle-retirement-fact.js'
import { childSessionToolFilter, narrowChildToolFilter } from './tool-filter.js'

export function projectChildControls(record: ChildTaskRecord) {
  const { executionState: state, status } = projectChildStatus(record)
  const active = ['creating', 'ready', 'running', 'waiting_approval', 'idle', 'interrupted'].includes(state)
  return {
    status,
    executionState: state,
    controls: {
      pause: active,
      resume: state === 'paused' || (active && state !== 'interrupted'),
      close: ['creating', 'ready', 'paused', 'idle', 'waiting_approval', 'interrupted'].includes(state),
      retain: active || state === 'paused',
      cancel: active || ['paused', 'recovery_pending', 'disconnected'].includes(state),
      stop: state === 'running' || state === 'waiting_approval',
      continue: state === 'idle' || state === 'interrupted',
    },
  }
}
type Snapshot = ChildStatus &
  ReturnType<typeof projectChildControls> & {
    checkpoint?: ChildCheckpointRecord
    stopReceipt?: NonInterruptibleStopReceipt
  }

export async function requireConfirmedColdStop(parent: SessionImpl, record: ChildTaskRecord) {
  const { stopReceipt } = await lifecycleFacts(parent, record)
  if (stopReceipt?.disposition === 'timed_out_unknown')
    throw new CoreError('E_RELATION', 'Tool return is unconfirmed; child remains cancelling')
}

async function lifecycleFacts(parent: SessionImpl, record: ChildTaskRecord) {
  const [row] = await parent.d.log.storage.scan(record.childKey, {
    type: 'x/core/child-stop-receipt',
    order: 'desc',
    limit: 1,
  })
  const stopReceipt = row?.data as NonInterruptibleStopReceipt | undefined
  const checkpoint = record.state === 'paused' ? await latestCheckpoint(parent, record) : undefined
  return {
    ...(checkpoint ? { checkpoint } : {}),
    ...(row?.origin === 'system' && row.trust === 'trusted' && stopReceipt?.childKey === record.childKey
      ? { stopReceipt }
      : {}),
  }
}

export async function humanChildState(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child: SessionImpl | undefined,
  continuable: boolean,
) {
  const projected = projectChildControls(record)
  const capabilities = child?.d.loopFactory.controls
  return {
    id: record.childKey,
    parentId: parent.key,
    providerId: 'in-process',
    ...projected,
    controls: {
      ...projected.controls,
      pause: projected.controls.pause && (!child || capabilities?.pause === true),
      stop: projected.controls.stop && capabilities?.interrupt === true && !!child?.op(),
      continue:
        projected.controls.cancel && record.state !== 'paused' && capabilities?.steer === true && continuable,
    },
    ...(await childControlMetrics(parent, record, !!child?.op())),
  }
}

export function snapshotFromRecord(record: ChildTaskRecord): Snapshot {
  const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled'
  return {
    ...projectChildControls(record),
    state:
      record.state === 'failed' || record.state === 'cancelled' ? 'error' : terminal ? 'done' : 'running',
    lastSeq: 0,
    ...(record.state === 'idle' ? { idle: true } : {}),
    ...(record.state === 'cancelled' ? { cancelled: true as const } : {}),
    ...(terminal
      ? {
          completionId: childCompletionId(
            record.childKey,
            record.state as 'completed' | 'failed' | 'cancelled',
          ),
        }
      : {}),
  }
}

/** `end` is what the factory kept of the child's last turn; without it the ledger is read. */
export async function snapshotFromLedger(
  parent: SessionImpl,
  record: ChildTaskRecord,
  end?: ChildEnd,
): Promise<Snapshot> {
  record = { ...record }
  const base = snapshotFromRecord(record)
  try {
    const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
    const tail = await parent.d.log.storage.scan(record.childKey, { fromSeq, order: 'desc', limit: 1 })
    const msgs = await parent.d.log.storage.scan(record.childKey, {
      fromSeq,
      type: 'assistant/message',
      order: 'desc',
      limit: 1,
    })
    const content = (msgs[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content
    const text = (content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    const completionSeq = base.completionId
      ? await childResultSequence(parent, record, tail[0]?.seq ?? 0)
      : undefined
    const completionId =
      completionSeq === undefined
        ? undefined
        : ((await retiredCompletionIdentity(parent, record, completionSeq)) ?? base.completionId)
    return {
      ...base,
      ...(await lifecycleFacts(parent, record)),
      ...(record.state === 'failed' ? (end ?? (await lastChildEnd(parent, record))) : {}),
      ...(completionId && completionSeq !== undefined ? { completionId, completionSeq } : {}),
      lastSeq: tail[0]?.seq ?? base.lastSeq,
      ...(text ? { text } : {}),
      receipt: await childExecutionReceipt(parent, record),
    }
  } catch {
    return base
  }
}

/** Capture one completed result identity, so collecting it cannot acknowledge a later resident turn. */
export async function snapshotFromLive(
  parent: SessionImpl,
  record: ChildTaskRecord,
  snapshot: {
    state: 'ready' | 'running' | 'done' | 'error' | 'cancelled'
    lastSeq: number
    idle: boolean
    /** What the run kept of a failed last turn. */
    end?: ChildEnd | undefined
  },
): Promise<Snapshot> {
  record = { ...((await requireChildControl(parent.d.log.storage).lookupByKey(record.childKey)) ?? record) }
  const { lastSeq } = snapshot
  const state = record.state
  const idle = record.state === 'idle'
  const terminal = state === 'completed' || state === 'failed' || state === 'cancelled'
  const query = { fromSeq: record.boundarySeq + 1, toSeq: lastSeq, order: 'desc' as const, limit: 1 }
  const [messages, completionSeq] = await Promise.all([
    parent.d.log.storage.scan(record.childKey, { ...query, type: 'assistant/message', limit: 1 }),
    terminal || idle ? childResultSequence(parent, record, lastSeq) : 0,
  ])
  const content = (messages[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content
  const text = (content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  const retiredId =
    state === 'completed' ? await retiredCompletionIdentity(parent, record, completionSeq) : undefined
  return {
    ...snapshotFromRecord(record),
    ...(await lifecycleFacts(parent, record)),
    lastSeq,
    ...(state === 'failed' ? snapshot.end : state === 'cancelled' ? { cancelled: true as const } : {}),
    ...(idle ? { idle: true } : {}),
    ...(text ? { text } : {}),
    ...(terminal || idle
      ? {
          completionSeq,
          completionId:
            retiredId ??
            childCompletionId(
              record.childKey,
              state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'failed' : 'completed',
              idle ? completionSeq : undefined,
            ),
        }
      : {}),
    receipt: await childExecutionReceipt(parent, record),
  }
}

// A deferred child already owns a ledger but has no session or writer until first admission.
export async function withChildLog<T>(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child: SessionImpl | undefined,
  work: (log: SessionLogImpl) => Promise<T>,
): Promise<T> {
  if (child) return work(child.d.log)
  const { storage } = parent.d.log
  const { ids, clock, timers } = parent.d
  const log = await SessionLogImpl.open({
    storage,
    key: record.childKey,
    writerRunId: ids.ulid(),
    ttlMs: 60_000,
    ids,
    clock,
    ...(timers ? { timers } : {}),
  })
  try {
    await log.fullVerified()
    return await work(log)
  } finally {
    await log.close()
  }
}

export const CHECKPOINT = 'x/core/child-checkpoint'
export type Checkpoint = ChildCheckpointRecord & {
  previousState: ChildExecutionState
  stateRevision: number
  binding?: { authority: string; generationDepth: number; cwd: string; toolFilter?: ChildAgentToolFilter }
}

function authority(s: SessionImpl) {
  return sha256Hex(
    canonicalJson({
      profile: s.d.resolvedProfileHash,
      policy: s.d.policyDigest,
      preset: s.preset,
      actor: s.d.actor,
      loop: s.loop,
    }),
  )
}

export function checkpointOpenOptions(parent: SessionImpl, record: ChildTaskRecord, checkpoint: Checkpoint) {
  const binding = checkpoint.binding
  if (
    !binding ||
    binding.cwd !== record.cwd ||
    binding.generationDepth !== record.generationDepth ||
    binding.authority !== authority(parent)
  )
    throw new CoreError('E_RELATION', 'Cannot restore the pinned checkpoint authority')
  return {
    parent: parent.key,
    cwd: record.cwd,
    input: record.inputText,
    recovering: true,
    resident: checkpoint.previousState === 'idle',
    ...(binding.toolFilter ? { toolFilter: binding.toolFilter } : {}),
  }
}

async function latestCheckpoint(parent: SessionImpl, record: ChildTaskRecord) {
  const [row] = await parent.d.log.storage.scan(record.childKey, {
    type: CHECKPOINT,
    order: 'desc',
    limit: 1,
  })
  const checkpoint = row?.data as Checkpoint | undefined
  if (
    !checkpoint ||
    row?.origin !== 'system' ||
    row.trust !== 'trusted' ||
    checkpoint.childKey !== record.childKey ||
    checkpoint.stateRevision !== record.stateRevision ||
    checkpoint.pausedAtSeq >= row.seq ||
    !Array.isArray(checkpoint.completedEffectIds)
  )
    return undefined
  return checkpoint
}

export async function readChildCheckpoint(parent: SessionImpl, record: ChildTaskRecord) {
  const checkpoint = await latestCheckpoint(parent, record)
  if (!checkpoint) throw new CoreError('E_RELATION', 'Paused child has no matching checkpoint')
  return checkpoint
}

export async function writeChildCheckpoint(
  parent: SessionImpl,
  log: SessionLogImpl,
  record: ChildTaskRecord,
  reason: ChildCheckpointRecord['reason'],
  child?: SessionImpl,
) {
  await log.fullVerified()
  const pausedAtSeq = log.lastSeq
  const completed = new Set<string>()
  const paths = new Set<string>()
  const outstanding = new Set<string>()
  for await (const rows of scanPages((q) => log.scan(q), {
    fromSeq: (log.parent?.boundarySeq ?? 0) + 1,
    toSeq: pausedAtSeq,
    type: ['effect/intent', 'effect/settled', 'x/agnes/tools-core/file-change'],
  })) {
    for (const row of rows) {
      const data = row.data as { effectId?: string; replay?: string; outcome?: string; path?: string }
      if (row.type === 'effect/intent' && data.effectId && data.replay === 'never')
        outstanding.add(data.effectId)
      if (row.type === 'effect/settled' && data.effectId) {
        outstanding.delete(data.effectId)
        if (data.outcome === 'unknown')
          throw new CoreError('E_RELATION', 'Unconfirmed effect requires reconciliation')
        completed.add(data.effectId)
      }
      if (row.type === 'x/agnes/tools-core/file-change' && typeof data.path === 'string') paths.add(data.path)
    }
  }
  if (outstanding.size) throw new CoreError('E_RELATION', 'Checkpoint has unresolved one-shot effects')
  const filter = child && narrowChildToolFilter(childSessionToolFilter(child), child.toolFilter)
  const checkpoint: Checkpoint = {
    ...(child
      ? {
          binding: {
            authority: authority(child),
            generationDepth: record.generationDepth,
            cwd: record.cwd,
            ...(filter ? { toolFilter: filter } : {}),
          },
        }
      : {}),
    childKey: record.childKey,
    reason,
    pausedAtSeq,
    pausedAt: parent.d.clock(),
    previousState: record.state,
    stateRevision: record.stateRevision + 1,
    completedEffectIds: [...completed],
    artifactPaths: [...paths],
  }
  await log.append([parent.ev(CHECKPOINT, checkpoint, { ignorable: true })])
  return checkpoint
}

export async function requireOpenWorkspace(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child?: SessionImpl,
) {
  if (record.isolation === 'worktree') {
    const ws =
      record.workspaceId && (await requireChildControl(parent.d.log.storage).workspace(record.workspaceId))
    const exists =
      ws &&
      ws.childKey === record.childKey &&
      ws.path === record.cwd &&
      ['attached', 'kept_dirty', 'kept_unmerged'].includes(ws.phase) &&
      (await (child ?? parent).d.workspaceInvocation
        ?.run(async (view) => (await view.fs().stat(ws.path)).kind === 'dir')
        .catch(() => false))
    if (!exists) throw new CoreError('E_WORKSPACE_CLOSED', 'Isolated workspace is no longer available')
  }
}

export async function childCloseOutcome(parent: SessionImpl, record: ChildTaskRecord) {
  const checkpoint = record.state === 'paused' ? await readChildCheckpoint(parent, record) : undefined
  const [end] = await parent.d.log.storage.scan(record.childKey, {
    type: 'turn/end',
    fromSeq: record.boundarySeq + 1,
    order: 'desc',
    limit: 1,
  })
  const reason = (end?.data as { reason?: string } | undefined)?.reason
  const outcome =
    reason && ['error', 'budget', 'max_steps'].includes(reason)
      ? 'failed'
      : record.state === 'idle' ||
          checkpoint?.previousState === 'idle' ||
          checkpoint?.artifactPaths.length ||
          reason === 'completed'
        ? 'completed'
        : 'cancelled'
  return resolveTerminalChildState(record.state, outcome)
}

export async function checkpointPauseFence(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child: SessionImpl | undefined,
  paused: boolean,
  checkpoint?: Checkpoint,
) {
  const write = () =>
    withChildLog(parent, record, child, (log) =>
      log.append([
        (child ?? parent).ev('x/core/pause-state', { paused }, { ignorable: true }),
        ...(checkpoint
          ? [
              parent.ev(
                CHECKPOINT,
                { ...checkpoint, stateRevision: record.stateRevision + 1 },
                { ignorable: true },
              ),
            ]
          : []),
      ]),
    )
  if (child) await child.locked(write)
  else await write()
}

export async function childApprovalPending(parent: SessionImpl, key: string, child?: SessionImpl) {
  const decisions = child
    ? [...child.state.registers.decisionStates.values()].map((cell) => cell.value)
    : (await parent.d.log.storage.registers(key))
        .filter((row) => row.register === 'decision/state')
        .map((row) => row.data as DecisionSnapshot)
  return decisions.some((value) => value.handle.sessionId === key && !value.result && !value.invalidation)
}
