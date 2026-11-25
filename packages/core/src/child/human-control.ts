import { projectChildStatus } from '@agnes/core-child-control/child/status-projection'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ChildHandle, ChildStatus } from '@agnes/core-effects/effects/tool-context'
import type { ChildAgentListing, ChildTaskRecord } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { noteChildIdle } from './idle-retirement.js'
import { ChildLifecycleControls, childControls } from './pause-control.js'
import { recordedChildRole } from './roles.js'
import { childBackend } from './sessions.js'
import { type Checkpoint, checkpointOpenOptions, humanChildState, requireOpenWorkspace } from './status.js'

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

export async function applyHumanLifecycle(
  parent: SessionImpl,
  key: string,
  child: SessionImpl | undefined,
  action: 'pause' | 'resume' | 'close' | 'retain',
  actor: Actor,
  admissionId: string,
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
  return committed.firstSeq
}

const retainers = new WeakMap<SessionImpl, () => void>()

/** Install at attach, before publishing the handle. Reopen also honors an earlier durable retain. */
export async function bindChildRetention(child: SessionImpl, makeResident: () => void, resident?: boolean) {
  retainers.set(child, makeResident)
  const [row] = await child.scan({ type: 'x/core/child-retained', order: 'desc', limit: 1 })
  if (
    row?.origin === 'system' &&
    row.trust === 'trusted' &&
    (row.data as { childKey?: string }).childKey === child.key
  )
    return makeResident()
  if (resident) {
    await child.append([child.ev('x/core/child-retained', { childKey: child.key }, { ignorable: true })])
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
  return humanChildState(parent, record, child, continuable || record.state === 'idle')
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
      const status = projectChildStatus(row, {
        humanStopped: port.humanStopped(row.childKey),
        residentIdle: resident?.idle() === true,
      }).status
      return {
        id: row.childKey,
        providerId: 'in-process',
        status,
        continuable: resident !== undefined || row.state === 'idle',
        ...(row.inputText.trim() ? { label: row.inputText.trim().split('\n', 1)[0]!.slice(0, 80) } : {}),
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
    open(
      record: ChildTaskRecord,
      options: { parent: string; cwd: string; input: string; resident: true; recovering: true },
    ): Promise<ChildHandle>
    resumeRole(key: string): Promise<ChildHandle>
    markIdle(key: string, idle: boolean): void
  },
): Promise<T | undefined> {
  const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
  if (!record || !port.owns(record)) return undefined
  if (record.state !== 'idle' && record.state !== 'interrupted') return undefined
  if (record.state !== 'idle') {
    const [row] = await parent.d.log.storage.scan(childKey, {
      type: 'x/core/child-retained',
      order: 'desc',
      limit: 1,
    })
    const retained =
      row?.origin === 'system' &&
      row.trust === 'trusted' &&
      (row.data as { childKey?: string }).childKey === childKey
    if (!retained) return undefined
  }
  await requireOpenWorkspace(parent, record)
  if (await recordedChildRole(parent, childKey)) {
    await port.resumeRole(childKey)
    return port.resident(childKey)
  }
  await port.open(record, {
    parent: parent.key,
    cwd: record.cwd,
    input: record.inputText,
    resident: true,
    recovering: true,
  })
  port.markIdle(childKey, record.state === 'idle')
  return port.resident(childKey)
}

export async function activateCheckpointChild(
  parent: SessionImpl,
  record: ChildTaskRecord,
  checkpoint: Checkpoint | undefined,
  port: {
    cached(): ChildHandle | undefined
    legacyResume(): Promise<ChildHandle>
    open(options: ReturnType<typeof checkpointOpenOptions>): Promise<ChildHandle>
    markIdle?(): void
    pump(): void
  },
) {
  const cached = port.cached()
  if (!cached && checkpoint && !(await recordedChildRole(parent, record.childKey))) {
    const handle = await port.open(checkpointOpenOptions(parent, record, checkpoint))
    if (record.state === 'idle') {
      port.markIdle?.()
      port.pump()
    } else void handle.run(record.inputText).catch(bestEffort(parent.d.logger, 'checkpoint-resume'))
  } else if (cached && record.state === 'idle') port.pump()
  else await port.legacyResume()
}

export function createFactoryLifecycleControls(
  parent: () => SessionImpl,
  port: {
    session(key: string): SessionImpl | undefined
    handle(key: string): ChildHandle | undefined
    resumeUnpaused(key: string): Promise<ChildHandle>
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
        legacyResume: () => port.resumeUnpaused(record.childKey),
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
      descendants ? descendants.cancel(kid.childKey) : cancelChildSubtree(store, kid.childKey, port),
    ),
  )
  try {
    if (handle?.cancel) await handle.cancel()
    else {
      const live = await store.lookupByKey(childKey)
      if (live && !isTerminalChildState(live.state))
        await store.casState(childKey, live.stateRevision, 'cancelling')
    }
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
