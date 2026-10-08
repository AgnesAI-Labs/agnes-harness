import { PackageError } from '@agnes/package-manager'
import { HostError } from '../errors.js'

function rethrow(error: unknown): never {
  if (error instanceof PackageError)
    throw new HostError(error.legacyCode, error.reason, {
      ...(error.source ? { source: error.source } : {}),
      ...(error.hasDetail ? { detail: { ...error.detail } } : {}),
    })
  throw error
}
/** Preserve both synchronous and asynchronous legacy refusal boundaries. */
export function compat<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      const value = fn(...args)
      return value instanceof Promise ? (value.catch(rethrow) as R) : value
    } catch (error) {
      return rethrow(error)
    }
  }
}
