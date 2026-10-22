import { publicErrorContract, publicErrorHelp, publicErrorMessageKey } from '@agnes/protocol'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Render only schema-owned copy, never exception messages or server-provided prose. */
export function appServerErrorMessage(value: unknown, locale: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = (value as { data?: { messageKey?: unknown; diagnosticId?: unknown } }).data
  const help = publicErrorHelp(value, locale)
  const text = help ? `${help.reason} ${help.action}` : publicErrorMessageKey(data?.messageKey, locale)
  // The internal copy tells the person to use the diagnostic ID, so the ID must be on screen.
  const internal = help
    ? publicErrorContract(help.code)?.rpc === 'INTERNAL_ERROR'
    : data?.messageKey === 'appServer.errors.internal'
  const id = data?.diagnosticId
  if (!text || !internal || typeof id !== 'string' || !UUID.test(id)) return text
  return `${text} ${locale.toLowerCase().startsWith('zh') ? '诊断 ID：' : 'Diagnostic ID: '}${id}`
}
