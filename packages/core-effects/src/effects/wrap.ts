import type { PresetView } from '@agnes/core-common/step/preset'
import type { Clock } from '@agnes/core-common/types'
import type { Timers } from '@agnes/core-ledger/log/session-log'
import type { ArtifactJob } from '@agnes/core-ledger/reduce/shapes'
import type { Actor, ApprovalGrant } from '@agnes/protocol'
import { createSessionFileReader, type WorkspaceInvocationPort } from '../workspace/runtime.js'
import { isPending, normalizeApproval, type RawApproval } from './approval-answer.js'
import { platformView } from './platform-facts.js'
import type {
  ApprovalAnswer,
  ApprovalGrantQuery,
  ApprovalGrantsPort,
  ApprovalRequest,
  ApprovalSeam,
  BillingRow,
  CheckpointSeam,
  Decision,
  Enforcement,
  JobSpec,
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

const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Arms `fn` after `ms`, however long: the runtime fires a delay above 2^31-1 ms after one
 * millisecond, so a longer wait is armed a segment at a time. Returns the cancel.
 */
export function armTimeout(fn: () => void, ms: number, timers: Timers = defaultTimers): () => void {
  let handle: unknown
  let cancelled = false
  const arm = (left: number): void => {
    handle = timers.setTimeout(
      () => {
        if (cancelled) return
        if (left > MAX_TIMER_MS) arm(left - MAX_TIMER_MS)
        else fn()
      },
      Math.min(left, MAX_TIMER_MS),
    )
  }
  arm(ms)
  return () => {
    cancelled = true
    timers.clearTimeout(handle)
  }
}

/**
 * Bounds a seam call in time and in the caller's abort. The rejection names what was being waited
 * on. Callers may supply a typed timeout error when they expose recovery directly; seam callers
 * otherwise translate the default rejection into their fail-closed or retry result.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
  timers: Timers = defaultTimers,
  timeoutError?: Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let disarm: (() => void) | undefined
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      disarm?.()
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
    disarm = armTimeout(
      () => finish(() => reject(timeoutError ?? new Error(`timeout: ${label}`))),
      ms,
      timers,
    )
    // An injected timer may fire synchronously before returning its handle.
    if (settled) disarm()
  })
}

/**
 * Waits up to `ms` for `p` to settle, either way. True means it has come to rest; false means it had
 * not when the time ran out, and says nothing more about it. Never rejects, so a caller that only
 * wants to know whether the work has stopped does not have to absorb the work's own failure.
 */
export async function settlesWithin(
  p: Promise<unknown>,
  ms: number,
  timers: Timers = defaultTimers,
): Promise<boolean> {
  let disarm: (() => void) | undefined
  const rested = p.then(
    () => true,
    () => true,
  )
  const timedOut = new Promise<boolean>((resolve) => {
    disarm = armTimeout(() => resolve(false), ms, timers)
  })
  try {
    return await Promise.race([rested, timedOut])
  } finally {
    disarm?.()
  }
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
      /** Host-owned permanent approval store; absent means no permanent grant can be read or written. */
      approvalGrants?: ApprovalGrantsPort
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

  /** Delayed browser resources use the session's existing revocable workspace owner. */
  sessionFiles() {
    return this.o.workspaceInvocation ? createSessionFileReader(this.o.workspaceInvocation) : undefined
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

  /**
   * A verdict with no reason to give comes back as the bare string, so a caller that never asked for
   * reasons sees what it always saw. Everything this method decides itself carries one.
   */
  async approvalAsk(req: ApprovalRequest, signal: AbortSignal): Promise<Verdict | ApprovalAnswer | Pending> {
    const offered = structuredClone(req)
    const controller = new AbortController()
    const requestSignal = AbortSignal.any([signal, controller.signal])
    let v: RawApproval
    try {
      v = await withTimeout(
        this.withApproval((approval) => approval.ask(structuredClone(req), { signal: requestSignal })),
        this.preset.approval.timeoutMs,
        'approval.ask',
        signal,
        this.o.timers,
      )
    } catch (err) {
      this.fail('approval', 'ask', err)
      // An interrupt and a lapsed wait are not refusals by the approver, and the ledger says which.
      if (signal.aborted || (err instanceof Error && err.message.startsWith('aborted:')))
        return { verdict: 'cancelled', reason: 'stopped' }
      if (err instanceof Error && err.message.startsWith('timeout:'))
        return { verdict: 'unavailable', reason: 'deadline' }
      return { verdict: 'unavailable', reason: 'transport' }
    } finally {
      controller.abort('deadline')
    }
    if (signal.aborted) return { verdict: 'cancelled', reason: 'stopped' }
    const answer = normalizeApproval(v, offered)
    if (!answer) {
      this.fail('approval', 'ask', `verdict out of set: ${String(v)}`)
      return { verdict: 'unavailable', reason: 'invalid-answer' }
    }
    if (isPending(answer)) return answer
    // 'unavailable' is a real answer, not a failure, and it stays one: nobody was asked, so the
    // ledger must not read it as a refusal. The preset's on_unavailable decides what the turn does
    // next; until a call can park on it, the call is refused as unanswered.
    if (answer.verdict === 'unavailable')
      return { verdict: 'unavailable', reason: answer.reason ?? 'no-approver' }
    return answer.reason === undefined && answer.answeredBy === undefined ? answer.verdict : answer
  }

  async approvalGrants(query: ApprovalGrantQuery, signal: AbortSignal) {
    const port = this.o.approvalGrants
    if (!port) return []
    try {
      const grants = await withTimeout(
        port.list(query),
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

  async approvalPutGrant(grant: ApprovalGrant, signal: AbortSignal): Promise<boolean> {
    const port = this.o.approvalGrants
    if (!port) return false
    try {
      await withTimeout(
        port.put(grant),
        this.preset.approval.timeoutMs,
        'approval.putGrant',
        signal,
        this.o.timers,
      )
      return true
    } catch (err) {
      this.fail('approval', 'putGrant', err)
      return false
    }
  }

  async billingRecord(row: BillingRow): Promise<boolean> {
    try {
      await this.#seams.billing.record(row)
      return true
    } catch (err) {
      this.fail('billing', 'record', err)
      return false
    }
  }

  async billingProjected(next: {
    tokensEstimate: number
    model: string
  }): Promise<{ credits: number; creditSource: 'gateway' | 'estimated' }> {
    try {
      return await this.#seams.billing.projected(next)
    } catch (err) {
      this.fail('billing', 'projected', err)
      // Spending nothing is not the safe reading of "we cannot tell what this costs": a projection
      // over every cap is, so the preflight treats an unreachable ledger as over budget.
      return { credits: Number.POSITIVE_INFINITY, creditSource: 'estimated' }
    }
  }

  async verify(
    scope: 'tool' | 'step' | 'turn' | 'task',
    input: unknown,
    signal: AbortSignal,
  ): Promise<VerifierVerdict & { unavailable?: true }> {
    try {
      const verdict = await withTimeout(
        this.#seams.verifier.verify(scope, input, { tier: this.preset.verifier.defaultTier, signal }),
        this.preset.verifier.timeoutMs,
        'verifier.verify',
        signal,
        this.o.timers,
      )
      // Availability is runtime evidence, never a field supplied by a verifier plugin.
      return { verdict: verdict.verdict, reasons: verdict.reasons }
    } catch (err) {
      this.fail('verifier', 'verify', err)
      return { verdict: 'fail', reasons: ['verifier unavailable'], unavailable: true }
    }
  }

  async repairDecide(
    view: Parameters<RepairSeam['decide']>[0],
    verdict: VerifierVerdict,
  ): Promise<'repair' | 'park' | 'escalate' | 'complete' | 'unavailable'> {
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
      return 'unavailable'
    }
  }

  async checkpointSnapshot(
    paths: string[],
    stepId: string,
    checkpoint?: CheckpointSeam,
    owner?: string,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const options = owner === undefined ? undefined : { owner }
    try {
      return {
        ok: true,
        ...(await (checkpoint
          ? checkpoint.snapshot(paths, stepId, options)
          : this.withCheckpoint((fitted) => fitted.snapshot(paths, stepId, options)))),
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

  attachmentStore() {
    return this.#seams.artifacts.attachments
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
