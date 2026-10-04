import { randomUUID } from 'node:crypto'
import { canonicalJson, sha256Hex } from '@agnes/core'
import {
  type ConfigurationAdmissionPort,
  type ConfigurationAdmissionReceipt,
  type HostSession,
  type SessionOwnerIdentity,
  verifyPreparedReceipt,
} from '@agnes/host'
import type { Actor, EventEnvelope, RuntimeIdentity, SessionRuntimeState } from '@agnes/protocol'
import type { SessionCloseConfirmation, ToolDetailRead, ToolDetailReadResult } from '@agnes/worker-runtime'
import type { PreviewSnapshotEntry } from '../registry.js'
import type { WorkspaceBindingEnvelope } from '../storage/workspaces.js'
import type { WorkerSessionChannel } from './worker-link.js'

/** How long a viewer's live previews may wait on a worker's snapshot. */
export const PREVIEW_SNAPSHOT_TIMEOUT_MS = 2_000

/**
 * A core `Session`-shaped subset a worker-backed session exposes to daemon's in-process RPC
 * handlers: every method is one round trip over `WorkerLink.command()`. This side holds no ledger
 * of its own - the worker holds the real `HostSession` and its storage-backed ledger - so `latest()`
 * only ever answers with what `observeRegister()` has folded from event frames actually observed on
 * the wire; a register nobody has emitted yet since this session opened reads as `undefined` here
 * even if the worker's own ledger has an older value for it.
 */
export class RemoteSession {
  lastSeq = 0
  private runSeq = 0
  private activeRuns = 0
  /** A manual compaction persists a turn before its following `run()` command starts. */
  private manualTurnReserved = false
  /** External admission may enqueue a prompt before it can call `run()`. */
  private activityLeases = 0
  private readonly latestCache = new Map<string, unknown>()
  private readonly configurationLeases = new Map<
    string,
    { release(): void; owner: ReturnType<WorkerSessionChannel['executionOwner']>; inputId: string }
  >()
  private readonly pendingConfigurationActivity = new Map<string, () => void>()

  constructor(
    readonly key: string,
    readonly writerRunId: string,
    readonly generation: number,
    private readonly link: WorkerSessionChannel,
    readonly cwd: string,
    private readonly onTurnBoundary?: () => void,
    readonly runtimeIdentity: RuntimeIdentity = { id: 'native', version: '1' },
  ) {}

  /** Wake successors use the channel's authenticated owner, not the constructor's historical one. */
  get closeWriterRunId(): string {
    return this.link.retirementOwner?.()?.writerRunId ?? this.writerRunId
  }

  get running(): boolean {
    return this.activeRuns > 0 || this.manualTurnReserved || this.activityLeases > 0
  }

  /**
   * Hold a worker generation across a caller's enqueue → run gap. This is deliberately separate
   * from ACP's client-visible `inflight` marker: scheduled work has no prompt id or cancel route.
   */
  beginActivity(): () => void {
    this.activityLeases++
    let released = false
    return () => {
      if (released) return
      released = true
      this.activityLeases--
      this.onTurnBoundary?.()
    }
  }

  observe(e: EventEnvelope): void {
    if (e.seq > this.lastSeq) this.lastSeq = e.seq
  }

  observeRegister(e: EventEnvelope): void {
    if (!e.register) return
    const dataKey = (e.data as { key?: string } | null)?.key ?? ''
    this.latestCache.set(`${e.register}/${dataKey}`, e.data)
  }

  abort(by: Actor): ReturnType<HostSession['abort']> {
    return this.link.command('abortSession', { by }) as ReturnType<HostSession['abort']>
  }

  cancelQueuedInput(commandId: string): Promise<number> {
    return this.link.command('cancelQueuedInput', { commandId }) as Promise<number>
  }

  executionOwner(): ReturnType<WorkerSessionChannel['executionOwner']> {
    return this.link.executionOwner?.()
  }

  resolveQuestionActor(credential: unknown): Promise<Actor> {
    return this.link.command('resolveQuestionActor', { credential, surface: 'session' }) as Promise<Actor>
  }

