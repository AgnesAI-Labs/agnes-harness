import {
  projectChildStatus,
  resolveTerminalChildState,
} from '@agnes/core-child-control/child/status-projection'
import { hasChildControl, requireChildControl } from '@agnes/core-child-control/child/store'
import { type ChildTaskRecord, isTerminalChildState } from '@agnes/core-child-control/child/types'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ChildStatus } from '@agnes/core-effects/effects/tool-context'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import { clipUtf16 } from '@agnes/core-ledger/project/clip'
import type {
  ChildAgentToolFilter,
  ChildCheckpointRecord,
  ChildExecutionState,
  DecisionSnapshot,
  NonInterruptibleStopReceipt,
} from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'
import { NO_TOOL_FILTER } from '../step/tool-filter.js'
import { childCompletedTurnBounds, childResultSequence } from './collected-result.js'
import { childCompletionId } from './completion-notice.js'
import { childControlMetrics } from './control-metrics.js'
import { childExecutionReceipt } from './execution-receipt.js'
import { type ChildEnd, childEnd } from './failure.js'
import { retiredCompletionIdentity } from './idle-retirement-fact.js'
import { ROLE_DELEGATION, recordedChildRole } from './roles.js'
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

export async function hasUnconfirmedColdStop(parent: SessionImpl, record: ChildTaskRecord): Promise<boolean> {
  const { stopReceipt } = await lifecycleFacts(parent, record)
  return stopReceipt?.disposition === 'timed_out_unknown'
}

