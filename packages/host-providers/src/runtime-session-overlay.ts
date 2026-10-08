export type SessionOverlayDesired = Readonly<{ preset: string }>

function fail(reason: string): never {
  throw new Error(`E_SESSION_OVERLAY: ${reason}`)
}

const FORBIDDEN_OVERLAY_PREFIXES = Object.freeze(['ext:', 'seam:', 'core-op:', 'policy:'] as const)

const FORBIDDEN_OVERLAY_IDS = new Set(['llm', 'compaction'])

/** First-period overlay: only a named preset. Extra fields are rejected. */
export function sessionOverlayDesired(value: unknown): SessionOverlayDesired {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('overlay desired must be an object')
  const overlay = value as Record<string, unknown>
  if (Object.keys(overlay).sort().join('\0') !== 'preset') fail('overlay desired may only contain preset')
  if (typeof overlay.preset !== 'string' || overlay.preset.length === 0)
    fail('preset must be a non-empty string')
  return Object.freeze({ preset: overlay.preset })
}

/** Overlay builder rows: only `preset:*`. */
export function assertPresetOnlyOverlayRows(ids: readonly string[]): void {
  for (const id of ids) {
    if (id.startsWith('preset:')) continue
    if (FORBIDDEN_OVERLAY_IDS.has(id) || FORBIDDEN_OVERLAY_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      fail(`overlay row ${id} is not a preset`)
    }
    fail(`overlay row ${id} is not a preset`)
  }
}
