import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'

export const refuse = (
  code: W.RuntimeError['code'],
  detailCode: string,
  retryAdvice: W.RuntimeError['retryAdvice'] = { kind: 'never' },
): Outcome<never> => ({
  ok: false,
  error: {
    code,
    detailCode,
    message: 'Reference supervisor refused',
    retryAdvice,
    diagnosticId: 'reference-supervisor',
  },
})
export const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as W.JsonValue) === canonicalJsonDigest(b as W.JsonValue)
export const shortDigest = (value: unknown) => canonicalJsonDigest(value as W.JsonValue).slice(0, 40)

export function placeOf(scope: W.ScopeRef): { sessionId: string; workspaceId: string } | null {
  switch (scope.kind) {
    case 'session':
    case 'run':
    case 'action':
      return { sessionId: scope.sessionId, workspaceId: scope.workspaceId }
    default:
      return null
  }
}
export const sessionOf = (scope: W.ScopeRef) => placeOf(scope)?.sessionId ?? null

/** Resolve with the work, a caller abort or the context deadline, whichever comes first; the context object
 * is never copied. */
export function until<T>(
  work: Promise<Outcome<T>>,
  context: CallContext,
  now: () => number = Date.now,
): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    const limit = Math.min(2_147_483_647, Math.max(0, Date.parse(context.deadline) - now()))
    const timer = setTimeout(() => resolve(refuse('timeout', 'supervisor_invocation_expired')), limit)
    const cancel = () => resolve(refuse('cancelled', 'cancelled'))
    if (context.signal.aborted) cancel()
    else context.signal.addEventListener('abort', cancel, { once: true })
    work
      .then(resolve, () => resolve(refuse('internal', 'supervisor_provider_exception')))
      .finally(() => {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', cancel)
      })
  })
}
