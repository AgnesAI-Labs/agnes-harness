/**
 * Truncates to at most `max` UTF-16 code units, the unit the published schemas count `maxLength` in.
 * The cut never ends on a high surrogate, so a surrogate pair is dropped whole rather than split.
 */
export function clipUtf16(value: string, max: number): string {
  if (value.length <= max) return value
  const last = value.charCodeAt(max - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}
