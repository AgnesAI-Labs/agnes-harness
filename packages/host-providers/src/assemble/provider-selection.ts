import { DEFAULT_LOOP, IN_PROCESS_CHILD_PROVIDER_ID, type PresetView } from '@agnes/core'
import {
  LOCAL_SANDBOX_PROVIDER_ID,
  type ProviderCatalogEntry,
  type ProviderSelection,
} from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { PresetDoc } from '@agnes/host-common/presets/types'
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
] as const
export type ProviderKindName = (typeof PROVIDER_KINDS)[number]
export type ProviderSelections = Partial<Record<ProviderKindName, ProviderSelection>>

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Canonical { provider } and the existing { id, version } / { engine } spellings. */
export function readProviderSelection(kind: string, value: unknown): ProviderSelection | undefined {
  if (value === undefined) return undefined
  const input = record(value)
  const provider =
    input?.provider ?? (kind === 'loop' ? input?.id : kind === 'compaction' ? input?.engine : undefined)
  if (
    !input ||
    typeof provider !== 'string' ||
    !provider.trim() ||
    (input.version !== undefined && (typeof input.version !== 'string' || !input.version.trim())) ||
    Object.keys(input).some(
      (key) =>
        ![
          'provider',
          'version',
          ...(kind === 'loop' ? ['id'] : kind === 'compaction' ? ['engine'] : []),
        ].includes(key),
    ) ||
    (input.provider !== undefined &&
      ((input.id !== undefined && input.id !== input.provider) ||
        (input.engine !== undefined && input.engine !== input.provider)))
  )
    throw new HostError(
      'E_PROFILE_FRAGMENT_KEY',
      `${kind} requires { provider: id }; loop also accepts { id, version } and compaction accepts { engine }`,
    )
  return Object.freeze({
    provider,
    ...(input.version === undefined ? {} : { version: input.version as string }),
  })
}

/** Package config is the existing JSON extension point; the profile parser stays with its owner. */
export function readProviderSelections(
  profile: Pick<ResolvedProfile, 'packages'> & object,
): ProviderSelections {
  const selected: ProviderSelections = {}
  const top = profile as Record<string, unknown>
  for (const kind of PROVIDER_KINDS) {
    if (kind === 'compaction' && record(top.composition)?.compaction === null) continue
    const direct = readProviderSelection(kind, top[kind])
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
      ? { provider: { ...profile.provider, adapters: [selections['model-adapter'].provider] } }
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
      ? { tools: { ...record(document.tools), runtime: selections['tool-runtime'].provider } }
      : {}),
    ...(selections['tool-policy']
      ? { approval: { ...record(document.approval), policy: selections['tool-policy'].provider } }
      : {}),
  }
}

export function providerConfigurationScopes(
  entry: ProviderCatalogEntry,
  profile: ResolvedProfile,
  preset: PresetView,
): readonly string[] {
  if (entry.kind === 'compaction' && profile.composition?.compaction === null) return []
  const selected = readProviderSelections(profile)[entry.kind as ProviderKindName]
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
  }
  const fallback = defaults[entry.kind as ProviderKindName]
  return fallback?.provider === entry.id &&
    (fallback.version === undefined || fallback.version === entry.version)
    ? ['default']
    : []
}
