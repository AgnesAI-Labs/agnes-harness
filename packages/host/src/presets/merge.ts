import type { PresetDoc } from './types.js'

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Scalar overrides, an array replaces the array under it, two maps merge key by key. */
export function mergeValue(base: unknown, over: unknown): unknown {
  if (over === undefined) return base
  if (Array.isArray(over)) return over
  if (isMap(base) && isMap(over)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = mergeValue(base[k], v)
    return out
  }
  return over
}

/**
 * `chain[0]` is the deepest base. `extends` is dropped rather than merged: the merged document is
 * the result of walking the chain, so carrying the link that produced it would make a second walk
 * of the same document walk the chain again.
 */
export function mergePresets(chain: PresetDoc[]): PresetDoc {
  let acc: Record<string, unknown> = {}
  for (const doc of chain) {
    const { extends: _link, ...rest } = doc
    acc = mergeValue(acc, rest) as Record<string, unknown>
  }
  return acc as PresetDoc
}
