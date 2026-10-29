import type { RpcError } from './errors.js'
import {
  type PermissionContext,
  type PermissionEffectAdmission,
  samePermissionContext,
} from './permission-decision.js'

/** Backend-only proof carrier. Business owners retain object/version and consumption checks.
 * verify may yield; assertActive must run again inside the final synchronous commit/CAS.
 * A failed check permanently seals this handle, including failures of its parent or verifier.
 * A lease can cover several commits of one operation; durable owners enforce replay/idempotency.
 */
export function permissionEffectAdmission(options: {
  parent?: PermissionEffectAdmission | undefined
  signals?: readonly (AbortSignal | undefined)[]
  expiresAt?: number
  clock?: () => number
  context?: { expected: PermissionContext; current(): PermissionContext | undefined }
  assertBound?(): void
  verify?(): Promise<void>
  unavailable(): Error | RpcError
}): PermissionEffectAdmission {
  const { parent, expiresAt, clock = () => Date.now(), assertBound, verify, unavailable } = options
  const signals = [...(options.signals ?? [])]
  const context = options.context && {
    expected: structuredClone(options.context.expected),
    current: options.context.current,
  }
  let failed = false
  let failure: unknown
  const seal = (error: unknown): never => {
    failed = true
    failure = error
    throw error
  }
  const assertActive = () => {
    if (failed) throw failure
    try {
      parent?.assertActive()
      assertBound?.()
      if (
        signals.some((signal) => signal?.aborted) ||
        (expiresAt !== undefined && (!Number.isFinite(expiresAt) || clock() >= expiresAt)) ||
        (context && !samePermissionContext(context.expected, context.current()))
      )
        throw unavailable()
    } catch (error) {
      seal(error)
    }
  }
  return Object.freeze({
    assertActive,
    verify: async () => {
      assertActive()
      try {
        if (parent) await parent.verify()
        if (verify) await verify()
        assertActive()
      } catch (error) {
        seal(error)
      }
    },
  })
}
