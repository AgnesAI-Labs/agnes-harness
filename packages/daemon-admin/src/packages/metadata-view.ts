import type { PluginMetadata } from '@agnes/protocol'

/** Historical metadata stays sealed in PackageManager; the wire uses today's display contract. */
export function metadataView(metadata: PluginMetadata): PluginMetadata {
  const {
    category: _category,
    launches: _launches,
    ...current
  } = metadata as PluginMetadata & {
    category?: unknown
    launches?: unknown
  }
  return structuredClone(current)
}
