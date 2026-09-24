import type { Actor } from '@agnes/protocol'
import type { Timers } from '../log/session-log.js'
import type { ArtifactJob } from '../reduce/shapes.js'
import type { PresetView } from '../step/preset.js'
import type { Clock } from '../types.js'
import type { WorkspaceInvocationPort } from '../workspace/runtime.js'
import { platformView } from './platform-facts.js'
import type {
  ApprovalGrantQuery,
  ApprovalGuardianDecision,
  ApprovalRequest,
  ApprovalSeam,
  CheckpointSeam,
  Decision,
  Enforcement,
  JobSpec,
  LedgerRow,
  Pending,
  PlatformSeam,
  RepairSeam,
  SandboxSeam,
  SeamImplementations,
  SeamName,
  Target,
  Verdict,
  VerifierVerdict,
} from './seams.js'

const VERDICTS = new Set([
  'allowed-once',
  'allowed-session',
  'allowed-permanent',
  'rejected',
  'cancelled',
  'unavailable',
])
const DECISION_TTL_MS = 60_000
const ARTIFACT_POLL_TIMEOUT_MS = 5_000
const ARTIFACT_JOB_STATUSES = new Set<ArtifactJob['status']>([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
])
const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as number),
}

/**
 * Bounds a seam call in time and in the caller's abort. The rejection names what was being waited
 * on, because every caller of this function turns a rejection into a fail-closed default and the
 * message is the only place left that says which seam produced it.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
  timers: Timers = defaultTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let armed = false
    let handle: unknown
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      if (armed) timers.clearTimeout(handle)
      signal?.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = () => finish(() => reject(new Error(`aborted: ${label}`)))
    // Consume late settlement even when cancellation has already won.
    p.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    handle = timers.setTimeout(() => finish(() => reject(new Error(`timeout: ${label}`))), ms)
    armed = true
    // An injected timer may fire synchronously before returning its handle.
    if (settled) timers.clearTimeout(handle)
  })
}

export type SeamFailure = { seam: SeamName; op: string; message: string }

/**
 * The kernel's one door to the fitted seams. Every call is bounded and every failure resolves to the
 * safe answer rather than propagating: an unreachable approval reads as a refusal, an unreachable
 * verifier as a failed check, an unreachable ledger as a projection over any cap. Failing open on
 * any one of these would make the seam removable by breaking it.
 */
export class SeamRuntime {
  readonly #seams: SeamImplementations
  private readonly decisions = new Map<string, { at: number; d: Decision }>()
  private readonly caps = new Map<string, ReturnType<PlatformSeam['capability']>>()
  /** Immutable admission fact captured while Host owns the fitted workspace seam. */
  private readonly sandboxEnforcedAtOpen: boolean

  constructor(
    seams: SeamImplementations,
    // Not `readonly`: `setPreset`/`setModel` (step/reentry.ts) replace the session's active view and
    // write it here too, so every seam call made through this runtime after the switch reads the new
    // preset rather than the one frozen at construction time.
    public preset: PresetView,
    private readonly o: {
      clock: Clock
      onFailure: (f: SeamFailure) => void
      timers?: Timers
      workspaceInvocation?: WorkspaceInvocationPort
      workspacePublication?: import('../workspace/runtime.js').WorkspacePublicationDispatch
    },
  ) {
    this.#seams = seams
    this.sandboxEnforcedAtOpen = this.enforcement().level !== 'none'
  }

  /** Drops answers cached from the previous seam implementations after a provider swap. */
  invalidate(): void {
    this.decisions.clear()
    this.caps.clear()
  }

  private fail(seam: SeamName, op: string, err: unknown): void {
    this.o.onFailure({ seam, op, message: err instanceof Error ? err.message : String(err) })
  }

