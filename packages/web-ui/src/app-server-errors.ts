import { publicErrorHelp, publicErrorMessageKey } from '@agnes/protocol'

/** Render only schema-owned copy, never exception messages or server-provided prose. */
export function appServerErrorMessage(value: unknown, locale: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const help = publicErrorHelp(value, locale)
  if (help) return `${help.reason} ${help.action}`
  const data = (value as { data?: { messageKey?: unknown } }).data
  return publicErrorMessageKey(data?.messageKey, locale)
}
