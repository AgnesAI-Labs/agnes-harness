import { HostError } from '@agnes/host-common/errors'
import { mergeValue } from '@agnes/host-common/presets/merge'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { PackageModule } from '@agnes/host-extensions/assemble/packages'
import { applyProviderPreset } from '@agnes/host-providers/assemble/provider-selection'
import { applyTelemetryConsent, readProfileTelemetryConsent } from '../sessions/session-hooks.js'
import { type AssemblyContext, duplicateContribution } from './context.js'
import type { PackageSet } from './packages.js'

/** Rebuild the pure preset catalogue from the exact package modules selected for this Host generation. */
function collectPresets(
  modules: ReadonlyMap<string, PackageModule>,
  profileConsent: ReturnType<typeof readProfileTelemetryConsent>,
  profile: ResolvedProfile,
): Record<string, PresetDoc> {
  const presets: Record<string, PresetDoc> = {}
  for (const module of modules.values())
    for (const [name, document] of Object.entries(module.presets ?? {}))
      presets[name] =
        name in presets
          ? duplicateContribution(module.id, 'preset', name)
          : applyTelemetryConsent(document, profileConsent)
  for (const [name, doc] of Object.entries(profile.bundlePresets ?? {}))
    presets[name] = applyTelemetryConsent(mergeValue(presets[name], doc) as PresetDoc, profileConsent)
  return presets
}

/** Preserve the startup preset contract on every runtime snapshot reconciliation. */
function validatePresetCatalog(
  profile: ResolvedProfile,
  presets: Record<string, PresetDoc>,
): ReturnType<typeof resolvePreset> {
  for (const name of profile.presets.allowed)
    if (!presets[name]) {
      throw new HostError('E_PRESET_UNSUPPORTED', `no package provides preset ${name}`, {
        detail: { capability: 'preset', source: name },
      })
    }
  return resolvePreset(profile.presets.default, presets, { limits: profile.limits })
}

/** The preset catalogue and the default preset resolved from it. */
export type PresetCatalog = Readonly<{
  presets: Record<string, PresetDoc>
  defaultPreset: ReturnType<typeof resolvePreset>
  profileConsent: ReturnType<typeof readProfileTelemetryConsent>
}>

/**
 * Step `presets` - resolved before the seams, because SeamInitContext.profile.preset carries the
 * merged document and the provider needs the route table read off the view.
 * Two packages providing a preset of the same name are a refusal, not "whichever the profile listed last".
 */
export function resolvePresetCatalog(ctx: AssemblyContext, pkgs: PackageSet): PresetCatalog {
  const profileConsent = readProfileTelemetryConsent(ctx.deps.profileDir)
  const presets = Object.fromEntries(
    Object.entries(collectPresets(pkgs.modules, profileConsent, ctx.profile)).map(([name, doc]) => [
      name,
      applyProviderPreset(doc, ctx.providerSelections),
    ]),
  )
  return { presets, defaultPreset: validatePresetCatalog(ctx.profile, presets), profileConsent }
}
