import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'

/** A current read of the supervisor's original ownership index, not an authorization grant. */
export type SessionOwnershipFact = Readonly<{
  sessionId: string
  principalId: string
  check(): void
}>

/** The caller must supply the supervisor's selected ownership instance, never a request DTO. */
export function captureSessionOwnershipFact(
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>,
  sessionId: string,
  expectedPrincipalId: string,
): SessionOwnershipFact {
  const unavailable = (): Error => new Error('original session ownership unavailable')
  const resolve = ownership.resolve
  if (typeof resolve !== 'function') throw unavailable()
  const read = () => {
    if (ownership.resolve !== resolve) throw unavailable()
    return Reflect.apply(resolve, ownership, [sessionId]) as ReturnType<typeof resolve>
  }
  let principalId: string
  try {
    const row = read()
    if (!row?.active || !row.principalId || row.principalId !== expectedPrincipalId) throw unavailable()
    principalId = row.principalId
  } catch {
    throw unavailable()
  }
  const check = (): void => {
    try {
      const row = read()
      if (!row?.active || row.principalId !== principalId) throw unavailable()
    } catch {
      throw unavailable()
    }
  }
  return Object.freeze({ sessionId, principalId, check })
}
