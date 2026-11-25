import { projectChildStatus } from '@agnes/core-child-control/child/status-projection'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ChildHandle, ChildStatus } from '@agnes/core-effects/effects/tool-context'
import type { ChildWorkspaceLifecycle } from '@agnes/core-effects/workspace/runtime'
import type { ChildAgentListing, ChildAgentResult, ChildTaskRecord } from '@agnes/extension-api'
import type { Actor, AgentRef } from '@agnes/protocol'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { withCancelledChildAck } from './collected-result.js'
import { cancelOpenAttempt, reportFailedCreation } from './creation.js'
import { noteChildIdle } from './idle-retirement.js'
import { ChildLifecycleControls, childControls, settleColdCancelling } from './pause-control.js'
import type { ChildRolePort, ResolvedChildRole } from './roles.js'
import { childBackend } from './sessions.js'
import {
  bindingMatchesParent,
  bindingMatchesRecord,
  type Checkpoint,
  checkpointOpenOptions,
  cleanChildLabel,
  humanChildState,
  readChildCheckpoint,
  readTrustedRetained,
  recordedOwnChildRole,
  requireOpenWorkspace,
  retainedBindingOf,
  retainedOpenOptions,
} from './status.js'

type Owner = {
  parent: SessionImpl
  child: SessionImpl
  stopped: Set<string>
  signals: Map<string, AbortController>
  stopReady: Map<string, () => void>
  waiters: Map<string, () => void>
  resident: boolean
  admit(): Promise<void>
  pump(): void
}

/** The pinned human control path, called inside the child's shared admission fence. */
export async function applyHumanChildControl(
  owner: Owner,
  action: 'stop' | 'continue' | 'pause' | 'resume' | 'close' | 'retain',
  actor: Actor,
  admissionId: string,
  text?: string,
): Promise<number> {
  if (action === 'pause' || action === 'resume' || action === 'close' || action === 'retain')
    return applyHumanLifecycle(owner.parent, owner.child.key, owner.child, action, actor, admissionId)
  const parent = owner.parent
  const childKey = owner.child.key
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (!record || !(record.parentKey === parent.key || record.runtimeOwnerSessionKey === parent.key))
    throw new CoreError('E_CHILD_NOT_FOUND', 'Child is not owned by this parent')
  if (action === 'continue' && (isTerminalChildState(record.state) || record.state === 'cancelling'))
    throw new CoreError('E_UNSUPPORTED', 'Child admission has terminated')
  const child = owner.child
  if (!child) throw new CoreError('E_UNSUPPORTED', 'Child has no live control endpoint', { control: action })
  if (action === 'stop') {
    await child.controls.require('interrupt', actor)
    if (!child.op())
      throw new CoreError('E_RELATION', 'Child has no running turn', { reason: 'CONTROL_NOT_RUNNING' })
    if (owner.stopped.has(childKey))
      throw new CoreError('E_RELATION', 'Child stop already requested', { reason: 'CONTROL_NOT_RUNNING' })
    owner.stopped.add(childKey)
    const ready = owner.signals.has(childKey)
      ? new Promise<void>((resolve) => owner.stopReady.set(childKey, resolve))
      : Promise.resolve()
    try {
      const seq = await child.controls.apply('cancel', actor, admissionId)
      await ready
      return seq
    } catch (error) {
      owner.stopped.delete(childKey)
      owner.waiters.get(childKey)?.()
      throw error
    } finally {
      owner.stopReady.delete(childKey)
    }
  }
  await child.controls.require('steer', actor)
  if (!text?.trim()) throw new CoreError('E_ENVELOPE', 'Continue requires a message')
  const waiter = owner.waiters.get(childKey)
  if (!waiter && !owner.resident)
    throw new CoreError('E_UNSUPPORTED', 'Child is not continuable', { control: 'continue' })
  await owner.admit()
  noteChildIdle(child, false)
  const seq = await child.enqueue(child.op() ? 'next-step' : 'next-turn', {
    content: [{ type: 'text', text }],
    kind: 'steer',
    actor,
    // Internal message/control IDs need the same stable digest shape as RPC admissions.
    admissionId: /^[0-9a-f]{64}$/.test(admissionId) ? admissionId : sha256Hex(admissionId),
  })
  await child.d.log.append([child.controls.fact('child-continue', 'applied', actor, { admissionId })])
  owner.stopped.delete(childKey)
  if (waiter) waiter()
  else owner.pump()
  return seq
}

