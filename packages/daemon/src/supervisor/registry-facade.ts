import type { SessionLister, SessionMetaRow } from '@agnes/daemon-foundation/local/ports'
import type { Disposer } from '@agnes/daemon-foundation/local/tail'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry } from '@agnes/daemon-foundation/registry'
import type { SessionWorkspacePort } from '@agnes/daemon-foundation/storage/lister'
import type { WorkspaceBindingEnvelope } from '@agnes/daemon-foundation/storage/workspaces'
import type { SessionEntry } from '@agnes/daemon-rpc/local/sessions'
import type { HostSession } from '@agnes/host'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import type { RemoteEntry, WorkerRegistry } from './registry.js'
import { recencyCursor } from './session-reads.js'

/**
 * Bridges `WorkerRegistry` (`Registry<RemoteEntry>`) onto the concrete `Registry<SessionEntry>`
 * shape `registerAcp`/`registerAgnes` are typed against (`LocalContext.registry`).
 *
 * `registry.test.ts` spells out exactly why this is not a free assignment: a
 * `RemoteEntry` carries no `backlog` / `backlogTruncated` / `tailError` / `listenerErrors` (fields
 * `SessionRegistry`'s own tail bookkeeping uses internally - grepping `local/methods/acp.ts` and
 * `local/methods/agnes.ts` shows neither file ever reads them off an entry it was handed), and its
 * `session` is a `RemoteSession` wire proxy, not a real `HostSession`. That test's own comment marks
 * the fuller fix - making `LocalContext` / `AgnesContext` / `Feed` generic over the entry type, so a
 * real `WorkerRegistry` type-checks there directly - as "later work (a future startSupervisor
 * task)". This file is that task, and this class is the reconciliation: instead of touching three
 * already-landed, already-tested files to widen a type parameter, it wraps every entry `WorkerRegistry`
 * hands out in a view object that structurally satisfies `SessionEntry`, with exactly one unsound
 * line (`.session`'s cast) confined to `RemoteEntryView` below and exercised end-to-end by
 * `supervisor.e2e.test.ts`.
 */
class RemoteEntryView implements SessionEntry {
  readonly key: string
  readonly session: HostSession
  readonly generation: number
  readonly tail: SessionEntry['tail']
  readonly listeners: SessionEntry['listeners']
  readonly backlog: SessionEntry['backlog'] = []
  readonly backlogTruncated = false
  readonly tailError: unknown = null
  readonly listenerErrors: unknown[] = []
  readonly ac: AbortController

  constructor(private readonly e: RemoteEntry) {
    this.key = e.key
    // Unsound by construction, and confined to this one line: `RemoteSession`
    // (supervisor/remote-session.ts) implements exactly the subset of `HostSession` that
    // acp.ts/agnes.ts actually call on an entry's `.session` - enqueue / run / scan / setPreset /
    // setModel / setYolo / requestCompaction / projectUI / projectUIPatch / projectUIOpening /
    // projectUIHistory / lastSeq
    // (enumerated in this task's report) - never the full interface.
    // A call this package does not already make would fail at runtime ("not a function") rather than
    // at compile time; supervisor.e2e.test.ts is what actually proves the subset in use today is
    // covered, and reverse-verification in this task's report deliberately breaks this line once to
    // confirm the test would catch a regression here.
    this.session = e.session as unknown as HostSession
    this.generation = e.generation
    this.tail = e.tail
    this.listeners = e.listeners
    this.ac = e.ac
  }

  submitUiAction(
    input: import('@agnes/protocol').UiActionParams,
    credential: unknown,
    signal: AbortSignal,
  ): Promise<import('@agnes/protocol').UiActionReceipt> {
    return this.e.session.intelligentUi.actionFromCredential(input, credential, signal)
  }

  // The one field that must NOT be a snapshot: `session/prompt` (acp.ts) writes `entry.inflight = ...`
  // on one call and reads it back on a *different* call (a concurrent second prompt on the same
  // session, checking SESSION_BUSY) - both calls go through fresh `require()`/`get()` calls that each
  // construct a new `RemoteEntryView`, so a plain copied field would silently lose that write the
  // moment the first view was garbage collected, reopening the double-prompt race SESSION_BUSY exists
  // to close. A live accessor onto the underlying `RemoteEntry` keeps every view of the same entry
  // reading and writing the one shared value.
  get inflight(): SessionEntry['inflight'] {
    // `RemoteEntry['inflight'].promptId` is `unknown` (supervisor/registry.ts); `SessionEntry`'s is
    // the narrower `JsonRpcId`. Both sides only ever write `'prompt'` (acp.ts's own literal) into
    // this field, so the narrowing is safe in practice - the cast exists because the two already-
    // landed types were never unified to begin with, not because this view invents a new promptId.
    return this.e.inflight as SessionEntry['inflight']
  }
  set inflight(v: SessionEntry['inflight']) {
    this.e.inflight = v
  }

