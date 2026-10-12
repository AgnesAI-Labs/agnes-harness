import { DEFAULT_LOOP, IN_PROCESS_CHILD_PROVIDER_ID, type PresetView } from '@agnes/core'
import {
  LOCAL_SANDBOX_PROVIDER_ID,
  type ProviderCatalogEntry,
  type ProviderSelection,
} from '@agnes/extension-api'
import { SEAM_KINDS, type SeamKind } from '@agnes/extension-api/seams'
import { HostError } from '@agnes/host-common/errors'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import {
  type ModelAdapterSelection,
  readModelAdapterSelection,
  readProviderSelection,
} from '@agnes/host-common/profile/provider-selection'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'

export const PROVIDER_KINDS = [
  'loop',
  'model-adapter',
  'compaction',
  'persistence',
  'sandbox',
  'tool-runtime',
  'tool-policy',
  'child-agent',
  'memory',
] as const
export type ProviderKindName = (typeof PROVIDER_KINDS)[number]
export type ProviderSelections = Partial<
  Record<Exclude<ProviderKindName, 'model-adapter'>, ProviderSelection>
> & { 'model-adapter'?: ModelAdapterSelection }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export { readProviderSelection } from '@agnes/host-common/profile/provider-selection'

/** Package config is the existing JSON extension point; the profile parser stays with its owner. */
export function readProviderSelections(
  profile: Pick<ResolvedProfile, 'packages'> & object,
): ProviderSelections {
  const selected: ProviderSelections = {}
  const top = profile as Record<string, unknown>
  const composition = record(top.composition)
  const sources = record(top.compositionSources)
  const authored = (kind: string) => {
    const source = record(sources?.[kind === 'model-adapter' ? 'modelAdapters' : kind])
    return source?.layer === 'default' ? undefined : composition?.[kind]
  }
  const adapters = profile.packages
    .filter((pkg) => pkg.enabled !== false)
    .flatMap((pkg) =>
      pkg.config?.['model-adapter'] === undefined
        ? []
        : [readModelAdapterSelection(pkg.config['model-adapter'])!],
    )
  if (adapters.length > 1)
    throw new HostError('E_PROFILE_FRAGMENT_KEY', 'select at most one package config.model-adapter provider')
  const composedAdapters = readModelAdapterSelection(authored('model-adapter'))
  const adapterChoice =
    (Array.isArray(composedAdapters?.provider) && composedAdapters.provider.length === 0
      ? undefined
      : composedAdapters) ?? adapters[0]
  if (adapterChoice) selected['model-adapter'] = adapterChoice
  for (const kind of PROVIDER_KINDS) {
    if (kind === 'model-adapter') continue
    if (kind === 'compaction' && record(top.composition)?.compaction === null) continue
    const direct = readProviderSelection(
      kind,
      kind === 'loop' || kind === 'compaction' ? authored(kind) : top[kind],
    )
    const candidates = profile.packages
      .filter((pkg) => pkg.enabled !== false)
      .flatMap((pkg) =>
        pkg.config?.[kind] === undefined ? [] : [readProviderSelection(kind, pkg.config[kind])!],
      )
    if (candidates.length > 1)
      throw new HostError('E_PROFILE_FRAGMENT_KEY', `select at most one package config.${kind} provider`)
    const chosen = direct ?? candidates[0]
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
  return {
    ...document,
    ...(selections['tool-runtime']
      ? { 'tool-runtime': { provider: selections['tool-runtime'].provider } }
      : {}),
    ...(selections['tool-policy'] ? { 'tool-policy': { provider: selections['tool-policy'].provider } } : {}),
  }
}

export function providerConfigurationScopes(
  entry: ProviderCatalogEntry,
  profile: ResolvedProfile,
  preset: PresetView,
): readonly string[] {
  if (entry.kind === 'compaction' && profile.composition?.compaction === null) return []
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
      provider: preset.loop?.id ?? DEFAULT_LOOP.id,
      version: preset.loop?.version ?? DEFAULT_LOOP.version,
    },
    compaction: { provider: profile.compaction?.engine ?? 'default' },
    persistence: { provider: profile.persistence?.provider ?? 'sqlite' },
    sandbox: { provider: profile.sandbox?.provider ?? LOCAL_SANDBOX_PROVIDER_ID },
    'tool-runtime': { provider: preset.tools.runtime ?? 'default' },
    'tool-policy': { provider: preset.approval.policy ?? 'default' },
    'child-agent': { provider: IN_PROCESS_CHILD_PROVIDER_ID },
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