export type PendingPauseSettlement = Promise<Awaited<ReturnType<ChildLifecycleControls['pauseChild']>>>

export async function applyHumanLifecycle(
  parent: SessionImpl,
  key: string,
  child: SessionImpl | undefined,
  action: 'pause' | 'resume' | 'close' | 'retain',
  actor: Actor,
  admissionId: string,
  onPending?: (pending: PendingPauseSettlement) => void,
) {
  const controls = childControls(parent)
  await (child ?? parent).controls.require(
    action === 'close' ? 'interrupt' : action === 'retain' ? 'steer' : 'pause',
    actor,
  )
  const result =
    action === 'pause'
      ? await controls.pauseChild(key, 'user_pause')
      : action === 'resume'
        ? await controls.resumeChild(key)
        : action === 'close'
          ? await controls.closeChild(key)
          : await controls.retainChild(key)
  const committed = await parent.d.log.append([
    parent.ev('x/core/child-control-result', { action, admissionId, ...result }, { actor, ignorable: true }),
  ])
  if (action === 'pause' && result.pausePending) {
    const pending = controls.pendingPause(key)
    if (pending) {
      void pending
        .then(async (settled) => {
          if (parent.closingOrClosed) return
          await parent.d.log.append([
            parent.ev(
              'x/core/child-control-result',
              { action, admissionId, ...settled },
              { actor, ignorable: true },
            ),
          ])
        })
        .catch(bestEffort(parent.d.logger, 'child-pause-control-result'))
      onPending?.(pending)
    }
  }
  return committed.firstSeq
}

const retainers = new WeakMap<SessionImpl, () => void>()

async function canReopenRetained(parent: SessionImpl, record: ChildTaskRecord): Promise<boolean> {
  if (record.state !== 'idle' && record.state !== 'interrupted') return false
  const retained = await readTrustedRetained(parent, record)
  if (retained !== undefined)
    return record.parentKey === parent.key
      ? bindingMatchesParent(parent, record, retained?.binding)
      : bindingMatchesRecord(record, retained?.binding)
  return !!(await recordedOwnChildRole(parent, record))
}

/** Install at attach, before publishing the handle. Reopen also honors an earlier durable retain. */
export async function bindChildRetention(
  parent: SessionImpl,
  record: ChildTaskRecord,
  child: SessionImpl,
  makeResident: () => void,
  resident?: boolean,
) {
  retainers.set(child, makeResident)
  const retained = await readTrustedRetained(child, record)
  if (retained) return makeResident()
  if (resident) {
    await child.append([
      child.ev(
        'x/core/child-retained',
        { childKey: child.key, binding: retainedBindingOf(parent, record, child) },
        { ignorable: true },
      ),
    ])
    makeResident()
  }
}
export function retainAttachedChild(child?: SessionImpl) {
  if (child) retainers.get(child)?.()
}

export async function admitChildContinuation(
  parent: SessionImpl,
  childKey: string,
  owns: (record: ChildTaskRecord) => boolean,
): Promise<void> {
  const store = requireChildControl(parent.d.log.storage)
  const record = await store.lookupByKey(childKey)
  if (!record || !owns(record)) throw new CoreError('E_CHILD_NOT_FOUND', 'Child is not owned by this parent')
  if (isTerminalChildState(record.state) || record.state === 'cancelling')
    throw new CoreError('E_UNSUPPORTED', 'Child admission has terminated')
  if (record.state !== 'idle' && record.state !== 'interrupted') return
  if (
    !(await store.casState(childKey, record.stateRevision, 'ready', { maxFanOut: parent.preset.maxFanOut }))
  )
    throw new CoreError('E_CAS', 'Child continuation changed during admission')
}