export async function requireConfirmedColdStop(parent: SessionImpl, record: ChildTaskRecord) {
  if (await hasUnconfirmedColdStop(parent, record))
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

/** Strip paired Markdown formatting while preserving literal identifiers (`web_search`, `C#`, `#42`). */
export function cleanChildLabel(inputText: string): string {
  const firstLine = inputText.trim().split(/\r?\n/, 1)[0] ?? ''
  const cleaned = firstLine
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s([{"'（【「])\*([^*\s](?:[^*]*[^*\s])?)\*(?=$|[\s.,;:!?)\]}"'）】」。，！？])/g, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])___([^_]+)___(?=$|[^\p{L}\p{N}_])/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])__([^_]+)__(?=$|[^\p{L}\p{N}_])/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_([^_\s](?:[^_]*[^_\s])?)_(?=$|[^\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  return clipUtf16(cleaned, 80)
}

export async function humanChildState(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child: SessionImpl | undefined,
  continuable: boolean,
) {
  const projected = projectChildControls(record)
  const directParent = record.parentKey === parent.key
  const capabilities = child?.d.loopFactory.controls
  const steer = child
    ? capabilities?.steer === true
    : directParent
      ? parent.d.loopFactory.controls?.steer === true
      : true
  const label = cleanChildLabel(record.inputText)
  const canBindCold = Boolean(child) || continuable
  const canRetain = child
    ? projected.controls.retain
    : record.state === 'paused'
      ? await hasColdCheckpointBinding(parent, record, directParent)
      : projected.controls.retain && continuable
  return {
    id: record.childKey,
    parentId: record.parentKey,
    providerId: 'in-process',
    ...(label ? { label } : {}),
    ...projected,
    controls: {
      ...projected.controls,
      pause: projected.controls.pause && canBindCold && (!child || capabilities?.pause === true),
      retain: canRetain,
      stop: projected.controls.stop && capabilities?.interrupt === true && !!child?.op(),
      continue: projected.controls.cancel && record.state !== 'paused' && steer && continuable,
    },
    ...(await childControlMetrics(parent, record, !!child?.op())),
  }
}

export function snapshotFromRecord(record: ChildTaskRecord): Snapshot {
  const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled'
  return {
    ...projectChildControls(record),
    stateRevision: record.stateRevision,
    state:
      record.state === 'failed' || record.state === 'cancelled' ? 'error' : terminal ? 'done' : 'running',
    lastSeq: 0,
    ...(record.state === 'idle' ? { idle: true } : {}),
    ...(record.state === 'cancelled'
      ? {
          cancelled: true as const,
          completionId: childCompletionId(record.childKey, 'cancelled'),
          completionSeq: 0,
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
  let current = { ...record }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = snapshotFromRecord(current)
    const terminal =
      current.state === 'completed' || current.state === 'failed' || current.state === 'cancelled'
    const idle = current.state === 'idle'
    try {
      const fromSeq = (current.boundarySeq + 1) as typeof current.boundarySeq
      const tail = await parent.d.log.storage.scan(current.childKey, { fromSeq, order: 'desc', limit: 1 })
      const upperSeq = tail[0]?.seq ?? 0
      const turnBounds =
        idle && upperSeq > 0 ? await childCompletedTurnBounds(parent, current, upperSeq) : undefined
      const completionSeq = idle
        ? (turnBounds?.endSeq ?? 0)
        : terminal
          ? upperSeq > 0
            ? await childResultSequence(parent, current, upperSeq)
            : 0
          : undefined
      const msgFromSeq = idle && turnBounds ? turnBounds.startSeq : fromSeq
      const boundSeq = idle && turnBounds ? turnBounds.endSeq : upperSeq
      const msgs =
        boundSeq > 0
          ? await parent.d.log.storage.scan(current.childKey, {
              fromSeq: msgFromSeq,
              toSeq: boundSeq,
              type: 'assistant/message',
              order: 'desc',
              limit: 1,
            })
          : []
      const content = (msgs[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
        ?.content
      const text = (content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      const failedEnd =
        current.state === 'failed'
          ? (end ??
            (boundSeq > 0
              ? childEnd(
                  (
                    await parent.d.log.storage.scan(current.childKey, {
                      type: 'turn/end',
                      fromSeq,
                      toSeq: boundSeq,
                      order: 'desc',
                      limit: 1,
                    })
                  )[0]?.data,
                )
              : {}))
          : undefined
      const completionId =
        completionSeq === undefined
          ? undefined
          : ((await retiredCompletionIdentity(parent, current, completionSeq)) ??
            (terminal
              ? childCompletionId(current.childKey, current.state as 'completed' | 'failed' | 'cancelled')
              : idle
                ? childCompletionId(current.childKey, 'completed', completionSeq)
                : undefined))
      const latest = hasChildControl(parent.d.log.storage)
        ? await parent.d.log.storage.lookupByKey(current.childKey)
        : null
      if (latest && (latest.state !== current.state || latest.stateRevision !== current.stateRevision)) {
        current = { ...latest }
        if (attempt < 2) continue
        const freshBase = snapshotFromRecord(current)
        const { completionId: _id, completionSeq: _seq, ...unsettled } = freshBase
        return {
          ...unsettled,
          ...(await lifecycleFacts(parent, current)),
          lastSeq: upperSeq || freshBase.lastSeq,
          ...(text ? { text } : {}),
          receipt: await childExecutionReceipt(parent, current),
        }
      }
      return {
        ...base,
        ...(await lifecycleFacts(parent, current)),
        ...(failedEnd ?? {}),
        ...(completionId && completionSeq !== undefined ? { completionId, completionSeq } : {}),
        lastSeq: upperSeq || base.lastSeq,
        ...(text ? { text } : {}),
        receipt: await childExecutionReceipt(parent, current),
      }
    } catch (error) {
      const { completionId: _id, completionSeq: _seq, ...degraded } = base
      return {
        ...degraded,
        ledgerReadFailed: true as const,
        readError: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return snapshotFromRecord(current)
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
  const fallback = snapshotFromRecord(record)
  try {
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
  } catch (error) {
    const { completionId: _id, completionSeq: _seq, ...degraded } = fallback
    return {
      ...degraded,
      ledgerReadFailed: true as const,
      readError: error instanceof Error ? error.message : String(error),
    }
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
export type RetainedBinding = {
  authority: string
  digest: string
  generationDepth: number
  cwd: string
  toolFilter?: ChildAgentToolFilter
}
export type Checkpoint = ChildCheckpointRecord & {
  previousState: ChildExecutionState
  stateRevision: number
  binding?: RetainedBinding
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

export function retainedBindingOf(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child: SessionImpl,
): RetainedBinding {
  const filter = narrowChildToolFilter(
    childSessionToolFilter(child),
    child.toolFilter === NO_TOOL_FILTER ? undefined : child.toolFilter,
  )
  const binding = {
    authority: authority(parent),
    generationDepth: record.generationDepth,
    cwd: record.cwd,
    ...(filter ? { toolFilter: filter } : {}),
  }
  return { ...binding, digest: bindingDigest(record.childKey, binding) }
}

function bindingDigest(childKey: string, binding: Omit<RetainedBinding, 'digest'>) {
  return sha256Hex(canonicalJson({ childKey, ...binding }))
}

export function bindingMatchesRecord(
  record: ChildTaskRecord,
  binding: RetainedBinding | undefined,
): binding is RetainedBinding {
  if (!binding) return false
  const { digest, ...pinned } = binding
  return (
    typeof pinned.authority === 'string' &&
    pinned.authority.length > 0 &&
    pinned.cwd === record.cwd &&
    pinned.generationDepth === record.generationDepth &&
    digest === bindingDigest(record.childKey, pinned)
  )
}

export function bindingMatchesParent(
  parent: SessionImpl,
  record: ChildTaskRecord,
  binding: RetainedBinding | undefined,
): binding is RetainedBinding {
  return bindingMatchesRecord(record, binding) && binding.authority === authority(parent)
}

async function hasColdCheckpointBinding(
  parent: SessionImpl,
  record: ChildTaskRecord,
  directParent: boolean,
): Promise<boolean> {
  const checkpoint = await latestCheckpoint(parent, record)
  if (!checkpoint) return false
  return directParent
    ? bindingMatchesParent(parent, record, checkpoint.binding)
    : bindingMatchesRecord(record, checkpoint.binding)
}

export function retainedOpenOptions(
  parent: SessionImpl,
  record: ChildTaskRecord,
  binding: RetainedBinding | undefined,
) {
  if (!bindingMatchesParent(parent, record, binding))
    throw new CoreError('E_RELATION', 'Cannot restore the pinned retained child binding')
  return {
    parent: parent.key,
    cwd: record.cwd,
    input: record.inputText,
    resident: true as const,
    recovering: true as const,
    ...(binding.toolFilter ? { toolFilter: binding.toolFilter } : {}),
  }
}

export function checkpointOpenOptions(parent: SessionImpl, record: ChildTaskRecord, checkpoint: Checkpoint) {
  const binding = checkpoint.binding
  if (!bindingMatchesParent(parent, record, binding))
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

const RETAINED = 'x/core/child-retained'

export async function readTrustedRetained(parent: SessionImpl, record: ChildTaskRecord) {
  const [row] = await parent.d.log.storage.scan(record.childKey, {
    type: RETAINED,
    fromSeq: record.boundarySeq + 1,
    order: 'desc',
    limit: 1,
  })
  if (!row) return undefined
  const data = row.data as { childKey?: string; binding?: RetainedBinding } | undefined
  return row.origin === 'system' && row.trust === 'trusted' && data?.childKey === record.childKey
    ? data
    : null
}

export async function pinnedChildBinding(parent: SessionImpl, record: ChildTaskRecord, live?: SessionImpl) {
  if (live) return retainedBindingOf(parent, record, live)
  const source =
    record.state === 'paused'
      ? await readChildCheckpoint(parent, record)
      : await readTrustedRetained(parent, record)
  if (!bindingMatchesParent(parent, record, source?.binding))
    throw new CoreError('E_RELATION', 'Cannot restore the pinned child binding')
  return source.binding
}

async function latestCheckpoint(parent: SessionImpl, record: ChildTaskRecord) {
  const [row] = await parent.d.log.storage.scan(record.childKey, {
    type: CHECKPOINT,
    fromSeq: record.boundarySeq + 1,
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
  const checkpoint: Checkpoint = {
    binding: await pinnedChildBinding(parent, record, child),
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
  if (isTerminalChildState(record.state)) return resolveTerminalChildState(record.state, 'cancelled')
  const checkpoint = record.state === 'paused' ? await readChildCheckpoint(parent, record) : undefined
  const query = {
    fromSeq: record.boundarySeq + 1,
    ...(checkpoint ? { toSeq: checkpoint.pausedAtSeq } : {}),
    order: 'desc' as const,
  }
  const [[start], [end]] = await Promise.all([
    parent.d.log.storage.scan(record.childKey, { ...query, type: 'turn/start', limit: 1 }),
    parent.d.log.storage.scan(record.childKey, { ...query, type: 'turn/end', limit: 1 }),
  ])
  const hasOpenTurn = (start?.seq ?? 0) > (end?.seq ?? 0)
  const currentEndReason = !hasOpenTurn ? (end?.data as { reason?: string } | undefined)?.reason : undefined
  const effectiveState = record.state === 'paused' ? checkpoint?.previousState : record.state
  const outcome =
    currentEndReason && ['error', 'budget', 'max_steps'].includes(currentEndReason)
      ? 'failed'
      : !hasOpenTurn && effectiveState === 'idle'
        ? 'completed'
        : 'cancelled'
  return resolveTerminalChildState(record.state, outcome)
}

export async function childHasPendingWork(
  parent: SessionImpl,
  key: string,
  child?: SessionImpl,
): Promise<boolean> {
  if (child) {
    const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
    return Boolean(child.op() || inbox?.items?.length)
  }
  const registers = await parent.d.log.storage.registers(key)
  return registers.some(
    (row) =>
      (row.register === 'op.state' && row.data !== null) ||
      (row.register === 'inbox' &&
        Array.isArray((row.data as { items?: unknown[] } | undefined)?.items) &&
        ((row.data as { items?: unknown[] }).items?.length ?? 0) > 0),
  )
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

export async function recordedOwnChildRole(parent: SessionImpl, record: ChildTaskRecord) {
  const [row] = await parent.d.log.storage.scan(record.childKey, {
    type: ROLE_DELEGATION,
    fromSeq: record.boundarySeq + 1,
    limit: 1,
  })
  if (!row || row.origin !== 'system' || row.trust !== 'trusted') return undefined
  const [owned] = await parent.d.log.storage.scanIntegrity(record.childKey, {
    fromSeq: row.seq,
    toSeq: row.seq,
    limit: 1,
  })
  if (owned && (owned.sessionKey !== record.childKey || owned.event.id !== row.id)) return undefined
  return recordedChildRole(parent, record.childKey)
}

export async function childApprovalPending(parent: SessionImpl, key: string, child?: SessionImpl) {
  const decisions = child
    ? [...child.state.registers.decisionStates.values()].map((cell) => cell.value)
    : (await parent.d.log.storage.registers(key))
        .filter((row) => row.register === 'decision/state')
        .map((row) => row.data as DecisionSnapshot)
  return decisions.some((value) => value.handle.sessionId === key && !value.result && !value.invalidation)
}
