import type { Actor } from '../gen/ts/session-v1.js'

/** Trusted runtime context; never accept it from tool arguments or public RPC bodies. */
export interface PermissionContext {
  /** Effective session preset identity, not the selected advisory tool-policy provider. */
  readonly policy: string
  readonly actor: Actor
}

/** The one automatic permission rule, shared by durable decisions and control-plane delivery.
 * Questions, chosen modes and factual reconciliation do not grant permission.
 */
export function automaticPermissionDecision(
  context: PermissionContext | undefined,
  purpose = 'permission',
  options: readonly string[] = ['allowed-once', 'rejected'],
) {
  if (
    context?.policy !== 'full-access' ||
    purpose === 'plan.exit' ||
    purpose === 'unknown-outcome' ||
    !options.includes('allowed-once')
  )
    return undefined
  return {
    verdict: 'allowed-once' as const,
    reason: 'full-access' as const,
    answeredBy: {
      ...structuredClone(context.actor),
      role: 'system',
      attrs: { ...context.actor.attrs, permissionPolicy: 'full-access' },
    },
  }
}