export async function readHumanChildState(
  parent: SessionImpl,
  childKey: string,
  owns: (record: ChildTaskRecord) => boolean,
  child: SessionImpl | undefined,
  continuable: boolean,
) {
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (!record || !owns(record)) throw new CoreError('E_CHILD_NOT_FOUND', 'Child is not owned by this parent')
  const canContinue = continuable || (!child && (await canReopenRetained(parent, record)))
  return humanChildState(parent, record, child, canContinue)
}

export async function listLocalChildren(
  parent: SessionImpl,
  port: {
    resident(key: string): { idle(): boolean } | undefined
    humanStopped(key: string): boolean
    inspect(key: string): Promise<ChildStatus | null>
  },
): Promise<readonly ChildAgentListing[]> {
  const rows = await requireChildControl(parent.d.log.storage).listByParent(parent.key)
  return Promise.all(
    rows.map(async (row) => {
      const resident = port.resident(row.childKey)
      const text = (await port.inspect(row.childKey))?.text
      const projected = projectChildStatus(row, {
        humanStopped: port.humanStopped(row.childKey),
        residentIdle: resident?.idle() === true,
      })
      const label = cleanChildLabel(row.inputText)
      return {
        id: row.childKey,
        providerId: 'in-process',
        status: projected.status,
        executionState: projected.executionState,
        continuable: resident !== undefined || (await canReopenRetained(parent, row)),
        ...(label ? { label } : {}),
        ...(text ? { text } : {}),
      }
    }),
  )
}

export async function throwMissingContinuable(
  parent: SessionImpl,
  childKey: string,
  owns: (record: ChildTaskRecord) => boolean,
): Promise<never> {
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (record && owns(record))
    throw new CoreError('E_UNSUPPORTED', `child ${childKey} is ${record.state} and not continuable`, {
      childKey,
      state: record.state,
    })
  throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
}

export async function disposeLocalChildren(
  parent: SessionImpl,
  keys: Iterable<string>,
  port: {
    isResident(key: string): boolean
    session(key: string): SessionImpl | undefined
    drop(key: string, child: SessionImpl): Promise<void>
    clearHandle(key: string): void
    cancel(key: string): Promise<void>
  },
) {
  return Promise.allSettled(
    [...keys].map(async (key) => {
      if (await preserveOnParentClose(parent, key, port.isResident(key))) {
        const child = port.session(key)
        if (child) await port.drop(key, child)
        else port.clearHandle(key)
        return
      }
      await port.cancel(key)
    }),
  )
}

export async function preserveOnParentClose(
  parent: SessionImpl,
  childKey: string,
  isResident: boolean,
): Promise<boolean> {
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (!record) return false
  return record.state === 'paused' || (record.state === 'idle' && isResident)
}

export async function reopenRetainedResident<T>(
  parent: SessionImpl,
  childKey: string,
  port: {
    owns(record: ChildTaskRecord): boolean
    resident(key: string): T | undefined
    open(record: ChildTaskRecord, options: ReturnType<typeof retainedOpenOptions>): Promise<ChildHandle>
    resumeRole(key: string): Promise<ChildHandle>
    markIdle(key: string, idle: boolean): void
  },
): Promise<T | undefined> {
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (!record || !port.owns(record)) return undefined
  if (record.state !== 'idle' && record.state !== 'interrupted') return undefined
  await requireOpenWorkspace(parent, record)
  if (await recordedOwnChildRole(parent, record)) {
    await port.resumeRole(childKey)
    return port.resident(childKey)
  }
  const retained = await readTrustedRetained(parent, record)
  if (!retained) {
    if (record.state === 'idle')
      throw new CoreError('E_RELATION', 'Cannot restore the pinned retained child binding')
    return undefined
  }
  await port.open(record, retainedOpenOptions(parent, record, retained.binding))
  port.markIdle(childKey, record.state === 'idle')
  return port.resident(childKey)
}