  private withApproval<T>(invoke: (approval: ApprovalSeam) => Promise<T>): Promise<T> {
    const port = this.o.workspaceInvocation
    if (!port) return invoke(this.#seams.approval)
    return this.o.workspacePublication
      ? this.o.workspacePublication.workspace(() => ({
          port,
          handler: (view) => invoke(view.approvalContext()),
        }))
      : port.run((view) => invoke(view.approvalContext()))
  }

  private withCheckpoint<T>(invoke: (checkpoint: CheckpointSeam) => Promise<T>): Promise<T> {
    const port = this.o.workspaceInvocation
    if (!port) return invoke(this.#seams.checkpoint)
    return this.o.workspacePublication
      ? this.o.workspacePublication.workspace(() => ({
          port,
          handler: (view) => invoke(view.checkpointContext()),
        }))
      : port.run((view) => invoke(view.checkpointContext()))
  }

  async approvalAsk(req: ApprovalRequest, signal: AbortSignal): Promise<Verdict | Pending> {
    let v: Verdict | Pending
    try {
      v = await withTimeout(
        this.withApproval((approval) => approval.ask(req)),
        this.preset.approval.timeoutMs,
        'approval.ask',
        signal,
        this.o.timers,
      )
    } catch (err) {
      this.fail('approval', 'ask', err)
      return 'rejected'
    }
    if (v && typeof v === 'object' && typeof (v as Pending).ticket === 'string') return v
    if (typeof v !== 'string' || !VERDICTS.has(v)) {
      this.fail('approval', 'ask', `verdict out of set: ${String(v)}`)
      return 'rejected'
    }
    // 'unavailable' is a real answer, not a failure: the preset decides whether an approver that
    // cannot be reached refuses the call or parks the turn until someone can be.
    if (v === 'unavailable' && this.preset.approval.onUnavailable === 'deny') return 'rejected'
    return v
  }

  async approvalGuard(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalGuardianDecision> {
    try {
      const value = await withTimeout(
        this.withApproval<ApprovalGuardianDecision | undefined>((approval) => {
          const guard = approval.guard
          return guard ? guard.call(approval, req) : Promise.resolve(undefined)
        }),
        this.preset.approval.timeoutMs,
        'approval.guard',
        signal,
        this.o.timers,
      )
      if (value === undefined)
        return { decision: 'escalate', ruleVersion: 'missing', reasons: ['guardian unavailable'] }
      if (
        !value ||
        !['allow-once', 'allow-session', 'escalate', 'reject'].includes(value.decision) ||
        typeof value.ruleVersion !== 'string' ||
        value.ruleVersion.length === 0 ||
        value.ruleVersion.length > 64 ||
        !Array.isArray(value.reasons) ||
        value.reasons.length > 32 ||
        !value.reasons.every((reason) => typeof reason === 'string' && reason.length <= 512) ||
        (value.model !== undefined && (typeof value.model !== 'string' || value.model.length > 128))
      )
        throw new TypeError('invalid guardian decision')
      return value
    } catch (err) {
      this.fail('approval', 'guard', err)
      return { decision: 'escalate', ruleVersion: 'failed', reasons: ['guardian unavailable'] }
    }
  }

  async approvalGrants(query: ApprovalGrantQuery, signal: AbortSignal) {
    try {
      const grants = await withTimeout(
        this.withApproval((approval) => {
          const list = approval.listGrants
          return list ? list.call(approval, query) : Promise.resolve([])
        }),
        this.preset.approval.timeoutMs,
        'approval.listGrants',
        signal,
        this.o.timers,
      )
      return Array.isArray(grants) ? grants : []
    } catch (err) {
      this.fail('approval', 'listGrants', err)
      return []
    }
  }

  approvalResume(ticket: string, verdict: Verdict, signal?: AbortSignal) {
    return withTimeout(
      this.withApproval((approval) => approval.resume(ticket, verdict)),
      this.preset.approval.timeoutMs,
      'approval.resume',
      signal,
      this.o.timers,
    )
  }

  async approvalPutGrant(
    grant: Parameters<NonNullable<SeamImplementations['approval']['putGrant']>>[0],
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await withTimeout(
        this.withApproval(async (approval) => {
          const put = approval.putGrant
          if (!put) return false
          await put.call(approval, grant)
          return true
        }),
        this.preset.approval.timeoutMs,
        'approval.putGrant',
        signal,
        this.o.timers,
      )
    } catch (err) {
      this.fail('approval', 'putGrant', err)
      return false
    }
  }

  async approvalRevokeGrant(grantId: string, revokedAt: string, signal: AbortSignal) {
    try {
      return await withTimeout(
        this.withApproval((approval) => {
          const revoke = approval.revokeGrant
          return revoke ? revoke.call(approval, grantId, revokedAt) : Promise.resolve(null)
        }),
        this.preset.approval.timeoutMs,
        'approval.revokeGrant',
        signal,
        this.o.timers,
      )
    } catch (err) {
      this.fail('approval', 'revokeGrant', err)
      return null
    }
  }

  async ledgerRecord(row: LedgerRow): Promise<boolean> {
    try {
      await this.#seams.ledger.record(row)
      return true
    } catch (err) {
      this.fail('ledger', 'record', err)
      return false
    }
  }

  async ledgerProjected(next: {
    tokensEstimate: number
    model: string
  }): Promise<{ credits: number; creditSource: 'gateway' | 'estimated' }> {
    try {
      return await this.#seams.ledger.projected(next)
    } catch (err) {
      this.fail('ledger', 'projected', err)
      // Spending nothing is not the safe reading of "we cannot tell what this costs": a projection
      // over every cap is, so the preflight treats an unreachable ledger as over budget.
      return { credits: Number.POSITIVE_INFINITY, creditSource: 'estimated' }
    }
  }

  async verify(
    scope: 'tool' | 'step' | 'turn' | 'task',
    input: unknown,
    signal: AbortSignal,
  ): Promise<VerifierVerdict> {
    try {
      return await withTimeout(
        this.#seams.verifier.verify(scope, input, { tier: this.preset.verifier.defaultTier, signal }),
        this.preset.verifier.timeoutMs,
        'verifier.verify',
        signal,
        this.o.timers,
      )
    } catch (err) {
      this.fail('verifier', 'verify', err)
      return { verdict: 'fail', reasons: ['verifier unavailable'] }
    }
  }

  async repairDecide(
    view: Parameters<RepairSeam['decide']>[0],
    verdict: VerifierVerdict,
  ): Promise<'repair' | 'park' | 'escalate' | 'complete'> {
    try {
      return await withTimeout(
        this.#seams.repair.decide(view, verdict),
        this.preset.repair.timeoutMs,
        'repair.decide',
        undefined,
        this.o.timers,
      )
    } catch (err) {
      this.fail('repair', 'decide', err)
      return 'park'
    }
  }

  async checkpointSnapshot(
    paths: string[],
    stepId: string,
    checkpoint?: CheckpointSeam,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    try {
      return {
        ok: true,
        ...(await (checkpoint
          ? checkpoint.snapshot(paths, stepId)
          : this.withCheckpoint((fitted) => fitted.snapshot(paths, stepId)))),
      }
    } catch (err) {
      this.fail('checkpoint', 'snapshot', err)
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  async checkpointRewind(id: string): Promise<boolean> {
    try {
      await this.withCheckpoint((checkpoint) => checkpoint.rewind(id))
      return true
    } catch (err) {
      this.fail('checkpoint', 'rewind', err)
      return false
    }
  }

  async checkpointList(): Promise<Array<{ id: string; stepId: string }>> {
    try {
      const checkpoints = await this.withCheckpoint((checkpoint) => checkpoint.list())
      return Array.isArray(checkpoints) ? checkpoints : []
    } catch (err) {
      this.fail('checkpoint', 'list', err)
      return []
    }
  }

  /**
   * Polling is recovery work, so an unavailable artifact backend cannot be read as a failed job.
   * It remains running and is tried again after the preset's deferred delay. A mismatched id or an
   * out-of-set status is treated the same way: neither is evidence about the job we asked for.
   */
  async artifactsPoll(jobId: string): Promise<ArtifactJob> {
    try {
      const job = await withTimeout(
        this.#seams.artifacts.poll(jobId),
        ARTIFACT_POLL_TIMEOUT_MS,
        'artifacts.poll',
        undefined,
        this.o.timers,
      )
      if (!job || job.jobId !== jobId || !ARTIFACT_JOB_STATUSES.has(job.status))
        throw new Error(`invalid status for artifact job ${jobId}`)
      return job
    } catch (err) {
      this.fail('artifacts', 'poll', err)
      return { jobId, status: 'running' }
    }
  }

  enforcement(sandbox: Pick<SandboxSeam, 'enforcement'> = this.#seams.sandbox): Enforcement {
    try {
      return sandbox.enforcement()
    } catch (err) {
      this.fail('sandbox', 'enforcement', err)
      return { level: 'none', scope: [] }
    }
  }

  sandboxAllowed(): boolean {
    return this.sandboxEnforcedAtOpen || this.preset.sandbox.onUnavailable === 'allow'
  }

  platformView(): ReturnType<typeof platformView> {
    return platformView(this.#seams.platform)
  }

  artifactPut(...args: Parameters<SeamImplementations['artifacts']['put']>) {
    return this.#seams.artifacts.put(...args)
  }

  artifactGet(...args: Parameters<SeamImplementations['artifacts']['get']>) {
    return this.#seams.artifacts.get(...args)
  }

  artifactPoll(...args: Parameters<SeamImplementations['artifacts']['poll']>) {
    return this.#seams.artifacts.poll(...args)
  }

  artifactCancel(...args: Parameters<SeamImplementations['artifacts']['cancel']>) {
    return this.#seams.artifacts.cancel(...args)
  }

  capability(id: string): ReturnType<PlatformSeam['capability']> {
    let c = this.caps.get(id)
    if (!c) {
      try {
        c = this.#seams.platform.capability(id)
      } catch (err) {
        this.fail('platform', 'capability', err)
        c = { level: 'unavailable', scope: [], reason: 'threw' }
      }
      this.caps.set(id, c)
    }
    return c
  }

  async authorize(actor: Actor, action: string, target: Target): Promise<Decision> {
    const key = `${actor.id}|${action}|${target.kind}|${target.id}`
    const hit = this.decisions.get(key)
    if (hit && this.o.clock() - hit.at < DECISION_TTL_MS) return hit.d
    try {
      const d = await this.#seams.principals.authorize(actor, action, target)
      this.decisions.set(key, { at: this.o.clock(), d })
      return d
    } catch (err) {
      this.fail('principals', 'authorize', err)
      return { decisionId: 'n/a', effect: 'deny', reason: 'principals unavailable' }
    }
  }

  /** Not wrapped: a job that cannot be submitted must fail visibly rather than silently vanish. */
  submitJob(spec: JobSpec): Promise<string> {
    return this.#seams.artifacts.submitJob(spec)
  }
}
