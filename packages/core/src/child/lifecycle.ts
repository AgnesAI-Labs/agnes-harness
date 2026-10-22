import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { CoreError } from '@agnes/core-common/types'
import { sessionIdentity } from '../loop/scope.js'
import type { SessionImpl } from '../step/session.js'
import { stopChildAdmissions } from './stop-admissions.js'

type Epoch = {
  controller: AbortController
  root: SessionImpl
  parent?: Epoch
  detach?: () => void
  stopping?: Promise<void>
  stopped?: boolean
}

const lifecycles = new WeakMap<object, Epoch>()

function epoch(session: SessionImpl): Epoch {
  session = sessionIdentity(session) as SessionImpl
  let value = lifecycles.get(session)
  if (!value) {
    value = { controller: new AbortController(), root: session }
    lifecycles.set(session, value)
    if (session.closingOrClosed) value.controller.abort('stopped')
  }
  return value
}

/** A live backend binding, separate from the child's immutable captured policy and durable ancestry. */
export async function bindChildLifecycle(child: SessionImpl, parent: SessionImpl): Promise<void> {
  child = sessionIdentity(child) as SessionImpl
  const record = await requireChildControl(child.d.log.storage).lookupByKey(child.key)
  if (!record || isTerminalChildState(record.state) || record.state === 'cancelling')
    throw new CoreError('E_CLOSED', 'Child admission has terminated')
  const owner = epoch(parent)
  const value = epoch(child)
  if (value.parent) {
    if (value.parent !== owner) throw new CoreError('E_RELATION', 'Child lifecycle already bound')
    return
  }
  attach(child, value, owner)
}

function attach(child: SessionImpl, value: Epoch, owner: Epoch): void {
  value.parent = owner
  value.root = owner.root
  const stop = () => {
    revokeChildLifecycle(child)
    child.ac.abort('stopped')
    // Revocation is synchronous; its canonical stopped state follows through the child writer gate.
    void child.decisions.stop().catch((error: unknown) => {
      child.d.logger.warn('descendant decision withdrawal failed', {
        sessionKey: child.key,
        error: String(error),
      })
    })
  }
  owner.controller.signal.addEventListener('abort', stop, { once: true })
  value.detach = () => owner.controller.signal.removeEventListener('abort', stop)
  if (owner.controller.signal.aborted) stop()
}

/** Close/abort are explicit revocation. A process crash executes none of this and writes no stop. */
export function revokeChildLifecycle(session: SessionImpl): void {
  const value = epoch(session)
  session.decisions.revokeScope()
  value.detach?.()
  value.controller.abort('stopped')
}

/** Join the durable stop before releasing the owning writer or admitting a new lifecycle. */
export function persistChildLifecycleStop(session: SessionImpl): Promise<void> {
  const value = epoch(session)
  value.stopping ??= stopChildAdmissions(session).then(() => {
    value.stopped = true
  })
  return value.stopping
}

/** Explicit new work can renew its own epoch, never the epoch captured from a stopped ancestor. */
export function renewChildLifecycle(session: SessionImpl): void {
  const value = epoch(session)
  if (session.closingOrClosed || value.parent?.controller.signal.aborted) return
  if (value.stopping && !value.stopped)
    throw new CoreError('E_CLOSED', 'Child lifecycle cancellation has not committed')
  if (value.controller.signal.aborted) {
    const next = { controller: new AbortController(), root: value.root }
    lifecycles.set(sessionIdentity(session), next)
    if (value.parent) attach(session, next, value.parent)
  }
}

export function childLifecycleRevoked(session: SessionImpl): boolean {
  return epoch(session).controller.signal.aborted
}

/** Capture once before an await; renewal cannot make an old delivery, source or handle live again. */
export function childLifecycle(session: SessionImpl) {
  const value = epoch(session)
  return {
    signal: value.controller.signal,
    hasParent: value.parent !== undefined,
    assertActive(rootKey?: string): void {
      if (
        session.closingOrClosed ||
        value.root.closingOrClosed ||
        value.controller.signal.aborted ||
        (rootKey !== undefined && (!value.parent || value.root.key !== rootKey))
      )
        throw new CoreError('E_CLOSED', 'Delegating session lifecycle revoked')
    },
  }
}
