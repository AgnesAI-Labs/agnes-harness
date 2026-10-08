import { CoreError } from '@agnes/core-common/types'
import type { ChildAgentAllowlist, ChildAgentAllowlistConfig } from '@agnes/extension-api'

const sessions = new Map<string, ChildAgentAllowlist>()
let fallback: ChildAgentAllowlist | undefined

function copyList(value: readonly string[], label: string): readonly string[] {
  if (value.some((item) => typeof item !== 'string' || item.length === 0))
    throw new CoreError('E_ENVELOPE', `${label} must be an array of non-empty strings`)
  return Object.freeze([...value])
}

export function normalizeChildAgentAllowlist(value: ChildAgentAllowlist): ChildAgentAllowlist {
  const allowlist: { models?: readonly string[]; providers?: readonly string[] } = {}
  if (value.models !== undefined) allowlist.models = copyList(value.models, 'allow.models')
  if (value.providers !== undefined) allowlist.providers = copyList(value.providers, 'allow.providers')
  return Object.freeze(allowlist)
}

/** Replace the deployment default and any named session lists. Other session overrides stay. */
export function applyChildAgentConfig(config: ChildAgentAllowlistConfig | undefined): void {
  if (!config) return
  if (config.allow) fallback = normalizeChildAgentAllowlist(config.allow)
  for (const [sessionKey, allowlist] of Object.entries(config.sessions ?? {}))
    sessions.set(sessionKey, normalizeChildAgentAllowlist(allowlist))
}

/** `undefined` clears the session override so the deployment default applies again. */
export function setChildAgentAllowlist(sessionKey: string, allowlist: ChildAgentAllowlist | undefined): void {
  if (!sessionKey) throw new CoreError('E_ENVELOPE', 'session key is required')
  if (allowlist === undefined) sessions.delete(sessionKey)
  else sessions.set(sessionKey, normalizeChildAgentAllowlist(allowlist))
}

export function childAgentAllowlist(sessionKey: string): ChildAgentAllowlist | undefined {
  return sessions.get(sessionKey) ?? fallback
}

export function resetChildAgentAllowlists(): void {
  sessions.clear()
  fallback = undefined
}

/**
 * Refuse a start the session's allowlist does not name.
 * A set model list also requires the caller to name the model, so an inherited model cannot bypass it.
 */
export function assertChildAgentAllowed(
  sessionKey: string,
  request: { providerId?: string; model?: string },
): void {
  const refusal = childAgentRefusal(childAgentAllowlist(sessionKey), request)
  if (refusal) throw new CoreError(refusal.code, refusal.message, refusal.detail)
}

/** Pure authorization rule, also used by Host capability resolution. */
export function childAgentRefusal(
  allowlist: ChildAgentAllowlist | undefined,
  request: { providerId?: string; model?: string },
):
  | { code: 'E_UNSUPPORTED' | 'E_MODEL_UNKNOWN'; message: string; detail?: Record<string, unknown> }
  | undefined {
  if (
    request.providerId !== undefined &&
    allowlist?.providers &&
    !allowlist.providers.includes(request.providerId)
  )
    return {
      code: 'E_UNSUPPORTED',
      message: `child provider ${request.providerId} is not allowed for this session`,
      detail: { providerId: request.providerId },
    }
  if (allowlist?.models) {
    if (!request.model)
      return {
        code: 'E_MODEL_UNKNOWN',
        message: 'child model must be named when a session model allowlist is set',
      }
    if (!allowlist.models.includes(request.model))
      return {
        code: 'E_MODEL_UNKNOWN',
        message: `child model ${request.model} is not allowed for this session`,
        detail: { model: request.model },
      }
  }
}
