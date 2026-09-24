import type { Client } from './client.js'
import { ClaimDenied } from './errors.js'

export type Claim = {
  once(kind: string, value: string, expiresAtMs?: number): Promise<boolean>
  withinRateLimit(kind: string, value: string, limit: number, windowMs: number): Promise<boolean>
}

export function makeClaim(client: Client, strict: boolean): Claim {
  const run = async (params: Record<string, unknown>): Promise<boolean> => {
    try {
      const result = await client.call<{ granted: boolean; slot?: number }>('_agnes/v1/auth.claim', params, {
        timeoutMs: client.timeouts.claim,
      })
      if (result.granted === true) return true
      if (strict) throw new ClaimDenied('not granted')
    } catch (error) {
      if (error instanceof ClaimDenied) throw error
      if (strict) throw new ClaimDenied(error instanceof Error ? error.message : String(error))
    }
    return false
  }
  return {
    once: (kind, value, expiresAtMs) =>
      run({ kind, value, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) }),
    withinRateLimit: (kind, value, limit, windowMs) => run({ kind, value, limit, windowMs }),
  }
}
