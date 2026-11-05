import type { ToolResult } from '@agnes/extension-api'

type RuntimeToolResult = ToolResult & { deferred?: unknown }
type DeferredMarker = { present: false } | { present: true; jobId: string | null }

/**
 * The runtime marker is read structurally until extension-api publishes it on ToolResult.
 * Invalid markers remain distinguishable from an absent one, so a malformed job cannot fall back
 * to an ordinary successful tool/result and disappear from recovery.
 */
export function deferredMarker(result: ToolResult): DeferredMarker {
  if (!Object.hasOwn(result, 'deferred')) return { present: false }
  const value = (result as RuntimeToolResult).deferred
  const jobId = (value as { jobId?: unknown } | null)?.jobId
  return {
    present: true,
    jobId: typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 128 ? jobId : null,
  }
}
