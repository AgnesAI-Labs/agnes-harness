import type { ResolvedPreset } from './presets/resolve.js'
import { canonicalJson, sha256hex } from './profile/canonical.js'

/** Host-owned storage capability. It reads exact durable reservations and actual ancestry. */
type SandboxFloorStorage = { comparisonSandboxRequired(sessionKey: string): boolean }

/** The named preset remains selected. Only the comparison security floor overrides its sandbox
 * fields; ordinary sessions and shared preset documents are unchanged. No public options mark
 * a session as a comparison. The same resolver is used before workspace probing and on replay. */
export function applySessionSandboxFloor(
  resolved: ResolvedPreset,
  storage: unknown,
  sessionKey: string | undefined,
): ResolvedPreset {
  if (!sessionKey || !storage || typeof storage !== 'object') return resolved
  const port = storage as Partial<SandboxFloorStorage>
  if (typeof port.comparisonSandboxRequired !== 'function' || !port.comparisonSandboxRequired(sessionKey))
    return resolved
  const sandbox = resolved.doc.sandbox
  const doc = {
    ...resolved.doc,
    sandbox: {
      ...(sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox) ? sandbox : {}),
      level: 'L1',
      required: true,
      on_unavailable: 'deny',
    },
  }
  return {
    ...resolved,
    doc,
    view: { ...resolved.view, sandbox: { ...resolved.view.sandbox, onUnavailable: 'deny' } },
    hash: `sha256-${sha256hex(canonicalJson(doc))}`,
  }
}