export async function reopenColdControlOwner(
  parent: SessionImpl,
  record: ChildTaskRecord,
  open: (
    options: ReturnType<typeof checkpointOpenOptions> & {
      role?: AgentRef
      resolvedRole?: ResolvedChildRole
    },
  ) => Promise<ChildHandle>,
  reopenRetained: () => Promise<unknown>,
  markIdle: () => void,
  roles?: ChildRolePort,
) {
  if (record.parentKey !== parent.key) return undefined
  if (record.state === 'paused') {
    await requireOpenWorkspace(parent, record)
    const checkpoint = await readChildCheckpoint(parent, record)
    const options = checkpointOpenOptions(parent, record, checkpoint)
    const role = await recordedOwnChildRole(parent, record)
    if (role) {
      if (!roles?.reopen)
        throw new CoreError('E_UNSUPPORTED', 'A role child must reopen through its pinned Host composition')
      await open({
        ...options,
        role: role.ref,
        resident: true,
        resolvedRole: { role, open: roles.reopen },
      })
    } else {
      await open(options)
    }
    if (checkpoint.previousState === 'idle') markIdle()
  } else await reopenRetained()
  return childBackend(record.childKey)
}

/** Roll back only a newly created attempt; re-attaching an already-committed session never mutates durable state. */
export async function cleanupFailedChildOpen(
  store: ReturnType<typeof requireChildControl>,
  parent: SessionImpl,
  attempt: ChildTaskRecord,
  createdByThisOpen: boolean,
  error: unknown,
  port: {
    handle: ChildHandle | undefined
    workspace: ChildWorkspaceLifecycle | undefined
    session(): SessionImpl | undefined
    drop(key: string, child: SessionImpl): Promise<void>
    clearHandle(key: string): void
  },
): Promise<never> {
  let cancellationError: unknown
  if (createdByThisOpen) {
    let live: ChildTaskRecord | null = null
    try {
      live = await store.lookupByKey(attempt.childKey)
    } catch (cause) {
      cancellationError = cause
    }
    if (
      !cancellationError &&
      live?.creationPhase === 'creating' &&
      live.creationId === attempt.creationId &&
      live.attemptId === attempt.attemptId
    ) {
      try {
        await cancelOpenAttempt(store, parent, live)
      } catch (cause) {
        cancellationError = cause
      }
    } else if (
      !cancellationError &&
      live &&
      !isTerminalChildState(live.state) &&
      live.creationId === attempt.creationId &&
      live.attemptId === attempt.attemptId
    ) {
      try {
        await store.casState(live.childKey, live.stateRevision, 'cancelled')
      } catch (cause) {
        cancellationError = cause
      }
    }
  }
  let workspaceCloseDelegated = false
  const child = port.session()
  if (port.handle && createdByThisOpen)
    await reportFailedCreation(parent, attempt.childKey, child?.state.creditsUsed ?? 0).catch(
      bestEffort(parent.d.logger, 'failed-child-creation-report'),
    )
  if (child) {
    workspaceCloseDelegated = true
    if (createdByThisOpen) await child.d.log.abandon().catch(bestEffort(parent.d.logger, 'child-abandon'))
    await port.drop(attempt.childKey, child)
  }
  if (!workspaceCloseDelegated)
    await port.workspace?.close().catch(bestEffort(parent.d.logger, 'child-workspace-close'))
  port.clearHandle(attempt.childKey)
  if (cancellationError)
    throw new AggregateError([error, cancellationError], 'child open and durable cancellation failed')
  throw error
}

