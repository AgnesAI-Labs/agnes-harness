import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { Actor } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { noteChildIdle } from './idle-retirement.js'

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
  action: 'stop' | 'continue',
  actor: Actor,
  admissionId: string,
  text?: string,
): Promise<number> {
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
