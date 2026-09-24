import type { Actor, EventEnvelope } from '@agnes/protocol'
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

  constructor(
    readonly key: string,
    readonly writerRunId: string,
    readonly generation: number,
    private readonly link: WorkerSessionChannel,
    readonly cwd: string,
    private readonly onTurnBoundary?: () => void,
  ) {}

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

  async close(): Promise<void> {
    await this.link.closeSession().catch(() => undefined)
  }
}
