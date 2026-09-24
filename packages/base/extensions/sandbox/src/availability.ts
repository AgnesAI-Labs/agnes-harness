export type BackendAvailabilityInput = Readonly<{
  available: boolean
  required?: unknown
  onUnavailable?: unknown
}>

export type BackendAvailabilityDecision =
  | Readonly<{ action: 'use-backend' }>
  | Readonly<{ action: 'allow-unconfined' }>
  | Readonly<{
      action: 'refuse-init'
      code: 'E_SEAM_INIT'
      reason: 'required-unavailable' | 'invalid-config'
    }>
  | Readonly<{
      action: 'deny-operation'
      code: 'SANDBOX_UNAVAILABLE'
      reason: 'backend-unavailable'
    }>

/**
 * Pure availability decision only. It neither probes a backend nor enforces the returned action.
 * Callers must apply it at the real HostExec/confine boundary before claiming enforcement.
 */
export function decideBackendAvailability(input: BackendAvailabilityInput): BackendAvailabilityDecision {
  if (
    typeof input.available !== 'boolean' ||
    (input.required !== undefined && typeof input.required !== 'boolean')
  )
    return Object.freeze({ action: 'refuse-init', code: 'E_SEAM_INIT', reason: 'invalid-config' })
  if (input.available) return Object.freeze({ action: 'use-backend' })
  if (input.required)
    return Object.freeze({
      action: 'refuse-init',
      code: 'E_SEAM_INIT',
      reason: 'required-unavailable',
    })
  if (input.onUnavailable === 'allow') return Object.freeze({ action: 'allow-unconfined' })
  return Object.freeze({
    action: 'deny-operation',
    code: 'SANDBOX_UNAVAILABLE',
    reason: 'backend-unavailable',
  })
}
