import type { NormalizedPluginRuntime } from './entry-row.js'

/** Normalize the optional manifest runtime before constructing an EntryRow. */
export function normalizePluginRuntime(runtime: unknown): NormalizedPluginRuntime {
  if (runtime === undefined) return 'in-process'
  if (runtime === 'in-process' || runtime === 'isolated') return runtime
  throw new TypeError(`invalid plugin runtime: ${String(runtime)}`)
}
