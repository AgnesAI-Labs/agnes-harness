import type { Actor, DecisionPresentation } from '../gen/ts/session-v1.js'

/** Backend snapshot, outside all author-controlled inputs. Identity changes on reopen. */
export interface PermissionContext {
  /** Effective backend permission, including a trusted session switch; never a recipe or provider id. */
  readonly policy: string
  readonly actor: Actor
  readonly sessionKey: string
  readonly sessionId: string
  readonly epoch: number
}
/** Private backend capability carried into the effect's transaction; never accepted from JSON.
 * Mint with permissionEffectAdmission; verify asynchronously, then assertActive inside commit/CAS. */
export type PermissionEffectAdmission = Readonly<{
  verify(): Promise<void>
  assertActive(): void
}>

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

/** Business consent has one explicit approving option and a declared signature value.
 * Prefer English, otherwise the first locale by code point; never translate or invent a value. */
function businessConfirmationResponse(options: readonly string[], presentation?: DecisionPresentation) {
  if (options.length !== 2 || !options.includes('allowed-once') || !options.includes('rejected'))
    return undefined
  const locales = Object.keys(presentation ?? {}).sort()
  if (!locales.length || locales.some((locale) => !presentation?.[locale]?.responseValue?.trim()))
    return undefined
  return presentation![locales.includes('en') ? 'en' : locales[0]!]!.responseValue
}

/** Only trusted permission entry points may supply category=permission. Content questions never auto-answer. */
export function automaticPermissionDecision(
  context: Pick<PermissionContext, 'policy' | 'actor'> | undefined,
  purpose = 'permission',
  options: readonly string[] = ['allowed-once', 'rejected'],
  category: 'permission' | 'question' = 'permission',
  presentation?: DecisionPresentation,
) {
  const business = purpose === 'business.confirm'
  const value = business ? businessConfirmationResponse(options, presentation) : null
  if (
    context?.policy !== 'full-access' ||
    (business
      ? value === undefined || ['system', 'agent'].includes(context.actor.role)
      : category !== 'permission' || !permissionPurposes.has(purpose)) ||
    !options.includes('allowed-once')
  )
    return undefined
  return {
    verdict: 'allowed-once' as const,
    reason: 'full-access' as const,
    answeredBy: {
      ...structuredClone(context.actor),
      role: business ? context.actor.role : 'system',
      attrs: {
        ...structuredClone(context.actor.attrs),
        permissionPolicy: 'full-access',
        ...(business ? { confirmationMode: 'auto-confirmed under full access' } : {}),
      },
    },
    ...(business ? { responseValue: value } : {}),
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
