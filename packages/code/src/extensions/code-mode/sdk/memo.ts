import { createHash } from 'node:crypto'
import type { RegistrySnapshot } from '@agnes/core'
import { renderPython, type SkipReason } from './render-python.js'

// Private cache encoding: arrays keep order, JSON object keys use code-unit order.
function canonical(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`
}
export function snapshotKey(snapshot: RegistrySnapshot): string {
  const entries = snapshot.defs
    .filter((t) => t.name !== 'run_code' && !t.meta.deferLoading)
    .map((t) => [t.name, t.parameters] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(canonical(entries)).digest('hex')
}
export type SdkRenderer = {
  render(snapshot: RegistrySnapshot): string
  stats(): { hits: number; misses: number; size: number }
}
export function createSdkRenderer(deps: {
  onSkip?(name: string, reason: SkipReason): void
  max?: number
}): SdkRenderer {
  const max = deps.max ?? 32
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error('SDK cache max must be a positive safe integer')
  const cache = new Map<string, string>()
  let hits = 0,
    misses = 0
  return {
    render(snapshot) {
      const key = snapshotKey(snapshot),
        cached = cache.get(key)
      if (cached !== undefined) {
        hits++
        cache.delete(key)
        cache.set(key, cached)
        return cached
      }
      misses++
      const text = renderPython(snapshot, deps.onSkip ? { onSkip: deps.onSkip } : {})
      cache.set(key, text)
      if (cache.size > max) cache.delete(cache.keys().next().value as string)
      return text
    },
    stats: () => ({ hits, misses, size: cache.size }),
  }
}
