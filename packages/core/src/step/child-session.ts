import type { SessionImpl } from './session.js'

/**
 * Whether this session is a child: a delegated child, a role child, or a fork. A role child opens
 * with no parent at all; its delegation, which every child carries, says it is one.
 */
export function isChildSession(s: SessionImpl): boolean {
  return opensAsChild(s.d.log, s.state, s.d.roleDelegation)
}

/** `isChildSession` from the parts a session is opened with, before the session exists. */
export function opensAsChild(
  log: { parent?: unknown },
  state: { session?: { parent?: unknown; delegation?: unknown } | null | undefined },
  roleDelegation: unknown,
): boolean {
  return (
    log.parent !== undefined ||
    state.session?.parent !== undefined ||
    state.session?.delegation !== undefined ||
    roleDelegation !== undefined
  )
}
