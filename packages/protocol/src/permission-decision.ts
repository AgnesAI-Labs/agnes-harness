import type { Actor } from '../gen/ts/session-v1.js'

/** Backend snapshot, outside all author-controlled inputs. Identity changes on reopen. */
export interface PermissionContext {
  readonly policy: string
  readonly actor: Actor
  readonly sessionKey: string
  readonly sessionId: string
  readonly epoch: number
}
const permissionPurposes = new Set([
  'permission',
  'tool.permission',
  'candidate.test',
  'plugin.publish',
  'memory',
  'credential.admin',
  'skills.install',
  'mcp.connect',
  'gate',
  'refine',
  'calibrate',
  'budget',
])

export const isPermissionPurpose = (purpose: string) => permissionPurposes.has(purpose)

/** Only trusted permission entry points may supply category=permission. Never classify by buttons. */
export function automaticPermissionDecision(
  context: Pick<PermissionContext, 'policy' | 'actor'> | undefined,
  purpose = 'permission',
  options: readonly string[] = ['allowed-once', 'rejected'],
  category: 'permission' | 'question' = 'permission',
) {
  if (
    context?.policy !== 'full-access' ||
    category !== 'permission' ||
    !permissionPurposes.has(purpose) ||
    !options.includes('allowed-once')
  )
    return undefined
  return {
    verdict: 'allowed-once' as const,
    reason: 'full-access' as const,
    answeredBy: {
      ...structuredClone(context.actor),
      role: 'system',
      attrs: { ...structuredClone(context.actor.attrs), permissionPolicy: 'full-access' },
    },
  }
}

export function samePermissionContext(expected: PermissionContext, current: PermissionContext | undefined) {
  return (
    !!current &&
    !!expected.sessionKey &&
    !!expected.sessionId &&
    Number.isSafeInteger(expected.epoch) &&
    expected.epoch >= 0 &&
    expected.sessionKey === current.sessionKey &&
    expected.sessionId === current.sessionId &&
    expected.epoch === current.epoch &&
    expected.policy === current.policy &&
    JSON.stringify(expected.actor) === JSON.stringify(current.actor)
  )
}
