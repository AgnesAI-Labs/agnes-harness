import type { LeaseView } from '@agnes/extension-api'

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** null is the private wire representation of Host's unbounded numeric lease budget. */
export function runnerLease(value: unknown): LeaseView {
  if (!record(value) || typeof value.expiresAt !== 'string' || !record(value.scope) || !record(value.budget))
    throw new Error('invalid lease snapshot')
  const remaining = value.budget.remaining === null ? Infinity : value.budget.remaining
  if (
    typeof remaining !== 'number' ||
    remaining < 0 ||
    (remaining !== Infinity && !Number.isSafeInteger(remaining))
  )
    throw new Error('invalid lease budget')
  return Object.freeze({
    expiresAt: value.expiresAt,
    scope: Object.freeze(value.scope),
    budget: Object.freeze({ remaining }),
  })
}
