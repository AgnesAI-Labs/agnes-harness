import { CompactionRunner } from '@agnes/core'
import type { CompactionEngineRegistry } from './compaction-engines.js'

/** Select once at Host startup; an explicit unknown id never silently falls back. */
export function assembleCompaction(
  engines: CompactionEngineRegistry,
  config?: Readonly<{ engine: string }>,
): CompactionRunner | undefined {
  const id = config?.engine ?? 'default'
  // Hosts without Base historically have no compaction runner.
  if (!config && !engines.catalog().some((entry) => entry.id === id)) return undefined
  return new CompactionRunner({ engine: engines.create(id), onCompact: async () => undefined })
}
