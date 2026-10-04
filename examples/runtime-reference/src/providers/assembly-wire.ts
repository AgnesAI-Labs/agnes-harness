import { type RuntimeWireTypes, type ValidationResult, validateRuntime } from '@agnes/protocol/runtime'

// Shared only inside this independent implementation. Caller objects never become cache keys.
const captures = new WeakSet<object>()
const decoded = new WeakMap<object, Map<keyof RuntimeWireTypes, unknown>>()
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || captures.has(value)) return
  Object.values(value).forEach(freeze)
  Object.freeze(value)
  captures.add(value)
}
export function readReferenceAssemblyWire<K extends keyof RuntimeWireTypes>(
  name: K,
  raw: unknown,
): ValidationResult<RuntimeWireTypes[K]> {
  if (raw !== null && typeof raw === 'object') {
    const value = decoded.get(raw)?.get(name)
    if (value !== undefined) return { ok: true, value: value as RuntimeWireTypes[K] }
  }
  return validateRuntime(name, raw)
}
export function captureReferenceAssemblyWire<K extends keyof RuntimeWireTypes>(
  name: K,
  raw: unknown,
): ValidationResult<RuntimeWireTypes[K]> {
  const result = readReferenceAssemblyWire(name, raw)
  if (!result.ok || result.value === null || typeof result.value !== 'object') return result
  freeze(result.value)
  for (const key of [result.value, captures.has(raw as object) ? raw : null]) {
    if (key !== null && typeof key === 'object') {
      const schemas = decoded.get(key) ?? new Map<keyof RuntimeWireTypes, unknown>()
      schemas.set(name, result.value)
      decoded.set(key, schemas)
    }
  }
  return result
}
