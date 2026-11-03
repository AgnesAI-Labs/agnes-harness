import type { SessionImpl } from './session.js'

/**
 * Whether this session is a child: a delegated child, a role child, or a fork. A role child opens
 * with no parent at all; its delegation, which every child carries, says it is one.
 */
export function isChildSession(s: SessionImpl): boolean {
  return (
    s.d.log.parent !== undefined ||
    s.state.session?.parent !== undefined ||
    s.state.session?.delegation !== undefined ||
    s.d.roleDelegation !== undefined
  )
}
