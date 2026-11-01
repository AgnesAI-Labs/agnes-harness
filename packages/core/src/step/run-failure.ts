import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import type { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import type { ExtensionErrorCode } from '@agnes/extension-api'
import { AI_ERROR_CODES, publicErrorContract } from '@agnes/protocol'
import { drainClosingWork } from './control.js'
import { closeInterrupted } from './resume.js'
import type { SessionImpl } from './session.js'

export type RunError = { code: string; message: string; closeError?: { code: string; message: string } }
/** Only live memory; recovery after process loss continues to use durable output estimates. */
export type InferenceFailureSettlement = {
  cost?: EventInput
  committed(cost: EventInput, seq: Seq): Promise<void>
}

// Core's diagnostic allowlist is checked against the owning extension contract without adding a
// runtime dependency on extension implementation. Provider codes use the public protocol contract.
const EXTENSION_STEP_CODES: Record<ExtensionErrorCode, true> = {
  E_SERVICE_DEF: true,
  E_PROJECTION_DEF: true,
  E_PROJECTION_STATE: true,
  E_CAPABILITY_UNDECLARED: true,
  E_LEASE_EXPIRED: true,
  E_TOOLDEF_META: true,
  E_REGISTRY_DUPLICATE: true,
  E_SLOT_PAYLOAD: true,
  E_EVENT_NAMESPACE: true,
  E_HOOK_RETURN: true,
  E_API_RANGE: true,
  E_CEILING_EXCEEDED: true,
}
const STEP_CODES = new Set<string>([
  ...Object.keys(EXTENSION_STEP_CODES),
  ...AI_ERROR_CODES,
  'BUDGET_EXCEEDED',
  'TOOL_NOT_FOUND',
  'TOOL_NOT_DISCLOSED',
  'TOOL_ARGS_INVALID',
  'ENOSPC',
  'EIO',
  'EACCES',
  'EPERM',
  'EDQUOT',
  'EMFILE',
  'ENFILE',
  'EROFS',
  'ENOMEM',
])
/** Preserve declared domain codes without exporting arbitrary exception fields as diagnostics. */
export function stepFailure(error: unknown): RunError {
  let code = 'E_STEP_FAILED'
  try {
    const candidate = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (error instanceof CoreError) code = error.code
    else if (typeof candidate === 'string' && (STEP_CODES.has(candidate) || publicErrorContract(candidate)))
      code = candidate
  } catch {
    // An undeclared error's accessor has no diagnostic authority.
  }
  return { code, message: error instanceof Error ? error.message : String(error) }
}

/** Host-only evidence; never an authorization or recovery input. */
export type RunFailureSink = (failure: {
  session: string
  code: string
  phase: string | null
  lastSeq: Seq
  fault?: NonNullable<SessionLogImpl['fault']>
  closeCode?: string
}) => void

/** Owns receipt lifetimes separately from the run that may be waiting for them. */
export class FailureReceipts {
  private readonly pending = new Set<Promise<void>>()
  private readonly freezing = new Set<() => void>()
  private frozen = false
  reset(): void {
    this.frozen = false
  }
  track(work: Promise<void>, active: Set<Promise<unknown>>, freeze?: () => void): boolean {
    active.add(work)
    this.pending.add(work)
    if (freeze) this.freezing.add(freeze)
    void work
      .finally(() => {
        active.delete(work)
        this.pending.delete(work)
        if (freeze) this.freezing.delete(freeze)
      })
      .catch(() => undefined)
    return freeze !== undefined && this.frozen
  }
  async waitForReview(s: SessionImpl): Promise<void> {
    await drainClosingWork(s, this.pending)
  }
  async drain(s: SessionImpl, freezeOnly: boolean): Promise<void> {
    this.frozen = true
    for (const freeze of [...this.freezing]) freeze()
    if (freezeOnly) return
    s.decisions.revokeScope()
    s.loopScope.fail()
    s.ac.abort()
    await drainClosingWork(s, this.pending)
  }
}

/** Settle and close atomically, reporting a failed close alongside the original failure. */
export async function abandonTurn(s: SessionImpl, kind: string, error: RunError): Promise<void> {
  const phase = s.op()?.phase.kind ?? null
  try {
    await closeInterrupted(s, { code: error.code, message: error.message.slice(0, 4096) })
  } catch (err) {
    error.closeError = {
      code: err instanceof CoreError ? err.code : 'E_TURN_CLOSE_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }
    await s.diag('invariant', { kind: 'turn-close-failed', after: kind, code: error.closeError.code })
  }
  try {
    s.d.onRunFailure?.({
      session: s.key,
      code: error.code,
      phase,
      lastSeq: s.lastSeq,
      ...(s.d.log.fault ? { fault: s.d.log.fault } : {}),
      ...(error.closeError ? { closeCode: error.closeError.code } : {}),
    })
  } catch {
    // The outcome still carries both failures if the independent diagnostic sink also fails.
  }
}
