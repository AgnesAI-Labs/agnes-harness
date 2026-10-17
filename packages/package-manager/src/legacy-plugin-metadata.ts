const LEGACY_METADATA_CATEGORIES = new Set([
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
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Project display metadata without changing archived bytes or capability identities. */
export function projectLegacyPluginMetadata(value: unknown): unknown {
  if (!record(value) || typeof value.category !== 'string' || !LEGACY_METADATA_CATEGORIES.has(value.category))
    return value
  const { category: _category, ...metadata } = value
  return metadata
}

/** Only verified installed/archive readers use this; author inspection stays strict. */
export function projectLegacyPluginEntries(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((entry) =>
        record(entry) && entry.metadata !== undefined
          ? { ...entry, metadata: projectLegacyPluginMetadata(entry.metadata) }
          : entry,
      )
    : value
}
