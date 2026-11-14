import type { JsonValue } from '@agnes/protocol'
import type { Preparation } from '../preparation.js'

function credentialKey(key: string): boolean {
  return (
    /^secret:\/\//i.test(key) ||
    /(?:^|[_-])(?:password|passwd|token|secret|api[_-]?key|authorization|key)$/i.test(
      key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'),
    )
  )
}
export async function maskCredentialValues(value: JsonValue, scope: Preparation): Promise<JsonValue> {
  const waiting = scope.step()
  if (waiting) await waiting
  if (Array.isArray(value)) {
    const out: JsonValue[] = []
    for (const child of value) out.push(await maskCredentialValues(child, scope))
    return out
  }
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = Object.create(null)
    for (const [key, child] of Object.entries(value)) {
      const waiting = scope.step()
      if (waiting) await waiting
      out[key] = credentialKey(key) ? '[REDACTED]' : await maskCredentialValues(child, scope)
    }
    return out
  }
  return value
}