export async function activateCheckpointChild(
  parent: SessionImpl,
  record: ChildTaskRecord,
  checkpoint: Checkpoint | undefined,
  port: {
    cached(): ChildHandle | undefined
    legacyResume(checkpoint?: Checkpoint): Promise<ChildHandle>
    open(options: ReturnType<typeof checkpointOpenOptions>): Promise<ChildHandle>
    markIdle?(): void
    pump(): void
  },
) {
  const cached = port.cached()
  if (!cached && checkpoint && !(await recordedOwnChildRole(parent, record))) {
    const handle = await port.open(checkpointOpenOptions(parent, record, checkpoint))
    if (record.state === 'idle') {
      port.markIdle?.()
      port.pump()
    } else void handle.run(record.inputText).catch(bestEffort(parent.d.logger, 'checkpoint-resume'))
  } else if (cached && record.state === 'idle') {
    port.markIdle?.()
    port.pump()
  } else await port.legacyResume(checkpoint)
}

export function createFactoryLifecycleControls(
  parent: () => SessionImpl,
  port: {
    session(key: string): SessionImpl | undefined
    handle(key: string): ChildHandle | undefined
    resumeUnpaused(key: string, checkpoint?: Checkpoint): Promise<ChildHandle>
    open(record: ChildTaskRecord, options: ReturnType<typeof checkpointOpenOptions>): Promise<ChildHandle>
    markIdle(key: string): void
    pump(key: string): void
    release(key: string, outcome: 'completed' | 'cancelled' | 'failed'): Promise<void>
  },
): ChildLifecycleControls {
  return new ChildLifecycleControls(parent, {
    live: port.session,
    activate: (record, checkpoint) =>
      activateCheckpointChild(parent(), record, checkpoint, {
        cached: () => port.handle(record.childKey),
        legacyResume: (saved) => port.resumeUnpaused(record.childKey, saved),
        open: (options) => port.open(record, options),
        markIdle: () => port.markIdle(record.childKey),
        pump: () => port.pump(record.childKey),
      }),
    release: port.release,
    retain: (key) => retainAttachedChild(port.session(key)),
  }).bind()
}

export function controlNotRunning(error: unknown): boolean {
  return (
    error instanceof CoreError &&
    error.code === 'E_RELATION' &&
    error.detail?.reason === 'CONTROL_NOT_RUNNING'
  )
}

export async function cancelChildSubtree(
  parent: SessionImpl,
  store: ReturnType<typeof requireChildControl>,
  childKey: string,
  port: { handle(key: string): ChildHandle | undefined; session(key: string): SessionImpl | undefined },
): Promise<void> {
  const record = await store.lookupByKey(childKey)
  if (!record) return
  const descendants = childBackend(childKey)
  const children = await store.listByParent(childKey)
  const handle = port.handle(childKey)
  port.session(childKey)?.ac.abort()
  const results = await Promise.allSettled(
    children.map((kid) =>
      descendants ? descendants.cancel(kid.childKey) : cancelChildSubtree(parent, store, kid.childKey, port),
    ),
  )
  try {
    if (handle?.cancel) await handle.cancel()
    else await settleColdCancelling(parent, store, childKey)
  } catch (error) {
    results.push({ status: 'rejected', reason: error })
  }
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Child subtree cleanup failed',
    )
}

export async function cancelOwnedChild(
  parent: SessionImpl,
  store: ReturnType<typeof requireChildControl>,
  childKey: string,
  port: {
    handle(key: string): ChildHandle | undefined
    session(key: string): SessionImpl | undefined
    awaitSettled(key: string): Promise<void>
    finish(key: string, result: ChildAgentResult): void
  },
): Promise<void> {
  const run = async () => {
    await cancelChildSubtree(parent, store, childKey, port)
    await port.awaitSettled(childKey)
  }
  if (port.handle(childKey)) {
    await withCancelledChildAck(parent, childKey, run)
  } else {
    await run()
    if ((await store.lookupByKey(childKey))?.state === 'cancelled')
      await withCancelledChildAck(parent, childKey, async () => {})
  }
  const final = await store.lookupByKey(childKey)
  if (final && isTerminalChildState(final.state))
    port.finish(childKey, { status: final.state as ChildAgentResult['status'], text: '' })
}
