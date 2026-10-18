/** Only closed codes cross the BFF. Exception text, stacks and arbitrary RPC data stay private. */
export function launchFailure(error: unknown): { status: number; code: string } {
  const value = error as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null
  const allowed: Record<string, number> = {
    CAPABILITY_DENIED: 403,
    AUTH_INVALID: 403,
    E_PACKAGE_PREVIEW_STALE: 409,
    E_PACKAGE_BLOCKED: 409,
    E_PACKAGE_STATE: 409,
    E_PACKAGE_BUSY: 409,
    E_PACKAGE_INTEGRITY: 409,
    E_PRESET_UNSUPPORTED: 409,
    E_PRESET_UNRESOLVED: 409,
    E_MODEL_UNSUPPORTED: 409,
    PRESET_SWITCH_REJECTED: 409,
    OUTCOME_UNKNOWN: 409,
    INVALID_REQUEST: 409,
    INVALID_PARAMS: 400,
    OVERLOADED: 409,
    REQUEST_TIMEOUT: 504,
  }
  for (const code of [value?.data?.code, value?.code, value?.message])
    if (typeof code === 'string' && Object.hasOwn(allowed, code)) return { code, status: allowed[code]! }
  return { status: 500, code: 'INTERNAL_ERROR' }
}
