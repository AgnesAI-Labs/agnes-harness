import type { PresetView } from '@agnes/core'
import { validatePreset } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { canonicalJson, sha256hex } from '../profile/canonical.js'
import { mergePresets } from './merge.js'
import type { PresetDoc } from './types.js'
import { toPresetView } from './view.js'

export type ResolvedPreset = { doc: PresetDoc; view: PresetView; chain: string[]; hash: string }

/** Walks `extends` to the deepest base, merges downwards, and hashes what came out. */
export function resolvePreset(
  name: string,
  docs: Record<string, PresetDoc>,
  opts: { limits?: Record<string, number>; park?: unknown } = {},
): ResolvedPreset {
  const chain: PresetDoc[] = []
  const seen = new Set<string>()
  let cur: string | undefined = name
  while (cur) {
    if (seen.has(cur))
      throw new HostError('E_PROFILE_CYCLE', `preset extends cycle at ${cur}`, {
        detail: { chain: [...seen], preset: cur },
      })
    seen.add(cur)
    const doc: PresetDoc | undefined = docs[cur]
    if (!doc)
      throw new HostError('E_PRESET_UNSUPPORTED', `preset ${cur} not provided by any package`, {
        detail: { capability: `preset:${cur}`, source: name },
      })
    // Inheritance links disappear during merge, so validate their grammar before walking them.
    if (
      doc.extends !== undefined &&
      !validatePreset({ name: 'inheritance-link', extends: doc.extends }).ok &&
      doc.extends !== 'minimal-rl'
    )
      throw new HostError('E_PRESET_UNSUPPORTED', `preset ${cur} has an invalid extends link`, {
        detail: { source: name, path: 'extends' },
      })
    if (cur === 'minimal-rl' && doc.extends !== undefined)
      throw new HostError('E_PRESET_UNSUPPORTED', 'minimal-rl must not extend another preset', {
        detail: { rule: 'minimal-rl-standalone', source: name },
      })
    // minimal-rl is the frozen reinforcement-learning baseline: a preset that extended it would
    // change what that baseline measures while still being called by its name.
    if (doc.extends === 'minimal-rl')
      throw new HostError('E_PRESET_UNSUPPORTED', `${cur} extends minimal-rl (frozen baseline)`, {
        detail: { rule: 'minimal-rl-not-extendable', preset: cur, source: name },
      })
    chain.unshift(doc)
    cur = doc.extends
  }
  const merged = mergePresets(chain)
  // The requested name, not the deepest base's: mergePresets copies `name` down the chain like any
  // other scalar, so the merged document already carries it, but a chain whose leaf omitted `name`
  // would otherwise resolve under its parent's name.
  merged.name = name
  // toPresetView validates the full merged document through protocol before applying defaults.
  // Hash the original merged spelling, not its legacy-route/alias validation projection.
  return {
    doc: merged,
    view: toPresetView(merged, opts),
    chain: chain.map((d) => String(d.name)),
    hash: `sha256-${sha256hex(canonicalJson(merged))}`,
  }
}
