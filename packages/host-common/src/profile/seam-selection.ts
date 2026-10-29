import type { ProviderSelection } from '@agnes/extension-api'
import { PINNED_SEAM_KINDS, SEAM_KINDS, type SeamKind } from '@agnes/extension-api/seams'
import { HostError } from '../errors.js'
import { PROVIDER_KINDS, readModelAdapterSelection, readProviderSelection } from './provider-selection.js'
import { REMOVED_SEAM_KEYS } from './types.js'

export { PINNED_SEAM_KINDS, SEAM_KINDS, type SeamKind }

/** Keys that named a selection under `providers` once, with the sentence that says what to write instead. */
const REMOVED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ledger: 'providers.ledger was renamed; use providers.billing',
  harness: 'providers.harness was removed; harness is no longer a provider kind',
  ...Object.fromEntries(
    Object.entries(REMOVED_SEAM_KEYS).map(([key, fix]) => [key, `providers.${key} was removed; ${fix}`]),
  ),
})

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** Why a `providers` value is not a valid selection, or undefined when it is. */
export function providerSelectionProblem(key: string, value: unknown): string | undefined {
  const removed = REMOVED_KEYS[key]
  if (removed) return removed
  if (!(SEAM_KINDS as readonly string[]).includes(key)) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(key)) return `providers.${key} is not a provider kind`
    try {
      if (key === 'model-adapter') readModelAdapterSelection(value)
      else readProviderSelection(key, value)
    } catch (error) {
      if (error instanceof HostError) return `providers.${error.message.replace(/^E_[A-Z_]+: /, '')}`
      throw error
    }
    return undefined
  }
  if (typeof value === 'string')
    return `providers.${key} must be { provider: "<id>" }; the package-id string form was removed`
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return `providers.${key} must be { provider, version? }`
  const entries = Object.entries(value)
  if (entries.some(([name]) => name !== 'provider' && name !== 'version'))
    return `providers.${key} only accepts provider and version`
  const { provider, version } = value as { provider?: unknown; version?: unknown }
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider))
    return `providers.${key}.provider must be a provider id`
  if (version !== undefined && (typeof version !== 'string' || !VERSION.test(version)))
    return `providers.${key}.version must be a semver version`
  return undefined
}

/** Every key present must be valid; `required` additionally demands all seven seam kinds. */
export function providerSelectionProblems(providers: unknown, required: boolean): string[] {
  const problems: string[] = []
  const record = (typeof providers === 'object' && providers !== null ? providers : {}) as Record<
    string,
    unknown
  >
  if (
    providers !== undefined &&
    (typeof providers !== 'object' || providers === null || Array.isArray(providers))
  )
    return ['providers must be a mapping']
  for (const key of Object.keys(record)) {
    const problem = providerSelectionProblem(key, record[key])
    if (problem) problems.push(problem)
  }
  if (required)
    for (const key of SEAM_KINDS) if (record[key] === undefined) problems.push(`providers.${key} is required`)
  return problems
}

const mapping = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Where a selection used to be written, as the sentence that says where it is written now. A
 * profile selects every provider in the one `providers` table; nothing else carries a selection.
 */
export function relocatedSelection(manifest: unknown): string | undefined {
  const m = mapping(manifest)
  if (!m) return undefined
  if (Object.hasOwn(m, 'seams'))
    return 'seams was replaced by providers; write providers.<kind>: { provider }'
  for (const kind of ['persistence', 'child-agent', 'memory', 'loop', 'compaction'])
    if (Object.hasOwn(m, kind)) return `${kind} is selected with providers.${kind}: { provider }`
  if (Object.hasOwn(mapping(m.sandbox) ?? {}, 'provider'))
    return 'sandbox.provider is selected with providers.sandbox: { provider }'
  if (Object.hasOwn(mapping(m.provider) ?? {}, 'adapters'))
    return 'provider.adapters was removed; use providers.model-adapter: { provider }'
  const composition = mapping(m.composition)
  if (composition && Object.hasOwn(composition, 'providers'))
    return 'a profile selects providers in its own providers table, not in composition.providers'
  for (const kind of ['loop', 'model-adapter', 'compaction', 'persistence', 'sandbox'])
    if (mapping(composition?.[kind]))
      return `composition.${kind} is selected with providers.${kind}: { provider }`
  for (const pkg of Array.isArray(m.packages) ? m.packages : []) {
    const config = mapping(mapping(pkg)?.config)
    for (const kind of PROVIDER_KINDS)
      if (Object.hasOwn(mapping(config?.[kind]) ?? {}, 'provider'))
        return `package config.${kind} no longer selects a provider; use providers.${kind}: { provider }`
  }
  return undefined
}

export function selectionOf(value: unknown): ProviderSelection {
  const { provider, version } = value as ProviderSelection
  return version === undefined ? { provider } : { provider, version }
}
