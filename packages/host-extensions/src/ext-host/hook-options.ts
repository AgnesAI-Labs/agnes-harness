import type { HookEvent, HookRegisterOptions, Logger } from '@agnes/extension-api'
import type { HostCapabilityGrant } from '@agnes/package-manager'

export const HOOK_TIMEOUT_EVENTS = ['turn_stopping', 'tool_result'] as const

/** Author options never become Core metadata without a distribution-owned grant. */
export function hookTimeout(
  event: HookEvent,
  options: HookRegisterOptions | undefined,
  grant: HostCapabilityGrant | undefined,
  log: Logger,
): number | undefined {
  const request = options?.timeoutMs
  if (request === undefined) return undefined
  const limit = grant?.hookTimeoutMs
  if (
    limit !== undefined &&
    Number.isFinite(limit) &&
    limit > 0 &&
    Number.isFinite(request) &&
    request > 0 &&
    HOOK_TIMEOUT_EVENTS.some((allowed) => allowed === event)
  )
    return Math.min(request, limit, 15000)
  try {
    log.warn('hook-timeout-ignored', { event })
  } catch {
    /* advisory */
  }
  return undefined
}