  questionsPending(): Promise<import('@agnes/protocol').QuestionInteraction[]> {
    return this.link.command('questionsPending', {}) as Promise<
      import('@agnes/protocol').QuestionInteraction[]
    >
  }
  answerQuestion(
    interactionId: string,
    answer: unknown,
    actor: Actor,
  ): Promise<import('@agnes/protocol').QuestionResolution> {
    return this.link.command('answerQuestion', { interactionId, answer, actor }) as Promise<
      import('@agnes/protocol').QuestionResolution
    >
  }
  cancelQuestion(interactionId: string, actor: Actor): Promise<import('@agnes/protocol').QuestionResolution> {
    return this.link.command('cancelQuestion', { interactionId, actor }) as Promise<
      import('@agnes/protocol').QuestionResolution
    >
  }

  runtimeState(): Promise<SessionRuntimeState> {
    return this.link.command('runtimeState', {}) as Promise<SessionRuntimeState>
  }
  async prepareSessionConfiguration(): Promise<import('@agnes/protocol').ComparisonPreparedReceipt> {
    const receipt = (await this.link.command(
      'prepareSessionConfiguration',
      {},
    )) as import('@agnes/protocol').ComparisonPreparedReceipt
    this.lastSeq = Math.max(this.lastSeq, receipt.sourceSeq)
    return receipt
  }
  async acquireConfiguration(
    input: Parameters<ConfigurationAdmissionPort['acquire']>[0],
  ): Promise<ConfigurationAdmissionReceipt> {
    if (this.pendingConfigurationActivity.size || this.configurationLeases.size)
      throw new Error('configuration admission already pending')
    const release = this.beginActivity()
    const before = this.link.executionOwner()
    if (!before || !this.link.alive) {
      release()
      throw new Error('configuration owner unavailable')
    }
    this.pendingConfigurationActivity.set(input.inputId, release)
    // Unknown delivery deliberately retains activity: a timer cannot turn it into new authority.
    let receipt: ConfigurationAdmissionReceipt
    try {
      receipt = (await this.link.command('configurationAdmission', {
        action: 'acquire',
        input,
      })) as ConfigurationAdmissionReceipt
    } catch (error) {
      // Only an authenticated, unchanged owner reporting no live/pending hold can clear
      // a failed acquisition. A lost reply or unavailable probe keeps the activity fence.
      try {
        const state = (await this.link.command('configurationAdmission', { action: 'probe' })) as {
          sessionId: string
          writerRunId: string
          held: boolean
        }
        if (
          this.link.alive &&
          JSON.stringify(before) === JSON.stringify(this.link.executionOwner()) &&
          state.sessionId === this.key &&
          state.writerRunId === before.writerRunId &&
          state.held === false
        ) {
          release()
          this.pendingConfigurationActivity.delete(input.inputId)
        }
      } catch {
        /* Unknown ownership is sticky. */
      }
      throw error
    }
    const after = this.link.executionOwner()
    if (
      !after ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      receipt.sessionId !== this.key ||
      receipt.writerRunId !== after.writerRunId ||
      receipt.inputId !== input.inputId ||
      receipt.payloadDigest !== input.payloadDigest ||
      typeof receipt.token !== 'string' ||
      !receipt.token
    )
      throw new Error('configuration owner changed')
    if (input.permissionMode === undefined) {
      if (receipt.prepared.sourceDigest !== input.prepared.sourceDigest)
        throw new Error('configuration preparation changed')
    } else {
      // A round has its own durable source. It must attest only the requested approval
      // change, not reuse the creation receipt or silently change another dimension.
      const prepared = receipt.prepared
      const [start, source] = (await Promise.all([
        this.scan({ type: 'session/start', order: 'asc', limit: 1 }),
        this.scan({ fromSeq: prepared.sourceSeq, toSeq: prepared.sourceSeq, limit: 1 }),
      ])) as EventEnvelope[][]
      const event = source?.[0]
      const data = event?.data as { inputId?: unknown; permissionMode?: unknown } | undefined
      if (
        !this.link.alive ||
        JSON.stringify(after) !== JSON.stringify(this.link.executionOwner()) ||
        prepared.sessionId !== this.key ||
        prepared.sourceSeq <= input.prepared.sourceSeq ||
        !verifyPreparedReceipt(prepared, [...(start ?? []), ...(source ?? [])]) ||
        event?.type !== 'x/host/comparison-round-prepared' ||
        data?.inputId !== input.inputId ||
        data.permissionMode !== input.permissionMode ||
        prepared.configuration.effective.permission.yolo !== false
      )
        throw new Error('configuration preparation source changed')
      const expected = structuredClone(input.prepared.configuration)
      expected.effective.permission.approvalMode = input.permissionMode === 'full' ? 'off' : 'manual'
      expected.effective.permission.digest = prepared.configuration.effective.permission.digest
      expected.fingerprints.permission = prepared.configuration.fingerprints.permission
      if (
        prepared.configuration.fingerprints.permission !==
          prepared.configuration.effective.permission.digest ||
        canonicalJson(expected) !== canonicalJson(prepared.configuration)
      )
        throw new Error('configuration preparation changed')
    }
    this.configurationLeases.set(receipt.token, { release, owner: after, inputId: input.inputId })
    this.pendingConfigurationActivity.delete(input.inputId)
    return receipt
  }
  private checkConfigurationOwner(token: string): void {
    const held = this.configurationLeases.get(token)
    if (
      !this.link.alive ||
      !held ||
      JSON.stringify(held.owner) !== JSON.stringify(this.link.executionOwner())
    )
      throw new Error('configuration owner unavailable')
  }
  /** Ephemeral retirement gate; no opens and no input/run capability. */
  async acquireIdleGate(
    members: readonly SessionOwnerIdentity[],
    signal?: AbortSignal,
  ): Promise<{ check(): Promise<void>; release(): Promise<void> }> {
    const owner = this.link.executionOwner()
    if (
      !this.link.alive ||
      !owner ||
      !members.some((member) => member.sessionKey === this.key && member.writerRunId === owner.writerRunId)
    )
      throw new Error('Idle gate owner unavailable')
    signal?.throwIfAborted()
    const finish = this.beginActivity()
    const acquisitionId = randomUUID()
    const assertOwner = () => {
      if (!this.link.alive || JSON.stringify(this.link.executionOwner()) !== JSON.stringify(owner))
        throw new Error('Idle gate owner changed')
    }
    let released = false
    let cleanup: Promise<void> | undefined
    const release = (): Promise<void> => {
      if (released) return Promise.resolve()
      if (cleanup) return cleanup
      cleanup = (async () => {
        assertOwner()
        await this.link.command('sessionIdleGate', { action: 'cancelAcquire', acquisitionId })
        assertOwner()
        released = true
        signal?.removeEventListener('abort', abort)
        finish()
      })().finally(() => {
        cleanup = undefined
      })
      return cleanup
    }
    const abort = () => {
      void release().catch(() => undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    let result: { token?: unknown }
    try {
      result = (await this.link.command('sessionIdleGate', {
        action: 'acquire',
        input: { members, acquisitionId },
      })) as { token?: unknown }
      assertOwner()
      signal?.throwIfAborted()
      if (!result || typeof result.token !== 'string' || !result.token)
        throw new Error('Idle gate receipt invalid')
    } catch (error) {
      // No execution authority exists: exact-acquisition cleanup is safe even after a lost reply.
      await release().catch(() => undefined)
      signal?.removeEventListener('abort', abort)
      throw error
    }
    const token = result.token
    return {
      check: async () => {
        if (released) throw new Error('Idle gate released')
        signal?.throwIfAborted()
        assertOwner()
        await this.link.command('sessionIdleGate', { action: 'check', token })
        assertOwner()
      },
      release,
    }
  }
  async checkConfiguration(token: string, seal = false): Promise<void> {
    this.checkConfigurationOwner(token)
    await this.link.command('configurationAdmission', { action: 'check', token, seal })
  }
  async enqueueConfiguration(
    token: string,
    message: Parameters<ConfigurationAdmissionPort['enqueue']>[2],
  ): Promise<number> {
    this.checkConfigurationOwner(token)
    return (await this.link.command('configurationAdmission', {
      action: 'enqueue',
      token,
      message,
    })) as number
  }
  async releaseConfiguration(token: string): Promise<void> {
    this.checkConfigurationOwner(token)
    await this.link.command('configurationAdmission', { action: 'release', token })
    this.configurationLeases.get(token)?.release()
    this.configurationLeases.delete(token)
  }
  async cancelConfiguration(
    inputId: string | undefined,
    actor: Actor,
    onlyMatching?: boolean,
  ): Promise<{ inputId: string | null }> {
    const before = this.link.executionOwner()
    if (!before || !this.link.alive) throw new Error('configuration owner unavailable')
    const result = (await this.link.command('configurationAdmission', {
      action: 'cancel',
      ...(onlyMatching ? { onlyMatching: true } : {}),
      ...(inputId === undefined ? {} : { inputId }),
      actor,
    })) as { inputId: string | null }
    if (
      !this.link.alive ||
      JSON.stringify(before) !== JSON.stringify(this.link.executionOwner()) ||
      (result.inputId !== null && typeof result.inputId !== 'string') ||
      (inputId !== undefined && result.inputId !== inputId)
    )
      throw new Error('configuration cancellation is unconfirmed')
    for (const [pending, release] of this.pendingConfigurationActivity) {
      if (result.inputId !== null && pending !== result.inputId) continue
      release()
      this.pendingConfigurationActivity.delete(pending)
    }
    for (const [token, value] of this.configurationLeases) {
      if (result.inputId !== null && value.inputId !== result.inputId) continue
      // The worker only acknowledges after its persisted hold is released and no work remains.
      value.release()
      this.configurationLeases.delete(token)
    }
    return result
  }
  async runConfiguration(
    token: string,
    options: Parameters<ConfigurationAdmissionPort['run']>[2],
  ): ReturnType<ConfigurationAdmissionPort['run']> {
    this.checkConfigurationOwner(token)
    const runId = `${this.key}#${++this.runSeq}`
    const onAbort = () => {
      void this.link.command('abort', { runId }).catch(() => undefined)
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (options.signal.aborted) throw options.signal.reason ?? new Error('configuration run aborted')
      const result = (await this.link.command('configurationAdmission', {
        action: 'run',
        token,
        runId,
      })) as Awaited<ReturnType<ConfigurationAdmissionPort['run']>>
      this.lastSeq = Math.max(this.lastSeq, result.lastSeq)
      if (result.reason !== 'blocked' && result.reason !== 'parked') {
        // Verify the persisted release, because terminal reply delivery and cleanup may differ.
        const marker = (await this.link.command('latest', {
          register: 'execution.admission',
          key: 'main',
        })) as {
          status?: string
          id?: string
          sessionId?: string
          writerRunId?: string
          commandId?: string
        } | null
        const held = this.configurationLeases.get(token)
        if (
          marker?.status === 'released' &&
          marker.id === sha256Hex(token) &&
          marker.sessionId === this.key &&
          marker.writerRunId === held?.owner?.writerRunId &&
          marker.commandId === held?.inputId
        ) {
          this.configurationLeases.get(token)?.release()
          this.configurationLeases.delete(token)
        }
      }
      return result
    } finally {
      options.signal.removeEventListener('abort', onAbort)
    }
  }
  async controlRuntime(
    input: Parameters<HostSession['controlRuntime']>[0],
  ): ReturnType<HostSession['controlRuntime']> {
    const release = this.beginActivity()
    try {
      const before = this.link.executionOwner?.()
      if (
        this.configurationLeases.size &&
        (!this.link.alive ||
          !before ||
          [...this.configurationLeases.values()].some(
            (held) => JSON.stringify(held.owner) !== JSON.stringify(before),
          ))
      )
        throw new Error('configuration maintenance owner changed')
      const result = (await this.link.command('controlRuntime', input)) as Awaited<
        ReturnType<HostSession['controlRuntime']>
      >
      if (this.configurationLeases.size) {
        if (!this.link.alive || JSON.stringify(before) !== JSON.stringify(this.link.executionOwner()))
          throw new Error('configuration maintenance owner changed')
        const marker = (await this.link.command('latest', {
          register: 'execution.admission',
          key: 'main',
        })) as {
          status?: string
          id?: string
          sessionId?: string
          writerRunId?: string
          commandId?: string
        } | null
        if (
          this.link.alive &&
          before &&
          JSON.stringify(before) === JSON.stringify(this.link.executionOwner())
        )
          for (const [token, held] of this.configurationLeases) {
            if (
              JSON.stringify(held.owner) === JSON.stringify(before) &&
              marker?.status === 'released' &&
              marker.id === sha256Hex(token) &&
              marker.sessionId === this.key &&
              marker.writerRunId === held.owner?.writerRunId &&
              marker.commandId === held.inputId
            ) {
              held.release()
              this.configurationLeases.delete(token)
            }
          }
      }
      return result
    } finally {
      release()
    }
  }

  enqueue(target: 'next-turn' | 'next-step', msg: unknown): Promise<number> {
    return this.link.command('enqueue', { target, msg }) as Promise<number>
  }

  async run(o: {
    until: 'turn-end' | 'idle'
    signal: AbortSignal
  }): Promise<{ reason: string; lastSeq: number; error?: unknown }> {
    const runId = `${this.key}#${++this.runSeq}`
    const onAbort = (): void => void this.link.command('abort', { runId })
    // A registry caller may still hold this proxy after its entry was removed on socket close.
    // Never create a fresh durable turn lease for a worker generation already known dead.
    if (!this.link.alive) throw new Error('worker link closed')
    // Mark busy before the first await. Scheduler jobs do not have ACP's `entry.inflight` guard,
    // and a resource snapshot can publish while their durable lease is being acquired.
    this.activeRuns++
    o.signal.addEventListener('abort', onAbort, { once: true })
    let completed = false
    try {
      const result = (await this.link.command('run', { runId, until: o.until })) as {
        reason: string
        lastSeq: number
        error?: unknown
      }
      if (result.lastSeq > this.lastSeq) this.lastSeq = result.lastSeq
      completed = true
      return result
    } catch (error) {
      // The terminal ledger commit can succeed while its RPC reply is lost. If this worker is
      // still queryable and op.state is already tombstoned, converge the lease now. A dead link
      // retains it for startup recovery, where session.resume() makes the same decision.
      try {
        if ((await this.link.command('latest', { register: 'op.state', key: 'main' })) == null)
          completed = true
      } catch {}
      throw error
    } finally {
      o.signal.removeEventListener('abort', onAbort)
      this.activeRuns--
      if (completed) this.manualTurnReserved = false
      this.onTurnBoundary?.()
    }
  }

  async status(): Promise<{
    lastSeq: number
    preset: string | null
    parent?: { key: string; boundarySeq: number }
  }> {
    const state = (await this.link.command('ping', {})) as {
      lastSeq?: number
      preset?: string | null
      parent?: { key?: unknown; boundarySeq?: unknown }
    }
    if (typeof state.lastSeq === 'number' && state.lastSeq > this.lastSeq) this.lastSeq = state.lastSeq
    const parent =
      typeof state.parent?.key === 'string' && typeof state.parent.boundarySeq === 'number'
        ? { key: state.parent.key, boundarySeq: state.parent.boundarySeq }
        : undefined
    return {
      lastSeq: this.lastSeq,
      preset: typeof state.preset === 'string' ? state.preset : null,
      ...(parent ? { parent } : {}),
    }
  }

  async currentPreset(): Promise<string | null> {
    return (await this.status()).preset
  }

  scan(q: unknown): Promise<unknown[]> {
    return this.link.command('scan', q as Record<string, unknown>) as Promise<unknown[]>
  }

  readToolDetailPage(input: ToolDetailRead): Promise<ToolDetailReadResult> {
    return this.link.command('readToolDetail', input) as Promise<ToolDetailReadResult>
  }

  /**
   * A hibernated worker session answers with nothing rather than waking. Bounded, because a viewer
   * holds its live previews until the snapshot answers; a failure releases them without it.
   */
  async previewSnapshot(): Promise<PreviewSnapshotEntry[]> {
    const got = await this.link.command('previewSnapshot', {}, { timeoutMs: PREVIEW_SNAPSHOT_TIMEOUT_MS })
    return Array.isArray(got) ? (got as PreviewSnapshotEntry[]) : []
  }

  latest(register: string, key?: string): unknown {
    return this.latestCache.get(`${register}/${key ?? ''}`)
  }

  projectUI(upto?: number, o: { surface?: string } = {}): Promise<unknown> {
    return this.link.command('projectUI', { upto, ...o })
  }

  projectUIPatch(after: number, upto?: number, o: { surface?: string } = {}): Promise<unknown> {
    return this.link.command('projectUIPatch', { after, upto, ...o })
  }

  projectUIOpening(o: { surface?: string; maxNodes?: number; maxBytes?: number } = {}): Promise<unknown> {
    return this.link.command('projectUIOpening', o)
  }

  projectUIHistory(
    cut: number,
    beforeIndex: number,
    o: { surface?: string; limit?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    return this.link.command('projectUIHistory', { cut, beforeIndex, ...o })
  }

  append(tx: unknown[]): Promise<{ seqs: number[] }> {
    return this.link.command('append', { tx }) as Promise<{ seqs: number[] }>
  }

  async setPreset(preset: string): Promise<number> {
    const result = (await this.link.command('setPreset', { preset })) as { effectiveFromSeq: number }
    this.lastSeq = Math.max(this.lastSeq, result.effectiveFromSeq)
    return result.effectiveFromSeq
  }

  async setModel(sel: unknown): Promise<number> {
    const result = (await this.link.command('setModel', { sel })) as { effectiveFromSeq: number }
    this.lastSeq = Math.max(this.lastSeq, result.effectiveFromSeq)
    return result.effectiveFromSeq
  }

  async setYolo(enabled: boolean, actor: Actor): Promise<number> {
    const result = (await this.link.command('setYolo', { enabled, actor })) as { effectiveFromSeq: number }
    this.lastSeq = Math.max(this.lastSeq, result.effectiveFromSeq)
    return result.effectiveFromSeq
  }

  async requestCompaction(input: {
    actor: Actor
    admissionId: string
    instructions?: string
  }): Promise<number> {
    // manualCompact persists turn/start + op.state before run() is entered. Bind the revision first,
    // otherwise a worker loss after the marker reply can leave a resumable turn with no old-runtime
    // lease while activation publishes and releases that runtime.
    if (!this.link.alive) throw new Error('worker link closed')
    this.manualTurnReserved = true
    try {
      return (await this.link.command('manualCompact', input)) as number
    } catch (error) {
      let released = false
      try {
        if ((await this.link.command('latest', { register: 'op.state', key: 'main' })) == null) {
          released = true
        }
      } catch {}
      if (released) {
        this.manualTurnReserved = false
        this.onTurnBoundary?.()
      }
      throw error
    }
  }

  /** Named to match core `HostSession.resumeApproval`'s job, not its name: the worker-side command
   *  handler (worker/commands.ts) is the piece that actually calls `resumeApproval` - this method is
   *  the daemon-internal `RemoteSession`'s own name for reaching it over the wire. */
  decideApproval(p: unknown): Promise<{ seq: number }> {
    return this.link.command('decideApproval', p as Record<string, unknown>) as Promise<{ seq: number }>
  }

  /** Identity resolution belongs to the worker's assembled Host, not the kernel-less supervisor. */
  resolveActor(credential: unknown, surface: 'session' | 'approval'): Promise<Actor> {
    return this.link.command('resolveActor', { credential, surface }) as Promise<Actor>
  }

  fork(
    at: number,
    childKey: string,
    credential: unknown,
    binding: WorkspaceBindingEnvelope,
  ): Promise<unknown> {
    return this.link.command('fork', { at, childKey, credential, binding })
  }

  resume(): Promise<unknown> {
    return this.link.command('resume', {})
  }

  closeAndConfirm(): Promise<SessionCloseConfirmation> {
    if (typeof this.link.closeAndConfirm !== 'function')
      return Promise.resolve({ exited: false, reason: 'owner-unknown' })
    return this.link.closeAndConfirm()
  }

  async close(): Promise<void> {
    await this.link.closeSession()
  }
}
