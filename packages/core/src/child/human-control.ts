import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ChildHandle } from '@agnes/core-effects/effects/tool-context'
import type { ChildTaskRecord } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { noteChildIdle } from './idle-retirement.js'
import { childControls } from './pause-control.js'
import { recordedChildRole } from './roles.js'
import { type Checkpoint, checkpointOpenOptions } from './status.js'

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

export async function activateCheckpointChild(
  parent: SessionImpl,
  record: ChildTaskRecord,
  checkpoint: Checkpoint | undefined,
  port: {
    cached(): ChildHandle | undefined
    legacyResume(): Promise<ChildHandle>
    open(options: ReturnType<typeof checkpointOpenOptions>): Promise<ChildHandle>
    pump(): void
  },
) {
  const cached = port.cached()
  if (!cached && checkpoint && !(await recordedChildRole(parent, record.childKey))) {
    const handle = await port.open(checkpointOpenOptions(parent, record, checkpoint))
    if (record.state === 'idle') port.pump()
    else void handle.run(record.inputText).catch(bestEffort(parent.d.logger, 'checkpoint-resume'))
  } else if (cached && record.state === 'idle') port.pump()
  else await port.legacyResume()
}