  sameEntry(other: SessionEntry): boolean {
    return other instanceof RemoteEntryView && other.e === this.e
  }
}

type SessionOpenRequest = Parameters<Registry<SessionEntry>['open']>[0] & { resume?: boolean }

export class SupervisorRegistry implements Registry<SessionEntry> {
  private readonly opening = new Map<
    string,
    {
      cwd: string
      preset: string | null
      permission: string | null
      agent: string | null
      bundles: string | null
      systemPromptAppend: string | null
      loop: string | null
      promise: Promise<SessionEntry>
    }
  >()

  constructor(
    private readonly inner: WorkerRegistry,
    private readonly workspaces: SessionWorkspacePort,
  ) {}
  async open(o: SessionOpenRequest): Promise<SessionEntry> {
    if (o.agent === undefined) o = { ...o, permission: o.permission ?? 'default' }
    if (o.key) {
      const pending = this.opening.get(o.key)
      if (pending) {
        if (
          pending.cwd !== o.cwd ||
          pending.preset !== (o.preset ?? null) ||
          pending.permission !== (o.permission ?? null) ||
          pending.agent !== (o.agent === undefined ? null : JSON.stringify([o.agent, o.agentDigest])) ||
          pending.bundles !== (o.bundles === undefined ? null : JSON.stringify(o.bundles)) ||
          pending.systemPromptAppend !== (o.systemPromptAppend ?? null) ||
          pending.loop !== (o.loop ? JSON.stringify(o.loop) : null)
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
        return pending.promise
      }
      const promise = this.openFresh(o)
      this.opening.set(o.key, {
        cwd: o.cwd,
        preset: o.preset ?? null,
        permission: o.permission ?? null,
        agent: o.agent === undefined ? null : JSON.stringify([o.agent, o.agentDigest]),
        bundles: o.bundles === undefined ? null : JSON.stringify(o.bundles),
        systemPromptAppend: o.systemPromptAppend ?? null,
        loop: o.loop ? JSON.stringify(o.loop) : null,
        promise,
      })
      try {
        return await promise
      } finally {
        if (this.opening.get(o.key)?.promise === promise) this.opening.delete(o.key)
      }
    }
    return this.openFresh(o)
  }

  private async openFresh(o: SessionOpenRequest): Promise<SessionEntry> {
    const persisted = o.key ? this.workspaces.get(o.key) : undefined
    if (o.key && persisted !== undefined && persisted !== o.cwd)
      throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
    if (o.key && o.preset !== undefined) {
      const active = this.inner.get(o.key)
      const currentPreset = active
        ? await active.session.currentPreset()
        : this.workspaces.metadata(o.key)?.preset
      if (currentPreset !== null && currentPreset !== undefined && currentPreset !== o.preset)
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
    }
    // Only a live worker reports the level; the durable projection does not record it, and `default`
    // names whatever the deployment default is, which only the Host resolves.
    if (o.key && o.permission !== undefined && o.permission !== 'default') {
      const active = this.inner.get(o.key)
      if (active && (await active.session.status()).permission !== o.permission)
        throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT', sessionId: o.key })
    }
    const cwd = persisted ?? o.cwd
    const wasOpen = o.key ? this.inner.get(o.key) !== undefined : false
    const entry = await this.inner.open({ ...o, cwd })
    try {
      this.workspaces.put(entry.key, entry.session.cwd)
      await this.workspaces.refresh(entry.key, entry.session, entry.generation)
    } catch (error) {
      // A mapping failure must not leave a freshly-created worker reachable without the durable
      // workspace needed to recover it. Existing live entries predate this call and stay owned by
      // their original opener.
      if (!wasOpen) await this.inner.close(entry.key).catch(() => undefined)
      throw error
    }
    return new RemoteEntryView(entry)
  }
  async fork(o: {
    parent: string
    at: number
    childKey?: string
    binding?: WorkspaceBindingEnvelope
    credential?: unknown
  }): Promise<SessionEntry> {
    const entry = await this.inner.fork(o)
    try {
      this.workspaces.put(entry.key, entry.session.cwd)
      await this.workspaces.refresh(entry.key, entry.session, entry.generation)
    } catch (error) {
      // The worker has already adopted the child at this point. If the durable workspace index
      // cannot own it, close that exact child so its workspace owner reference cannot leak.
      await this.inner.close(entry.key).catch(() => undefined)
      throw error
    }
    return new RemoteEntryView(entry)
  }
  get(key: string): SessionEntry | undefined {
    const e = this.inner.get(key)
    return e ? new RemoteEntryView(e) : undefined
  }
  /**
   * Opens `o.key` unless its lapsed claim's writer `runId` is alive here, or an open of the key is
   * already in flight. The check and the start of the open happen in the same tick.
   */
  openIfAbsent(
    o: Parameters<SupervisorRegistry['open']>[0] & { key: string },
    runId: string,
  ): Promise<SessionEntry> | null {
    if (this.opening.has(o.key) || this.inner.holds(o.key, runId)) return null
    return this.open(o)
  }
  require(key: string): SessionEntry {
    return new RemoteEntryView(this.inner.require(key))
  }
  subscribe(key: string, fn: (e: EventEnvelope) => void): Disposer {
    return this.inner.subscribe(key, fn)
  }
  subscribePreview(key: string, fn: (p: PreviewUpdate) => void, gap?: () => void): Disposer {
    return this.inner.subscribePreview(key, fn, gap)
  }
  previewSnapshot(key: string): Promise<PreviewSnapshotEntry[]> {
    return this.inner.previewSnapshot(key)
  }
  preset(key: string): Promise<string | null> {
    return this.inner.require(key).session.currentPreset()
  }
  status(
    key: string,
    cwd?: string,
  ): Promise<{ lastSeq: number; preset: string | null; permission?: string }> {
    const existing = this.inner.get(key)
    if (existing) return existing.session.status()
    throw rpcError('SESSION_NOT_FOUND', { sessionId: key, ...(cwd ? { cwd } : {}) })
  }
  keys(): string[] {
    return this.inner.keys()
  }
  close(key: string): Promise<void> {
    return this.inner.close(key)
  }
  closeAll(): Promise<void> {
    return this.inner.closeAll()
  }
}

/** Completes the durable principal handoff for an already-created fork. A rejected or failed CAS
 *  cannot leave the worker child live because no principal would be allowed to close it later. */
export async function activateForkOwnership(
  registry: Pick<Registry<SessionEntry>, 'close'>,
  entry: SessionEntry,
  activate: () => boolean,
): Promise<SessionEntry> {
  try {
    if (!activate())
      throw rpcError('CAPABILITY_DENIED', {
        method: 'session.fork',
        reason: 'session owner unavailable',
      })
    return entry
  } catch (error) {
    await registry.close(entry.key).catch(() => undefined)
    throw error
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function supervisorLister(
  registry: SupervisorRegistry,
  workspaces: SessionWorkspacePort,
): SessionLister {
  return {
    async list(q) {
      const limit = Math.min(500, Math.max(1, q.limit ?? 50))
      const scope = q.sessionIds ? new Set(q.sessionIds) : undefined
      const after = recencyCursor(q.cursor)
      // The package-owned workspace index is the durable session directory. Unioning live keys
      // keeps a just-opened session visible even if its index write is being completed, while the
      // (activity, key) keyset cursor makes a restart-independent page boundary possible.
      const all = [...new Set([...workspaces.keys(), ...registry.keys()])]
        .filter((k) => !scope || scope.has(k))
        .filter((k) => !q.q || k.includes(q.q))
        .filter((k) => q.cwd === undefined || workspaces.get(k) === q.cwd)
        // ponytail: one metadata point read per candidate key; move to an indexed ORDER BY on
        // session_workspaces if local session counts reach the thousands.
        .map((key) => {
          const projected = workspaces.metadata(key)
          // Latest user message first; a session nobody has chatted in yet ranks by creation.
          return { key, projected, at: projected?.lastActiveAt || projected?.createdAt || '' }
        })
        .sort((a, b) => byCodeUnit(b.at, a.at) || byCodeUnit(a.key, b.key))
        .filter((row) => !after || row.at < after.at || (row.at === after.at && row.key > after.key))
      const page = all.slice(0, limit)
      const items: SessionMetaRow[] = []
      for (const { key, projected } of page) {
        const active = registry.get(key)
        let state: { lastSeq: number; preset: string | null; permission?: string } = projected
          ? { lastSeq: projected.lastSeq, preset: projected.preset }
          : { lastSeq: active?.session.lastSeq ?? 0, preset: null }
        if (active) {
          // An active worker can answer cheaply; historical rows use the durable event projection
          // and are never booted merely because a client listed sessions.
          try {
            state = await registry.status(key)
          } catch {
            // Keep the last durable projection if the worker exits during this read.
          }
        }
        const cwd = workspaces.get(key)
        items.push({
          sessionId: key,
          createdAt: projected?.createdAt ?? '',
          lastSeq: state.lastSeq,
          generation: active?.generation ?? projected?.generation ?? 0,
          // PageSessionMeta requires a string. `default` is the profile's unconfigured sentinel and
          // is used only when an old/incomplete projection has no recorded start preset.
          preset: state.preset ?? 'default',
          ...(state.permission ? { permission: state.permission } : {}),
          ...(projected?.loop ? { loop: projected.loop } : {}),
          ...(projected?.title ? { title: projected.title } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
        })
      }
      const last = page.at(-1)
      const cursor = all.length > limit && last ? JSON.stringify([last.at, last.key]) : undefined
      return { items, ...(cursor !== undefined ? { cursor } : {}) }
    },
  }
}
