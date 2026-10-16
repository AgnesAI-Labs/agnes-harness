import { attachmentErrorCode } from '@agnes/protocol'

// `data.reason` is opaque transport input, not a display contract. Only exact, local business
// rejections get an actionable explanation; every other reason stays out of the terminal.
const ACTIONABLE_ERROR_REASONS: Readonly<Record<string, string>> = {
  'SEMANTIC_REJECTED:fork boundary must be a completed turn/end': 'Choose a completed turn/end sequence.',
}

// TURN_ERROR is daemon's envelope for a turn that ran and ended in `error`; the cause is that turn's
// own stable code (AUTH, RATE_LIMIT, ...). Its message stays out of the terminal like any reason.
const TURN_ERROR_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['AUTH', 'The provider refused this model or its credentials; pick another with /model or sign in again.'],
])

const stableCode = (raw: unknown): string =>
  typeof raw === 'string' || typeof raw === 'number'
    ? String(raw)
        .replace(/[^A-Za-z0-9_.-]/g, '')
        .slice(0, 64)
    : ''

/** Formats stable codes and only locally approved business rejection explanations. */
export function formatTuiErrorNotice(error?: unknown): string {
  try {
    if (error === null || typeof error !== 'object') return 'Request failed. Try again.'
    const attachment = attachmentErrorCode(error)
    if (attachment)
      return `Request failed (${attachment}). Select the original again or upload it in the current session.`
    const value = error as {
      code?: unknown
      data?: { code?: unknown; kind?: unknown; reason?: unknown; error?: { code?: unknown } }
    }
    const data = value.data
    const code = stableCode(data?.code ?? data?.kind ?? value.code)
    if (!code) return 'Request failed. Try again.'
    let reason: unknown
    try {
      if (code === 'TURN_ERROR' || code === 'CONFIG_CREDENTIAL_REJECTED') {
        const turnCode = code === 'CONFIG_CREDENTIAL_REJECTED' ? 'AUTH' : stableCode(data?.error?.code)
        if (turnCode) {
          const turnAction = TURN_ERROR_ACTIONS.get(turnCode)
          return turnAction ? `Request failed (${turnCode}): ${turnAction}` : `Request failed (${turnCode}).`
        }
      }
      reason = data?.reason
    } catch {
      return `Request failed (${code}).`
    }
    const action = typeof reason === 'string' ? ACTIONABLE_ERROR_REASONS[`${code}:${reason}`] : undefined
    if (action) return `Request failed (${code}): ${action}`
    return `Request failed (${code}).`
  } catch {
    // Getters and Proxies are untrusted presentation input.
    return 'Request failed. Try again.'
  }
}
