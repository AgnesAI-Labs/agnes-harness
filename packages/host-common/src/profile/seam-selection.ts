import type { ProviderSelection } from '@agnes/extension-api'
import { PINNED_SEAM_KINDS, SEAM_KINDS, type SeamKind } from '@agnes/extension-api/seams'
import { REMOVED_SEAM_KEYS } from './types.js'

export { PINNED_SEAM_KINDS, SEAM_KINDS, type SeamKind }

/** Keys that named a seam under `seams` once, with the sentence that says what to write instead. */
const REMOVED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ledger: 'seams.ledger was renamed; use seams.billing',
  harness: 'seams.harness was removed; harness is no longer a seam',
  ...Object.fromEntries(
    Object.entries(REMOVED_SEAM_KEYS).map(([key, fix]) => [key, `seams.${key} was removed; ${fix}`]),
  ),
})

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** Why a `seams` value is not a valid selection, or undefined when it is. */
export function seamSelectionProblem(key: string, value: unknown): string | undefined {
  const removed = REMOVED_KEYS[key]
  if (removed) return removed
  if (!(SEAM_KINDS as readonly string[]).includes(key)) return `seams.${key} is not a seam kind`
  if (typeof value === 'string')
    return `seams.${key} must be { provider: "<id>" }; the package-id string form was removed`
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return `seams.${key} must be { provider, version? }`
  const entries = Object.entries(value)
  if (entries.some(([name]) => name !== 'provider' && name !== 'version'))
    return `seams.${key} only accepts provider and version`
  const { provider, version } = value as { provider?: unknown; version?: unknown }
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider))
    return `seams.${key}.provider must be a provider id`
  if (version !== undefined && (typeof version !== 'string' || !VERSION.test(version)))
    return `seams.${key}.version must be a semver version`
  return undefined
}

/** Every key present must be valid; `required` additionally demands all seven kinds. */
export function seamSelectionProblems(seams: unknown, required: boolean): string[] {
  const problems: string[] = []
  const record = (typeof seams === 'object' && seams !== null ? seams : {}) as Record<string, unknown>
  if (seams !== undefined && (typeof seams !== 'object' || seams === null || Array.isArray(seams)))
    return ['seams must be a mapping']
  for (const key of Object.keys(record)) {
    const problem = seamSelectionProblem(key, record[key])
    if (problem) problems.push(problem)
  }
  if (required)
    for (const key of SEAM_KINDS) if (record[key] === undefined) problems.push(`seams.${key} is required`)
  return problems
}

export function selectionOf(value: unknown): ProviderSelection {
  const { provider, version } = value as ProviderSelection
  return version === undefined ? { provider } : { provider, version }
}
