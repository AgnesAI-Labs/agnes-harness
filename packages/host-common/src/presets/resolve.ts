import type { PresetView } from '@agnes/core'
import { validatePreset } from '@agnes/protocol'
import { HostError } from '../errors.js'
import { canonicalJson, sha256hex } from '../profile/canonical.js'
import { mergePresets, mergeValue } from './merge.js'
import {
  assertRecipeName,
  DEFAULT_PERMISSION,
  declaresPermissionFields,
  OVERLAY_PREFIX,
  overlayName,
  overlayViolations,
  type Permission,
} from './permission.js'
import { presetProvider } from './provider.js'
import type { PresetDoc } from './types.js'
import { toPresetView } from './view.js'

/** `permission` is absent only for a recipe that fixes its own (a frozen baseline, a third-party table). */
export type ResolvedPreset = {
  doc: PresetDoc
  view: PresetView
  chain: string[]
  hash: string
  permission?: Permission
}

const refuse = (message: string, detail: Record<string, unknown>): never => {
  throw new HostError('E_PRESET_UNSUPPORTED', message, { detail: { ...detail, reason: 'permission-axis' } })
}

/**
 * Merges the permission overlay after the recipe. The overlay only writes permission-axis fields, so
 * `sandbox.required` and `approval.on_unavailable` stay with the recipe: required isolation is never
 * lowered by a permission, and a permission that needs no isolation cannot satisfy a recipe that does.
 */
function applyPermission(
  name: string,
  merged: PresetDoc,
  chain: PresetDoc[],
  docs: Record<string, PresetDoc>,
  requested: Permission | undefined,
  carry: Permission | undefined,
): { doc: PresetDoc; permission?: Permission } {
  // A recipe that writes permission-axis fields itself is already complete. Its own table is kept
  // as written; asking it for another level would either be ignored or replace a stricter table.
  // A tool policy provider counts too, unless it is the one the catalogue gives every document: a
  // profile that selects a policy provider writes it into each recipe and each overlay alike, and
  // that is a deployment choice, not a recipe naming its own.
  const shared = presetProvider(docs[overlayName(DEFAULT_PERMISSION)] ?? { name: '' }, 'tool-policy')
  const ownPolicy = (doc: PresetDoc): boolean => {
    const provider = presetProvider(doc, 'tool-policy')
    return provider !== undefined && provider !== shared
  }
  if (chain.some((doc) => doc.name !== 'base' && (declaresPermissionFields(doc) || ownPolicy(doc)))) {
    if (requested)
      refuse(`preset ${name} carries its own permission settings and cannot take ${requested}`, {
        source: name,
        capability: 'permission',
        requested,
      })
    return { doc: merged }
  }
  // `carry` is the level a running session already has: it applies to a recipe that takes one and is
  // ignored by a recipe that fixes its own, so switching between such recipes is still decided by the
  // sandbox comparison and not by this function.
  const permission = requested ?? carry ?? DEFAULT_PERMISSION
  const overlay = docs[overlayName(permission)]
  // A catalogue that ships no overlays runs
  // the recipe as written under the default level, which only ever asks more than the overlay would.
  // Any other level needs its overlay: there is nothing to apply and silently running without it
  // would grant a different permission from the one asked for.
  if (!overlay && permission === DEFAULT_PERMISSION) return { doc: merged }
  if (!overlay) return refuse(`permission ${permission} is not provided by any package`, { source: name })
  const bad = overlayViolations(overlay)
  if (bad.length)
    return refuse(`permission ${permission} writes fields outside the permission axis: ${bad.join(', ')}`, {
      source: name,
      fields: bad,
    })
  const { name: _overlayName, ...fields } = overlay
  const doc = mergeValue(merged, fields) as PresetDoc
  const sandbox = doc.sandbox as { level?: string; required?: boolean } | undefined
  if (sandbox?.required === true && sandbox.level === 'L0')
    return refuse(`preset ${name} requires sandbox isolation, which ${permission} does not provide`, {
      source: name,
      permission,
      rule: 'required-sandbox-needs-isolation',
    })
  return { doc, permission }
}

/**
 * Walks `extends` to the deepest base, merges downwards, applies the permission overlay and hashes
 * what came out.
 */
export function resolvePreset(
  name: string,
  docs: Record<string, PresetDoc>,
  opts: { limits?: Record<string, number>; park?: unknown; permission?: Permission; carry?: Permission } = {},
): ResolvedPreset {
  assertRecipeName(name)
  if (name.startsWith(OVERLAY_PREFIX))
    refuse(`${name} is a permission overlay, not a preset`, { source: name, capability: 'preset' })
  const chain: PresetDoc[] = []
  const seen = new Set<string>()
  let cur: string | undefined = name
  while (cur) {
    assertRecipeName(cur)
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
  const { doc: layered, permission } = applyPermission(
    name,
    mergePresets(chain),
    chain,
    docs,
    opts.permission,
    opts.carry,
  )
  const merged = layered
  // The requested name, not the deepest base's: mergePresets copies `name` down the chain like any
  // other scalar, so the merged document already carries it, but a chain whose leaf omitted `name`
  // would otherwise resolve under its parent's name.
  merged.name = name
  // toPresetView validates the full merged document through protocol before applying defaults.
  // Hash the original merged spelling, not its legacy-route/alias validation projection.
  const view = toPresetView(merged, opts)
  return {
    doc: merged,
    view: permission ? { ...view, permission } : view,
    chain: chain.map((d) => String(d.name)),
    hash: `sha256-${sha256hex(canonicalJson(merged))}`,
    ...(permission ? { permission } : {}),
  }
}
