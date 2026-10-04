import type { Inbox } from '../reduce/shapes.js'
import { CoreError } from '../types.js'
import type { SessionImpl } from './session.js'

const held = new WeakMap<SessionImpl, object>()
export function sessionIdleGateHeld(session: SessionImpl): boolean {
  return held.has(session)
}
export function assertSessionIdleGateMutable(session: SessionImpl): void {
  if (held.has(session)) throw new CoreError('E_LANE_BUSY', 'Session idle gate is held')
}
/** Process-local idle proof. No input authority and no automatic expiry. */
export function acquireSessionIdleGate(
  session: SessionImpl,
  allocationActive: () => boolean,
): Promise<{ check(): void; release(): void }> {
  return session.tryLocked(async () => {
    const idle = () => {
      if (
        session.closingOrClosed ||
        session.executionActive ||
        session.configurationReserved ||
        session.op() ||
        allocationActive() ||
        ((session.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0
      )
        throw new CoreError('E_LANE_BUSY', 'Session is not idle')
    }
    assertSessionIdleGateMutable(session)
    idle()
    const identity = {}
    const writer = session.writerRunId
    const runtime = session.d.currentRuntime?.current(session.key)
    held.set(session, identity)
    let released = false
    return {
      check() {
        if (
          released ||
          held.get(session) !== identity ||
          session.writerRunId !== writer ||
          session.d.currentRuntime?.current(session.key) !== runtime
        )
          throw new CoreError('E_RELATION', 'Session idle owner changed')
        idle()
      },
      release() {
        if (released) return
        released = true
        if (held.get(session) === identity) held.delete(session)
        session.configurationAdmissionIdle()
      },
    }
  })
}
