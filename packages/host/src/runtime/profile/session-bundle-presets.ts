import { HostError } from '@agnes/host-common/errors'
import { mergeValue } from '@agnes/host-common/presets/merge'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { type BundleCatalog, sessionBundlePresets } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'

/**
 * A bundle states its policy in its presets. Selecting it for one session pins those presets into
 * this session's profile only: the deployment profile and its allowed list stay as they were, and
 * no restart is involved.
 */
export function admitSessionBundlePresets<P extends ResolvedProfile>(
  admission: P,
  host: { presets: Record<string, PresetDoc> },
  input: { preset?: string; bundles?: readonly string[] },
): {
  /** The session's own profile, carrying the bundle presets it may use. */
  profile: P
  /** What the composition compiler reads from that profile beside the deployment's own fields. */
  scope: { bundleCatalog: BundleCatalog; presets: ResolvedProfile['presets'] }
  preset: PresetDoc
} {
  const offered = input.bundles?.length
    ? sessionBundlePresets(input.bundles, admission.bundleCatalog ?? {})
    : {}
  const names = Object.keys(offered)
  const merged = (base: Record<string, PresetDoc> | undefined) => ({
    ...base,
    ...Object.fromEntries(names.map((name) => [name, mergeValue(base?.[name], offered[name]) as PresetDoc])),
  })
  const profile = names.length
    ? {
        ...admission,
        bundlePresets: merged(admission.bundlePresets),
        presets: {
          ...admission.presets,
          allowed: [...new Set([...admission.presets.allowed, ...names])],
        },
      }
    : admission
  // One offered preset is the bundle's own choice; several need the caller to name one.
  const preset = input.preset ?? (names.length === 1 ? (names[0] as string) : admission.presets.default)
  if (!profile.presets.allowed.includes(preset))
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${preset} is not in presets.allowed`, {
      detail: { reason: 'preset-not-allowed', preset },
    })
  return {
    profile,
    scope: { bundleCatalog: profile.bundleCatalog ?? {}, presets: profile.presets },
    preset: resolvePreset(preset, merged(host.presets), { limits: admission.limits }).doc,
  }
}
