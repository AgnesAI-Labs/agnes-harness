import { type PluginMetadata, validateAgainst, validatePluginMetadata } from '@agnes/protocol'
import { ExampleLaunchDeclaration } from '@agnes/protocol/gen/extension-manifest'

/** Pre-unification plugin-core metadata, only for already persisted, integrity-checked trees.
 * Author manifests still use the current closed schema. Never discard these fields on disk:
 * example launches participated in the original trust digest. */
export type StoredPluginMetadata = PluginMetadata & {
  category?: string
  launches?: unknown[]
}
const categories = new Set([
  'agent-loop',
  'tools',
  'safety-approval',
  'memory-context',
  'collaboration',
  'integrations',
  'observability',
  'ui',
  'developer',
  'business-agent',
  'example',
])
export function legacyMetadata(value: unknown): value is StoredPluginMetadata {
  return !!value && typeof value === 'object' && Object.hasOwn(value, 'category')
}
export function validStoredMetadata(value: unknown): value is StoredPluginMetadata {
  if (!legacyMetadata(value)) return validatePluginMetadata(value).ok
  const { category, launches, ...current } = value
  return (
    typeof category === 'string' &&
    categories.has(category) &&
    validatePluginMetadata(current).ok &&
    (launches === undefined ||
      (Array.isArray(launches) &&
        launches.length <= 32 &&
        launches.every((launch) => validateAgainst(ExampleLaunchDeclaration, launch).ok)))
  )
}

/** Validate a durable object with today's envelope while validating every old metadata block
 * under its original closed schema. The caller returns/writes the ORIGINAL object. */
export function currentStoredShape(value: unknown, depth = 0): unknown {
  if (depth > 4) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = { ...value } as Record<string, unknown>
  if (legacyMetadata(result.metadata) && validStoredMetadata(result.metadata)) {
    const { category: _category, launches: _launches, ...current } = result.metadata
    result.metadata = current
  }
  if (result.packages && typeof result.packages === 'object' && !Array.isArray(result.packages))
    result.packages = Object.fromEntries(
      Object.entries(result.packages).map(([id, entry]) => [id, currentStoredShape(entry, depth + 1)]),
    )
  if (result.presentation && typeof result.presentation === 'object') {
    const presentation = { ...result.presentation } as Record<string, unknown>
    if (Array.isArray(presentation.rows))
      presentation.rows = presentation.rows.map((row) => currentStoredShape(row, depth + 1))
    result.presentation = presentation
  }
  if (result.previous) result.previous = currentStoredShape(result.previous, depth + 1)
  if (Array.isArray(result.contributions))
    result.contributions = result.contributions.map((row) => currentStoredShape(row, depth + 1))
  return result
}
