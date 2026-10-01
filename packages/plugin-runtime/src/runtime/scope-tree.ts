/** Longest-lived scope first. A lower rank must not close over a higher rank. */
export const RUNTIME_SCOPES = ['installation', 'runtime', 'workspace', 'session', 'run', 'action'] as const

export type RuntimeScope = (typeof RUNTIME_SCOPES)[number]

const RANK = new Map<string, number>(RUNTIME_SCOPES.map((scope, index) => [scope, index]))

export function isRuntimeScope(value: string): value is RuntimeScope {
  return RANK.has(value)
}

export function scopeRank(scope: RuntimeScope): number {
  const rank = RANK.get(scope)
  if (rank === undefined) throw new Error(`unknown scope: ${scope}`)
  return rank
}

/**
 * Instance capture of a shorter-lived scope would keep that scope's credentials
 * after the scope is gone. A factory or controlled handle is resolved on each call.
 */
export function longScopeCapturesShort(
  holder: RuntimeScope,
  captured: RuntimeScope,
  capture: 'instance' | 'factory',
): boolean {
  return capture === 'instance' && scopeRank(holder) < scopeRank(captured)
}
