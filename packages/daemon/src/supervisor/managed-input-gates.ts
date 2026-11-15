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
    /** Opening the session may let it answer: the platform probes its sandbox when a workspace binds. */
    readonly probe = false,
  ) {
    super(`gate ${gate} cannot answer yet (${code})`)
    this.name = 'GatePending'
  }
}

/** What an open session runs with; `unread` names a part of it that could not be read. */
export interface LivePolicy {
  fullAccess: boolean
  osBoundary: boolean
  outwardCheckpoint: boolean
  unread?: 'outward-checkpoint' | 'policy'
}

/** A workspace that is not registered, not present or not a usable directory is an answer; any other failure is not. */
const workspaceRefused = (error: unknown) => {
  const value = error as { name?: unknown; message?: unknown; data?: { code?: unknown } } | null
  return (
    value?.name === 'WorkspaceDirectoryError' ||
    value?.message === 'workspace_missing' ||
    typeof value?.data?.code === 'string'
  )
}

/**
 * For a held input's checks (`seen`), what keeps a gate from answering, as `GatePending`; undefined
 * where the caller refuses as before (and always for a start or a send, which pass no `seen`).
 */
export const pendingWorkspace = (seen: GateSeen | undefined, error: unknown) =>
  seen && !workspaceRefused(error) ? new GatePending('workspace', 'workspace-unreadable') : undefined

/** Records the L1 level the full-access gate read; an unknown one is pending, and only `unprobed` is worth opening the session for. */
export function pendingFullAccess(seen: GateSeen | undefined, gates: { osBoundary: boolean; l1?: string }) {
  if (!seen) return undefined
  if (gates.l1 !== undefined) seen.l1 = gates.l1
  if (gates.osBoundary || gates.l1 === undefined || !L1_UNKNOWN.has(gates.l1)) return undefined
  return new GatePending('full-access', `l1-${gates.l1}`, gates.l1 === 'unprobed')
}

/** Records the live policy; a part of it that could not be read throws `GatePending`. */
export function observeLive(seen: GateSeen | undefined, effective: LivePolicy) {
  if (!seen) return
  seen.stage = 'live'
  const { fullAccess, osBoundary, outwardCheckpoint } = effective
  seen.live = { fullAccess, osBoundary, outwardCheckpoint }
  if (effective.unread) throw new GatePending('live-policy', `${effective.unread}-unreadable`)
}

/**
 * A held input's gates, read by `read`. When the full-access gate finds the sandbox unprobed (after a
 * restart, before a workspace binds) and every other start gate passed, the session is opened, which
 * binds its workspace so the platform probes, and the gates are read again.
 */
export async function heldInputGates(
  read: (seen: GateSeen) => Promise<void>,
  open: () => Promise<unknown>,
): Promise<GateReport> {
  const seen: GateSeen = { stage: 'start' }
  try {
    try {
      await read(seen)
    } catch (error) {
      if (!(error instanceof GatePending && error.probe)) throw error
      seen.reopenedAfter = seen.l1 ?? 'unprobed'
      await open()
      await read(seen)
    }
  } catch (error) {
    return gateReport(seen, error)
  }
  return gateReport(seen)
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
