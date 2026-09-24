/**
 * A deliberately small, data-only repair pass for common Python-shaped JSON. It never evaluates
 * input: after mechanical replacements the result still has to pass JSON.parse.
 */
export function parseLenient(text: string): Record<string, unknown> | null {
  let repaired = text.replace(
    /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    (_match, value: string) => `"${value.replace(/"/g, '\\"')}"`,
  )
  repaired = repaired
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/,\s*([}\]])/g, '$1')
  try {
    const value: unknown = JSON.parse(repaired)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
