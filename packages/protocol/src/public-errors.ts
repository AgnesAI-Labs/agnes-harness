import { PUBLIC_ERROR_CONTRACT, PUBLIC_ERROR_MESSAGES } from '../gen/ts/public-errors.js'
import { rpcError } from './errors.js'

type LocalizedCopy = Readonly<Record<'en' | 'zh-CN', Readonly<{ reason: string; action: string }>>>
type Contract = Readonly<{
  rpc: import('./errors.js').AgnesErrorName
  messageKey: import('../gen/ts/app-server.js').AppServerError['data']['messageKey']
  boot: boolean
  skillInstall: boolean
  localized: LocalizedCopy
  reasons: Readonly<Record<string, LocalizedCopy>>
}>

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_CONTRACT
export type PublicErrorHelp = Readonly<{ code: PublicErrorCode; reason: string; action: string }>

export function publicErrorContract(code: unknown): Contract | undefined {
  return typeof code === 'string' && Object.hasOwn(PUBLIC_ERROR_CONTRACT, code)
    ? PUBLIC_ERROR_CONTRACT[code as PublicErrorCode]
    : undefined
}

/** Exact schema-owned identifiers only; never classify unknown codes by their spelling. */
export function publicErrorCode(error: unknown): PublicErrorCode | undefined {
  try {
    if (!error || typeof error !== 'object') return undefined
    const value = error as {
      code?: unknown
      data?: { code?: unknown; reason?: unknown; cause?: { code?: unknown }; error?: { code?: unknown } }
    }
    // A raw domain code is authoritative. An unknown code cannot borrow a known nested reason.
    const domainCode = value.code
    if (typeof domainCode === 'string')
      return publicErrorContract(domainCode) ? (domainCode as PublicErrorCode) : undefined
    const data = value.data
    const code = data?.code
    if (typeof code !== 'string' || (code !== 'TURN_ERROR' && !publicErrorContract(code))) return undefined
    const suppliedCause = data?.cause
    if (suppliedCause) {
      const causeCode = suppliedCause.code
      return publicErrorContract(causeCode) ? (causeCode as PublicErrorCode) : undefined
    }
    if (code === 'TURN_ERROR') {
      const turnCode = data?.error?.code
      return publicErrorContract(turnCode) ? (turnCode as PublicErrorCode) : undefined
    }
    // Legacy RPC categories carry a more specific public code in reason.
    if (publicErrorContract(code)?.rpc === code) {
      try {
        const reasonCode = data?.reason
        if (publicErrorContract(reasonCode)) return reasonCode as PublicErrorCode
      } catch {
        /* An unreadable optional reason must not hide a known envelope code. */
      }
    }
    return code as PublicErrorCode
  } catch {
    return undefined
  }
}

export function publicErrorHelp(error: unknown, locale = 'en'): PublicErrorHelp | undefined {
  const code = publicErrorCode(error)
  const contract = publicErrorContract(code)
  if (!code || !contract) return undefined
  return {
    code,
    ...publicErrorCopy(code, publicErrorReason(error))[
      locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
    ],
  }
}

/** Only reason identifiers explicitly declared for this code are public. */
export function publicErrorReason(error: unknown): string | undefined {
  try {
    const code = publicErrorCode(error)
    const value = error as {
      reason?: unknown
      data?: { reason?: unknown }
      detail?: { reason?: unknown }
    } | null
    const reason = value?.data?.reason ?? value?.detail?.reason ?? value?.reason
    const reasons = publicErrorContract(code)?.reasons
    return typeof reason === 'string' && reasons && Object.hasOwn(reasons, reason) ? reason : undefined
  } catch {
    return undefined
  }
}

export function publicErrorCopy(code: unknown, reason?: string): LocalizedCopy {
  const contract: Contract = publicErrorContract(code) ?? PUBLIC_ERROR_CONTRACT.INTERNAL_ERROR
  const declared = reason && Object.hasOwn(contract.reasons, reason) ? contract.reasons[reason] : undefined
  return declared ?? contract.localized
}

/** Convert domain failures through the existing RPC model, dropping every private property. */
export function publicRejectionRpc(error: unknown) {
  const code = publicErrorCode(error)
  const contract = publicErrorContract(code)
  const reason = publicErrorReason(error)
  return code && contract ? rpcError(contract.rpc, { code, ...(reason ? { reason } : {}) }) : undefined
}

/** Localized fallback for older envelopes that contain only a public message key. */
export function publicErrorMessageKey(key: unknown, locale = 'en'): string | undefined {
  if (typeof key !== 'string' || !Object.hasOwn(PUBLIC_ERROR_MESSAGES, key)) return undefined
  const copy =
    PUBLIC_ERROR_MESSAGES[key as keyof typeof PUBLIC_ERROR_MESSAGES][
      locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
    ]
  return `${copy.reason} ${copy.action}`
}
