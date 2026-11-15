/** The gate, in the order a held input's checks read them, that refused or could not answer. */
export type GateName =
  | 'workspace'
  | 'model'
  | 'full-access'
  | 'auto-review'
  | 'bundle'
  | 'live-policy'
  | 'other'

/**
 * What the gates of a managed session said for its held inputs, before `refused` and `pending` are
 * told apart from a pass. It names gates, codes and booleans only: never input text or a receipt.
 */
export interface GateReport {
  verdict: 'pass' | 'refused' | 'pending'
  gate?: GateName
  /** The refusal's reason, as the gate gave it; `pending` gives what the gate is waiting for. */
  code?: string
  missing?: string
  /** The platform's sandbox L1 level the full-access gate read: full, partial, unavailable, unprobed or unreadable. */
  l1?: string
  /** The open session's live policy, when the running gate read it. */
  live?: { fullAccess: boolean; osBoundary: boolean; outwardCheckpoint: boolean }
  /**
   * The L1 level that made the full-access gate open the session (so its workspace binds and the
   * platform probes) and read the gates again; `l1` is what the second read saw.
   */
  reopenedAfter?: string
}

/** Filled in while the gates run, so the report says which one stopped them and what it read. */
export interface GateSeen {
  stage: 'start' | 'live'
  l1?: string
  live?: GateReport['live']
  reopenedAfter?: string
}

/**
 * The sandbox L1 levels that are no answer: `unprobed` until a workspace binds in the worker that
 * reports it, `unreadable` when that worker did not answer.
 */
export const L1_UNKNOWN: ReadonlySet<string> = new Set(['unprobed', 'unreadable'])

/** A gate that cannot answer yet. It is not a refusal: an input it stops stays held for a later pass. */
export class GatePending extends Error {
  constructor(
    readonly gate: GateName,
    readonly code: string,
  ) {
    super(`gate ${gate} cannot answer yet (${code})`)
    this.name = 'GatePending'
  }
}

const GATE_OF: Record<string, GateName> = {
  WORKSPACE_NOT_AUTHORIZED: 'workspace',
  MODEL_ROUTE_MISSING: 'model',
  FULL_ACCESS_UNAVAILABLE: 'full-access',
  AUTO_REVIEW: 'auto-review',
  BUNDLE_UNAVAILABLE: 'bundle',
  OUTWARD_CHECKPOINT_UNAVAILABLE: 'live-policy',
}

const observed = (seen: GateSeen) => ({
  ...(seen.l1 !== undefined ? { l1: seen.l1 } : {}),
  ...(seen.live ? { live: { ...seen.live } } : {}),
  ...(seen.reopenedAfter !== undefined ? { reopenedAfter: seen.reopenedAfter } : {}),
})

/**
 * How the gates ended: a pass, a refusal (`CAPABILITY_DENIED`), or a gate that cannot answer yet.
 * Anything else is a read that failed and is rethrown, as before: it says nothing about the gates.
 */
export function gateReport(seen: GateSeen, error?: unknown): GateReport {
  if (error === undefined) return { verdict: 'pass', ...observed(seen) }
  if (error instanceof GatePending)
    return { verdict: 'pending', gate: error.gate, code: error.code, ...observed(seen) }
  const data = (error as { data?: { code?: unknown; reason?: unknown; missing?: unknown } } | null)?.data
  if (data?.code !== 'CAPABILITY_DENIED') throw error
  const code = typeof data.reason === 'string' ? data.reason : 'CAPABILITY_DENIED'
  return {
    verdict: 'refused',
    gate: seen.stage === 'live' ? 'live-policy' : (GATE_OF[code] ?? 'other'),
    code,
    ...(typeof data.missing === 'string' ? { missing: data.missing } : {}),
    ...observed(seen),
  }
}
