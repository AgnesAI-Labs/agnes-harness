import type { PresetView } from '@agnes/core'
import type { ProviderCatalogEntry, ProviderSelection } from '@agnes/extension-api'
import { SEAM_KINDS, type SeamKind } from '@agnes/extension-api/seams'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import {
  PROVIDER_KINDS,
  type ProviderKindName,
  type ProviderSelections,
  readModelAdapterSelection,
  readProviderSelection,
} from '@agnes/host-common/profile/provider-selection'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'

export {
  PROVIDER_KINDS,
  type ProviderKindName,
  type ProviderSelections,
  readProviderSelection,
} from '@agnes/host-common/profile/provider-selection'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * The selections in force for the kinds that are not seams: the profile's `providers` table,
 * overridden per kind by a composition layer (bundle, admin or session) that chose one.
 */
export function readProviderSelections(
  profile: Pick<ResolvedProfile, 'packages'> & object,
): ProviderSelections {
  const selected: ProviderSelections = {}
  const top = profile as Record<string, unknown>
  const table = record(top.providers)
  const composition = record(record(top.composition)?.providers)
  const sources = record(top.compositionSources)
  const composed = (kind: string) => {
    const source = record(sources?.[kind === 'model-adapter' ? 'modelAdapters' : kind])
    return source?.layer === 'default' ? undefined : composition?.[kind]
  }
  const composedAdapters = readModelAdapterSelection(composed('model-adapter'))
  const adapterChoice =
    (Array.isArray(composedAdapters?.provider) && composedAdapters.provider.length === 0
      ? undefined
      : composedAdapters) ?? readModelAdapterSelection(table?.['model-adapter'])
  if (adapterChoice) selected['model-adapter'] = adapterChoice
  for (const kind of PROVIDER_KINDS) {
    if (kind === 'model-adapter') continue
    if (kind === 'compaction' && composition?.compaction === null) continue
    // The resolved persistence and sandbox already carry the composition layers.
    const resolved = kind === 'persistence' || kind === 'sandbox' ? record(top[kind])?.provider : undefined
    const chosen =
      (typeof resolved === 'string' ? { provider: resolved } : undefined) ??
      readProviderSelection(kind, kind === 'loop' || kind === 'compaction' ? composed(kind) : undefined) ??
      readProviderSelection(kind, table?.[kind])
    if (chosen) selected[kind] = chosen
  }
  return selected
}

export function applyProviderSelections(
  profile: ResolvedProfile,
  selections = readProviderSelections(profile),
): ResolvedProfile {
  return {
    ...profile,
    ...(selections['model-adapter']
      ? {
          provider: {
            ...profile.provider,
            adapters:
              typeof selections['model-adapter'].provider === 'string'
                ? [selections['model-adapter'].provider]
                : [...selections['model-adapter'].provider],
          },
        }
      : {}),
    ...(selections.compaction ? { compaction: { engine: selections.compaction.provider } } : {}),
    ...(selections.persistence ? { persistence: { provider: selections.persistence.provider } } : {}),
    ...(selections.sandbox ? { sandbox: { provider: selections.sandbox.provider } } : {}),
  }
}

export function applyProviderPreset(document: PresetDoc, selections: ProviderSelections): PresetDoc {
  const chosen = {
    ...(selections['tool-runtime']
      ? { 'tool-runtime': { provider: selections['tool-runtime'].provider } }
      : {}),
    ...(selections['tool-policy'] ? { 'tool-policy': { provider: selections['tool-policy'].provider } } : {}),
  }
  return Object.keys(chosen).length
    ? {
        ...document,
        providers: { ...(document.providers as Record<string, unknown> | undefined), ...chosen },
      }
    : document
}

export function providerConfigurationScopes(
  entry: ProviderCatalogEntry,
  profile: ResolvedProfile,
  preset: PresetView,
): readonly string[] {
  if (entry.kind === 'compaction' && profile.composition?.providers?.compaction === null) return []
  if ((SEAM_KINDS as readonly string[]).includes(entry.kind)) {
    const chosen = profile.seams[entry.kind as SeamKind]
    return chosen.provider === entry.id && (chosen.version === undefined || chosen.version === entry.version)
      ? ['profile']
      : []
  }
  const selected = readProviderSelections(profile)[entry.kind as ProviderKindName]
  if (selected && entry.kind === 'model-adapter') {
    const ids = typeof selected.provider === 'string' ? [selected.provider] : selected.provider
    return (ids.includes(entry.id) || ids.includes(entry.sourcePackage)) &&
      (selected.version === undefined || selected.version === entry.version)
      ? ['profile']
      : []
  }
  if (selected)
    return selected.provider === entry.id &&
      (selected.version === undefined || selected.version === entry.version)
      ? ['profile']
      : []
  if (entry.kind === 'model-adapter')
    return profile.provider.adapters.some((id) => id === entry.id || id === entry.sourcePackage)
      ? ['profile']
      : []
  const defaults: ProviderSelections = {
    loop: {
      provider: preset.loop?.id ?? RELEASE_DEFAULTS.loop.id,
      version: preset.loop?.version ?? RELEASE_DEFAULTS.loop.version,
    },
    compaction: { provider: profile.compaction?.engine ?? 'default' },
    persistence: { provider: profile.persistence?.provider ?? 'sqlite' },
    sandbox: { provider: profile.sandbox?.provider ?? RELEASE_DEFAULTS.sandboxProvider },
    'tool-runtime': { provider: preset.tools.runtime ?? 'default' },
    'tool-policy': { provider: preset.approval.policy ?? 'default' },
    'child-agent': { provider: RELEASE_DEFAULTS.childProvider },
    memory: { provider: 'file', version: '1.0.0' },
  }
  const fallback = defaults[entry.kind as ProviderKindName]
  return fallback?.provider === entry.id &&
    (fallback.version === undefined || fallback.version === entry.version)
    ? ['default']
    : []
}

/** Admit every selected registration before operation instances are fitted. */
export function selectConfiguredProviders(
  root: import('@agnes/cordis').Context,
  selections: ProviderSelections,
): void {
  for (const kind of PROVIDER_KINDS) {
    if (kind === 'model-adapter') {
      const selection = selections[kind]
      if (!selection) continue
      const ids = typeof selection.provider === 'string' ? [selection.provider] : selection.provider
      for (const id of ids) {
        const matches = root.providers
          .catalog()
          .filter((entry) => entry.kind === kind && (entry.id === id || entry.sourcePackage === id))
        if (!matches.length)
          root.providers.select(kind, {
            provider: id,
            ...(selection.version ? { version: selection.version } : {}),
          })
        for (const entry of matches)
          root.providers.select(kind, {
            provider: entry.id,
            ...(selection.version ? { version: selection.version } : {}),
          })
      }
    } else {
      const selection = selections[kind]
      if (selection) root.providers.select(kind, selection)
    }
  }
}
