import { randomUUID } from 'node:crypto'
import {
  ActivationInProgressError,
  sessionKey as canonicalSessionKey,
  type ExtensionActivationBarrier,
  type Host,
  type QueuedActivationInvocation,
} from '@agnes/host'
import {
  ATTACHMENT_REFUSAL_CODES,
  downgradeEvent,
  type EventEnvelope,
  fromAcpPrompt,
  type HarnessMeta,
  type Inbox,
  type RpcError,
  rpcError,
  setHarnessMeta,
  type TurnEndReason,
  toAcpStopReason,
} from '@agnes/protocol'
import type { PreviewSnapshotEntry, PreviewUpdate, Registry } from '../../registry.js'
import { notify } from '../../rpc.js'
import type { SessionPrincipalOwnership } from '../../storage/session-ownership.js'
import type { WorkspaceCatalog } from '../../storage/workspaces.js'
import type { AttachedFeed } from '../attached.js'
import { type AuthConfig, authGate, type NonceConsume } from '../auth.js'
import { type CommandQueue, runQueued } from '../command-queue.js'
import { type AttachPrefs, connActor, type Handler, type LocalEndpoint } from '../endpoint.js'
import { createFollowUpRunner } from '../follow-up-runner.js'
import { type MetaState, stampMeta } from '../meta.js'
import { PreviewPipe } from '../preview.js'
import { toSessionUpdates } from '../project.js'
import type { PrompterRouter } from '../prompter.js'
import { reserveOwnedSession, SessionAdmissionDenied } from '../session-admission.js'
import type { SessionEntry } from '../sessions.js'
// A value import from agnes.ts, not a runtime cycle: agnes.ts's own import of `Feed`/`LocalContext`
// from this file is `import type`, which the compiler erases entirely, so nothing here ever has to
// load agnes.ts back at runtime in the other direction.
import { mapCore } from './agnes.js'
import { throwWorkspaceRpcError } from './workspaces.js'

export type LocalContext = {
  host: Host
  registry: Registry<SessionEntry>
  prompter: PrompterRouter
  clock: () => number
  agnesVersion: string
  quiescenceWaitMs: number
  auth: { config: AuthConfig; nonces: NonceConsume; clock: () => number }
  commandQueue: CommandQueue
  activationBarrier: ExtensionActivationBarrier
  workspaces: WorkspaceCatalog
  /** Actor resolver for a session that has no worker yet. Remote supervisors must inject this. */
  resolveNewSessionActor: Host['resolveActor']
  /** True only when registry.open forwards the same authenticated credential to session creation. */
  sessionCredentialAuthority?: boolean
  /** Server-authenticated, insert-only session ownership. Never populated from request data. */
  sessionOwnership?: SessionPrincipalOwnership
  /** Trusted durable/live existence check. Supervisor implementations must not touch a worker kernel. */
  hasSessionFact?: (sessionId: string) => boolean
  /**
   * Fired exactly around the window `session/prompt` below holds `entry.inflight` for one session -
   * started only by the connection that actually wins the SESSION_BUSY race (a concurrent second
   * caller throws before either hook runs), ended in the same `finally` that clears `inflight`. The
   * in-process `createLocalEndpoint` form has no use for these (its own `PrompterRouter.originOf`
   * just reads `registry.get(key)?.inflight`, since there is only ever one connection to attribute it
   * to) and leaves both undefined, which is a no-op here. `startSupervisor`
   * (supervisor/supervisor.ts) is the first caller that needs to know *which* of several concurrent
   * connections a given session's live prompt belongs to - the connection-scoped closures it installs
   * here are how it tracks that without this file exposing `ConnectionState` itself as part of the
   * public hook signature.
   */
  onPromptStart?: (sessionId: string) => void
  onPromptEnd?: (sessionId: string) => void
  continueFollowUps?: ReturnType<typeof createFollowUpRunner>
}

const HARNESS = 'ai.agnes.harness'
const pocket = (o: unknown): Record<string, unknown> =>
  (o as { _meta?: Record<string, Record<string, unknown>> } | undefined)?._meta?.[HARNESS] ?? {}

/**
 * The event classes a `session/load` replays: what a reopened transcript is made of. `tool/call` is
 * here with `tool/result` because the update refers to a toolCallId by id - replaying the result
 * alone left a client keying on that id with an update for a call it had never been told about.
 */
const LOADABLE = ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'plan.items']

/** The visible text of a message or interrupted-output content array; reasoning is left out. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/**
 * One connection's ACP `session/update` stream for one session: _meta derivation, projection, the
 * quiescence carrier, and the ordering hook session/prompt waits on. Raw `_agnes/v1/session.event`
 * is NOT written here - the attached feed owns it and keeps its own MetaState, so a cursor catch-up
 * replaying history cannot walk this stream's promptTurnId or eventSequence back.
 */
export class Feed {
  private meta: MetaState
  private waiters: Array<{ seq: number; resolve: () => void }> = []
  lastPushed = 0
  /** Drops this Feed's registry subscription; feedFor sets it once the Feed is subscribed. */
  dispose: () => void = () => undefined
  // Streamed text. ACP chunks carry no offsets, so this Feed remembers what it already said for each
  // inference and turns every preview, snapshot and final answer into exactly the missing part.
  private readonly preview: PreviewPipe | undefined
  private readonly active = new Map<string, string>()
  private readonly said = new Map<string, { text: string; thinking: string }>()
  private readonly finished: string[] = []
  // Lanes whose last answer was told whole because this Feed never learned its inference. Until the
  // lane's next inference shows up in a row, text for an inference it has not seen is stale.
  private readonly blind = new Set<string>()

  constructor(
    private readonly ep: LocalEndpoint,
    private readonly entry: SessionEntry,
    private readonly prefs: () => AttachPrefs | undefined,
    fetchPreview?: () => Promise<PreviewSnapshotEntry[]>,
  ) {
    this.meta = { promptTurnId: null, generation: entry.generation }
    // A Feed opened mid-inference never sees that inference's intent row; the op.state register
    // names it, so its answer is told as the rest of what the previews said.
    const op = entry.session?.latest('op.state', 'main') as
      | { phase?: { kind?: unknown; gen?: { status?: unknown; effectId?: unknown } } }
      | null
      | undefined
    const gen = op?.phase?.kind === 'inference' ? op.phase.gen : undefined
    if (gen?.status === 'effect_pending' && typeof gen.effectId === 'string')
      this.active.set('main', gen.effectId)
    if (fetchPreview)
      this.preview = new PreviewPipe({ fetch: fetchPreview, send: (p) => this.previewUpdate(p) })
  }

  onPreview(p: PreviewUpdate): void {
    this.preview?.live(p)
  }

  /** Catches this Feed up on whatever is streaming now; used when it may have missed text. */
  previewResync(): void {
    this.preview?.resync()
  }

  previewLowWater(): void {
    this.preview?.lowWater()
  }

  closePreview(): void {
    this.preview?.close()
  }

  private projects(): boolean {
    const prefs = this.prefs()
    return !prefs || prefs.filter.acpUpdates
  }

  private previewUpdate(p: PreviewUpdate): boolean {
    if (this.finished.includes(p.effectId) || !this.projects()) return true
    if (this.blind.has(p.lane) && this.active.get(p.lane) !== p.effectId) return true
    if (!this.active.has(p.lane)) this.active.set(p.lane, p.effectId)
    const said = this.said.get(p.effectId) ?? { text: '', thinking: '' }
    const before = said[p.stream]
    // A gap means text was lost on the way; the final answer fills it in.
    if (p.offset > before.length) return true
    const piece = p.delta.slice(before.length - p.offset)
    if (!piece) return true
    const update = {
      sessionId: this.entry.key,
      update: {
        sessionUpdate: p.stream === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: piece },
      },
    }
    // A preview is not a row and has no ledger position, so it carries no harness _meta: the
    // eventSequence / promptTurnId / quiescence invariants are about rows only.
    if (!this.ep.pushPreview(notify('session/update', update))) return false
    said[p.stream] = before + piece
    this.said.set(p.effectId, said)
    return true
  }

  /**
   * The durable answer for the lane's running inference: say whatever the previews did not. With no
   * inference known for the lane, nothing was said for it here, so the whole answer goes out.
   */
  private finish(lane: string, final: string, meta: HarnessMeta): void {
    const effectId = this.active.get(lane)
    if (effectId !== undefined && this.finished.includes(effectId)) return
    const said = effectId === undefined ? '' : (this.said.get(effectId)?.text ?? '')
    if (final.length > said.length && final.startsWith(said))
      this.ep.push(
        notify(
          'session/update',
          setHarnessMeta(
            {
              sessionId: this.entry.key,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: final.slice(said.length) },
              },
            },
            meta,
          ),
        ),
      )
    // The lane keeps its inference until the settlement row, so an answer recorded twice for it
    // (interrupted, then the message) is still told once.
    if (effectId === undefined) this.blind.add(lane)
    else this.done(effectId)
  }

  private done(effectId: string): void {
    this.said.delete(effectId)
    if (!this.finished.includes(effectId)) {
      this.finished.push(effectId)
      if (this.finished.length > 64) this.finished.shift()
    }
  }

  private close(effectId: string): void {
    this.done(effectId)
    for (const [lane, id] of this.active) if (id === effectId) this.active.delete(lane)
  }

  private begin(lane: string, effectId: string): void {
    this.active.set(lane, effectId)
    this.blind.delete(lane)
  }

  /** Keeps track of which inference each lane is streaming, from the rows this Feed sees. */
  private track(e: EventEnvelope, meta: HarnessMeta, replay: boolean): void {
    const lane = e.lane ?? 'main'
    const d = (e.data ?? {}) as { kind?: unknown; effectId?: unknown; state?: unknown; content?: unknown }
    const effectId = typeof d.effectId === 'string' ? d.effectId : undefined
    if (e.type === 'effect/intent' && d.kind === 'inference' && effectId) this.begin(lane, effectId)
    else if (e.type === 'assistant/output' && effectId) {
      if (d.state === 'started') this.begin(lane, effectId)
      else if (d.state === 'interrupted' && !replay && this.projects()) {
        this.active.set(lane, effectId)
        this.finish(lane, textOf(d.content), meta)
      }
    } else if (e.type === 'assistant/message' && !replay && this.projects())
      this.finish(lane, textOf(d.content), meta)
    else if (e.type === 'effect/settled' && effectId) this.close(effectId)
  }

  /** A same-key worker restart creates a new registry entry that needs a fresh subscription. */
  belongsTo(entry: SessionEntry): boolean {
    // A supervisor hands out a fresh view per lookup; it says itself whether two views share an entry.
    return this.entry.sameEntry ? this.entry.sameEntry(entry) : this.entry === entry
  }

  onEvent(e: EventEnvelope, o: { replay?: boolean } = {}): void {
    const { meta, next } = stampMeta(e, this.meta)
    this.meta = next
    this.track(e, meta, o.replay === true)
    const prefs = this.prefs()
    // An attached client that asked for raw rows only gets no ACP projection; everyone else does.
    if (!prefs || prefs.filter.acpUpdates) {
      // ACP has no content block for an attachment reference (its image needs inline data), so
      // every client gets the link and text here; the reference itself travels on session.event
      // and in UI projections to a connection that declared it.
      const updates = toSessionUpdates(downgradeEvent(e), o)
      updates.forEach((u, i) => {
        const update = { sessionId: this.entry.key, update: { sessionUpdate: u.sessionUpdate, ...u.payload } }
        // One row, one ledger position: only its first update carries the row's meta, so each
        // eventSequence is still told once. The further blocks of a user message follow it unstamped,
        // like previews, and an ACP client joins them into that message.
        this.ep.push(notify('session/update', i === 0 ? setHarnessMeta(update, meta) : update))
      })
      // turn/end has no projection of its own; the phase rides an empty chunk so an ACP client sees
      // terminalQuiescence as the last session/update of the turn.
      if (updates.length === 0 && e.type === 'turn/end')
        this.ep.push(
          notify(
            'session/update',
            setHarnessMeta(
              {
                sessionId: this.entry.key,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
              },
              meta,
            ),
          ),
        )
    }
    this.lastPushed = e.seq
    for (const w of this.waiters.splice(0)) {
      if (w.seq <= e.seq) w.resolve()
      else this.waiters.push(w)
    }
  }

  /**
   * Resolves when a row at or past `seq` has been pushed, or when the wait runs out. Bounded on
   * purpose: run() reports the turn's lastSeq, and if no tailed row ever carries it - a lane the
   * tail does not follow, a row filtered out upstream - an unbounded wait hangs session/prompt for
   * good. Late quiescence is a worse response ordering; no response at all is a hung client.
   */
  pushed(seq: number, o: { timeoutMs: number }): Promise<void> {
    if (this.lastPushed >= seq) return Promise.resolve()
    return new Promise((resolve) => {
      const w = {
        seq,
        resolve: () => {
          clearTimeout(t)
          resolve()
        },
      }
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w)
        resolve()
      }, o.timeoutMs)
      this.waiters.push(w)
    })
  }

  /**
   * Replays a transcript into this Feed. It does not touch any other connection's Feed - but it is
   * not isolated from this one's live stream either: feedFor() caches one Feed per session, so a
   * load on a session that is also live rewinds this Feed's own MetaState and the promptTurnId of
   * the live frames that follow is wrong. Registered as I2 debt; the fix is a Feed per load rather
   * than a comment.
   */
  replayLoad(events: EventEnvelope[]): void {
    for (const e of events) if (LOADABLE.includes(e.type)) this.onEvent(e, { replay: true })
  }
}

// Feed maps whose connection has closed. A request still running then must not subscribe again.
const closedFeeds = new WeakSet<Map<string, Feed>>()

/** Releases every subscription one connection's Feeds hold; called when that connection closes. */
export function disposeFeeds(feeds: Map<string, Feed>): void {
  closedFeeds.add(feeds)
  for (const f of feeds.values()) f.dispose()
  feeds.clear()
}

/**
 * How a failure to open a session reaches the wire. A profile with no provider route at all - a home
 * nobody has run `agh config` in - refuses with E_PRESET_UNRESOLVED/no-routes; that is the caller's
 * configuration, not a daemon fault, so it is answered as SEMANTIC_REJECTED/PROVIDER_UNCONFIGURED
 * instead of INTERNAL. The worker may drop `detail` but keeps a whitelist `reason` identifier.
 */
export function throwSessionOpenRpcError(error: unknown): never {
  const e = error as { code?: unknown; reason?: unknown; detail?: { reason?: unknown } } | null
  // A ledger holding a row type this build no longer knows was written by an older build; it fails
  // closed, and the caller is told so rather than handed an internal error.
  if (e?.code === 'E_UNKNOWN_EVENT') throw legacyLedgerRpcError()
  // The reverse: a newer build wrote it in a format this one does not read. Nothing was changed.
  if (isNewerLedgerFormat(error)) throw newerLedgerRpcError()
  const refusal = ledgerIntegrityRefusal(error)
  if (refusal) throw refusal
  if (e?.code === 'E_PRESET_UNRESOLVED' && (e.reason ?? e.detail?.reason) === 'no-routes')
    throw rpcError('SEMANTIC_REJECTED', {
      code: 'PROVIDER_UNCONFIGURED',
      reason: 'the profile declares no provider routes',
    })
  throwWorkspaceRpcError(error)
}

/** The refusal for a session whose stored history failed its integrity check: it stays refused. */
export function ledgerIntegrityRpcError(): RpcError {
  return rpcError('SEMANTIC_REJECTED', { code: 'E_LEDGER_INTEGRITY', reason: 'ledger-integrity' })
}

/**
 * The one mapping of a history that failed its integrity check, whatever reached it first (an open, a
 * read, a projection, a write, a run's outcome, in process or forwarded by a worker): its typed
 * refusal, or undefined for any other error. Callers throw `ledgerIntegrityRefusal(e) ?? e`.
 */
export function ledgerIntegrityRefusal(error: unknown): RpcError | undefined {
  return (error as { code?: unknown } | null)?.code === 'E_LEDGER_INTEGRITY'
    ? ledgerIntegrityRpcError()
    : undefined
}

const ATTACHMENT_REFUSALS: ReadonlySet<string> = new Set(ATTACHMENT_REFUSAL_CODES)

/**
 * The one mapping of an input refused because of its attachments (not uploaded to this session, no
 * longer stored, malformed, too large, over a quota): SEMANTIC_REJECTED with the refusal's code, or
 * undefined for any other error. Core names the refusal in `detail.reason`; a worker forwards it as
 * `reason`, the only part of the detail that crosses the boundary.
 */
export function attachmentRefusal(error: unknown): RpcError | undefined {
  const e = error as { code?: unknown; reason?: unknown; detail?: { reason?: unknown } } | null
  if (e?.code !== 'E_ENVELOPE') return undefined
  const reason = e.reason ?? e.detail?.reason
  if (typeof reason !== 'string') return undefined
  const code = reason.toUpperCase().replaceAll('-', '_')
  return ATTACHMENT_REFUSALS.has(code) ? rpcError('SEMANTIC_REJECTED', { code, reason }) : undefined
}

/** The refusal for a session whose ledger an older build wrote in a format this one cannot read. */
export function legacyLedgerRpcError(): RpcError {
  return rpcError('SEMANTIC_REJECTED', { code: 'LEGACY_LEDGER_FORMAT', reason: 'legacy-ledger-format' })
}

/**
 * A session ledger in a newer format. Core marks it with a `reason` because E_FORMAT alone also
 * means a newer child-control format; a worker forwards the reason and drops the rest of detail.
 */
export function isNewerLedgerFormat(error: unknown): boolean {
  const e = error as { code?: unknown; reason?: unknown; detail?: { reason?: unknown } } | null
  return e?.code === 'E_FORMAT' && (e.reason ?? e.detail?.reason) === 'newer-ledger-format'
}

/** The refusal for a session a newer build wrote in a ledger format this one does not read; upgrade. */
export function newerLedgerRpcError(): RpcError {
  return rpcError('SEMANTIC_REJECTED', { code: 'NEWER_LEDGER_FORMAT', reason: 'newer-ledger-format' })
}

type LoadingProgress = { phase: 'open' | 'verify' | 'fold' | 'replay'; done: number; total: number }
/** A loading client hears something at least this often while the session opens. */
const LOADING_HEARTBEAT_MS = 5_000
const OPEN_HEARTBEAT: LoadingProgress = { phase: 'open', done: 0, total: 0 }

export function registerAcp(
  ep: LocalEndpoint,
  cx: LocalContext,
  feeds: Map<string, Feed>,
  attached: Map<string, AttachedFeed>,
): void {
  const denyOwnership = (method: string, sessionId: string): never => {
    throw rpcError('CAPABILITY_DENIED', { method, sessionId, reason: 'session owner unavailable' })
  }
  const requireOwner = (method: string, sessionId: string): void => {
    try {
      if (cx.sessionOwnership?.resolve(sessionId)?.principalId === ep.conn.principalId) return
    } catch {
      // Storage failure, missing ownership, and cross-principal access share one fixed denial.
    }
    denyOwnership(method, sessionId)
  }
  // When this connection was last told how a session's load is going: one notice a second at most,
  // and a heartbeat only once nothing else has been said for a while.
  const loadingSentAt = new Map<string, number>()
  const loadingNotifier =
    (sessionId: string) =>
    (progress: LoadingProgress, heartbeat = false): void => {
      const now = cx.clock()
      const last = loadingSentAt.get(sessionId)
      if (last !== undefined) {
        const quiet = now - last
        // The notice that ends a phase always goes, so a client sees 100% before the next phase.
        const ends = progress.phase !== 'open' && progress.done >= progress.total
        if (heartbeat ? quiet < LOADING_HEARTBEAT_MS - 1_000 : quiet < 1_000 && !ends) return
      }
      loadingSentAt.set(sessionId, now)
      try {
        ep.push(notify('_agnes/v1/session.loading', { sessionId, ...progress }))
      } catch {
        /* a progress notice must not fail the load it describes */
      }
    }
  const feedFor = (entry: SessionEntry): Feed => {
    // Nobody is left to push to: hand back a Feed that subscribes to nothing and never makes a
    // prompt wait for rows.
    if (closedFeeds.has(feeds))
      return Object.assign(new Feed(ep, entry, () => undefined), { lastPushed: Number.POSITIVE_INFINITY })
    const known = feeds.get(entry.key)
    if (known?.belongsTo(entry)) return known
    const f = new Feed(
      ep,
      entry,
      () => ep.conn.attached.get(entry.key),
      () => cx.registry.previewSnapshot(entry.key),
    )
    const offEvents = cx.registry.subscribe(entry.key, (e) => {
      // Two sinks, one event, written as two statements. Reaching for a nullish fallback between
      // them - an optional call on the left, a plain call on the right - runs both sides regardless,
      // because onEvent returns undefined, while reading as if only one of them runs. The ACP feed
      // decides for itself whether the connection asked for projections; the attached feed decides
      // for itself about raw rows. boundary.test.ts refuses that shape outright.
      attached.get(entry.key)?.onEvent(e)
      f.onEvent(e)
    })
    let offPreview: () => void
    try {
      offPreview = cx.registry.subscribePreview(
        entry.key,
        (p) => {
          attached.get(entry.key)?.onPreview(p)
          f.onPreview(p)
        },
        () => {
          attached.get(entry.key)?.previewResync()
          f.previewResync()
        },
      )
    } catch (error) {
      offEvents()
      throw error
    }
    f.dispose = () => {
      offEvents()
      offPreview()
      f.closePreview()
    }
    // Only once the new subscription exists: a failed subscribe leaves the old one in place. A
    // replaced entry keeps its listener set, so without this the connection would listen twice.
    known?.dispose()
    feeds.set(entry.key, f)
    // An inference may already be streaming when this Feed starts listening.
    f.previewResync()
    return f
  }
  // Previews refused under pressure are made good once the connection's queue has drained.
  const continueFollowUps = createFollowUpRunner(cx, (entry, seq) =>
    feedFor(entry).pushed(seq, { timeoutMs: cx.quiescenceWaitMs }),
  )
  cx.continueFollowUps = continueFollowUps
  ep.onPreviewLowWater(() => {
    for (const a of attached.values()) a.previewLowWater()
    for (const f of feeds.values()) f.previewLowWater()
  })

  const initialize: Handler = async (params, c) => {
    c.conn.initialized = true
    // Capabilities travel in clientCapabilities._meta, which is where sdk writes them. params._meta
    // is InitializeMeta { auth?, clientId? } with additionalProperties:false - it has no capabilities
    // key, and reading one from there leaves permission false for every client there is.
    const declared = pocket((params as { clientCapabilities?: unknown }).clientCapabilities).capabilities as
      | { permission?: boolean; attachmentRefs?: unknown }
      | undefined
    c.conn.capabilities.permission = declared?.permission === true
    c.conn.capabilities.attachmentRefs = declared?.attachmentRefs === 1
    // A label, not an identity: it never becomes principalId, and nothing buckets on it. authGate
    // has already set it from this same pocket before this handler ever runs; setting it again here
    // is a no-op on the credentialed path and the only path that reaches it when there is no gate.
    const clientId = pocket(params).clientId
    if (typeof clientId === 'string') c.conn.clientId = clientId
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      _meta: { agnes: { agnesVersion: cx.agnesVersion, apis: 'call apis.list', attachmentRefs: 1 } },
    }
  }
  // Credential verification runs before anything else `initialize` does: a failing auth.kind never
  // reaches this handler at all, so `conn.initialized` stays false and every other method keeps
  // refusing NOT_INITIALIZED.
  ep.register('initialize', authGate(ep, cx.auth, initialize))

  ep.register('authenticate', async () => ({}))

  ep.register('session/new', async (params, c) => {
    const p = params as { cwd: string; mcpServers: unknown[] }
    if (p.mcpServers.length > 0) throw rpcError('SEMANTIC_REJECTED', { reason: 'mcpServers must be empty' })
    if (
      cx.auth.config.transport === 'ws' &&
      cx.auth.config.localWeb !== true &&
      cx.sessionCredentialAuthority !== true
    )
      throw rpcError('CAPABILITY_DENIED', {
        method: 'session/new',
        reason: 'remote session actor authority unavailable',
      })
    const h = pocket(params)
    const preset = typeof h.preset === 'string' ? h.preset : undefined
    if (preset && !cx.host.profile.presets.allowed.includes(preset))
      throw rpcError('PRESET_SWITCH_REJECTED', {
        reason: 'not in presets.allowed',
        cause: 'not-allowed',
        preset,
      })
    let entry: SessionEntry
    let workspace: Awaited<ReturnType<WorkspaceCatalog['validate']>>
    try {
      workspace = await cx.workspaces.validate(p.cwd)
    } catch (error) {
      throwWorkspaceRpcError(error)
    }
    const requestedKey =
      typeof h.sessionKey === 'string'
        ? h.sessionKey
        : canonicalSessionKey(
            cx.host.profile,
            await cx.resolveNewSessionActor(c.conn.credential, 'session'),
            workspace.path,
          )
    const hasSessionFact =
      cx.registry.get(requestedKey) !== undefined ||
      cx.workspaces.sessionPath(requestedKey) !== undefined ||
      cx.hasSessionFact?.(requestedKey) === true
    const ownership = cx.sessionOwnership
    if (!ownership) return denyOwnership('session/new', requestedKey)
    let reservedNew = false
    let binding: Awaited<ReturnType<WorkspaceCatalog['authorizeAndBind']>>
    try {
      const reserved = await reserveOwnedSession({
        ownership,
        workspaces: cx.workspaces,
        principalId: c.conn.principalId,
        sessionKey: requestedKey,
        canonicalRoot: workspace.path,
        hasSessionFact,
      })
      reservedNew = reserved.reservedNew
      binding = reserved.envelope
    } catch (error) {
      if (error instanceof SessionAdmissionDenied) denyOwnership('session/new', requestedKey)
      throwSessionOpenRpcError(error)
    }
    try {
      entry = await cx.registry.open({
        cwd: binding.canonicalRoot,
        binding,
        ...(preset ? { preset } : {}),
        key: requestedKey,
        ...(c.conn.credential === undefined ? {} : { credential: c.conn.credential }),
      })
      if (reservedNew && !ownership.activateNew(entry.key, c.conn.principalId))
        denyOwnership('session/new', requestedKey)
    } catch (error) {
      throwSessionOpenRpcError(error)
    }
    feedFor(entry)
    return { sessionId: entry.key }
  })

  ep.register('session/load', async (params) => {
    const p = params as { sessionId: string; cwd: string }
    requireOwner('session/load', p.sessionId)
    const loading = loadingNotifier(p.sessionId)
    // The registry relays the worker's own progress; the heartbeat covers a registry that has none
    // and any stretch the worker or the replay goes quiet, so the client can tell slow from stuck.
    const offProgress = cx.registry.onOpenProgress?.(p.sessionId, (progress) => loading(progress))
    const heartbeat = setInterval(() => loading(OPEN_HEARTBEAT, true), 1_000)
    try {
      let entry = cx.registry.get(p.sessionId)
      const loadStartedAt = performance.now()
      try {
        const binding = await cx.workspaces.restoreBinding(p.sessionId, p.cwd || undefined)
        // Calling open for a live entry is intentional: both registries must reject a different
        // authority binding rather than ignoring it until the next restart.
        entry = await cx.registry.open({
          key: p.sessionId,
          cwd: binding.canonicalRoot,
          binding,
          resume: true,
        } as Parameters<typeof cx.registry.open>[0])
      } catch (error) {
        cx.registry.recordLoadFailed?.(p.sessionId, { elapsedMs: performance.now() - loadStartedAt, error })
        throwSessionOpenRpcError(error)
      } finally {
        offProgress?.()
      }
      if (!entry) throw rpcError('SESSION_NOT_FOUND', { sessionId: p.sessionId })
      const feed = feedFor(entry)
      // Paged and bounded: core refuses an unbounded scan (E_SCAN_UNBOUNDED), and a single page would
      // silently truncate a long transcript at whatever limit was written here.
      const lastSeq = entry.session.lastSeq
      const replayStartedAt = performance.now()
      try {
        for (let from = 1; from <= lastSeq; from += 500) {
          const upto = Math.min(lastSeq, from + 499)
          feed.replayLoad(
            (await entry.session.scan({ fromSeq: from, toSeq: upto, limit: 500 })) as EventEnvelope[],
          )
          loading({ phase: 'replay', done: upto, total: lastSeq })
        }
      } catch (error) {
        // The background verification of a history opened from a checkpoint can fail mid-replay; the
        // load is then refused with the same typed code as an open that failed it.
        throw ledgerIntegrityRefusal(error) ?? error
      }
      cx.registry.recordLoad?.(p.sessionId, { acpReplayMs: performance.now() - replayStartedAt })
      // Whatever is streaming now is not in the transcript yet; the snapshot says it.
      feed.previewResync()
      return {}
    } finally {
      clearInterval(heartbeat)
      offProgress?.()
      loadingSentAt.delete(p.sessionId)
    }
  })

  ep.register('session/prompt', async (params, c) => {
    const p = params as { sessionId: string; prompt: unknown[] }
    requireOwner('session/prompt', p.sessionId)
    let content: ReturnType<typeof fromAcpPrompt>
    try {
      content = fromAcpPrompt(p.prompt)
    } catch {
      throw rpcError('INVALID_PARAMS', { reason: 'Invalid attachment resource or locator.' })
    }
    const entry = cx.registry.require(p.sessionId)
    const titleLocale = pocket(params).titleLocale
    if (titleLocale !== undefined && titleLocale !== 'en' && titleLocale !== 'zh-CN')
      throw rpcError('SEMANTIC_REJECTED', { reason: 'unsupported title language' })
    const abort = new AbortController()
    let completed = false
    let queued: QueuedActivationInvocation
    try {
      queued = cx.activationBarrier.enqueue('turn')
    } catch (error) {
      if (error instanceof ActivationInProgressError)
        throw rpcError('OVERLOADED', {
          reason: error.reason,
          operationId: error.operationId,
          retryAfterMs: 500,
        })
      throw error
    }
    if (entry.inflight) {
      queued.cancel()
      throw rpcError('SESSION_BUSY', { sessionId: p.sessionId })
    }
    entry.inflight = { promptId: 'prompt', abort }
    cx.onPromptStart?.(p.sessionId)
    try {
      let running: ReturnType<typeof entry.session.run> | undefined
      await runQueued(cx.commandQueue, p.sessionId, abort.signal, async () => {
        const invocation = await queued.start()
        try {
          const commandId = randomUUID()
          await entry.session.enqueue('next-turn', {
            content,
            actor: connActor(c.conn),
            kind: 'prompt',
            commandId,
            ...(titleLocale ? { titleLocale } : {}),
          })
          running = invocation.run(async () => {
            for (;;) {
              const out = await entry.session.run({ until: 'turn-end', signal: abort.signal })
              if (out.reason !== 'completed') return out
              const [row] = await entry.session.scan({ type: 'inbox', order: 'desc', limit: 1, lane: 'main' })
              // Older queued inputs can precede this prompt. Only its own claimed item ends the call.
              if (!(row?.data as Inbox)?.items.some((item) => item.commandId === commandId)) return out
              if (abort.signal.aborted) return { ...out, reason: 'aborted' as const }
            }
          })
        } catch (error) {
          invocation.finish()
          throw error
        }
      })
      if (!running) throw rpcError('INTERNAL_ERROR', { code: 'RUN_NOT_STARTED' })
      const out = await running
      completed = out.reason === 'completed'
      // Not before terminalQuiescence: the response is the turn's last word to this client.
      await feedFor(entry).pushed(out.lastSeq, { timeoutMs: cx.quiescenceWaitMs })
      // A run that stopped because the history failed verification is refused as that, not as a fault.
      const refused = out.reason === 'error' ? ledgerIntegrityRefusal(out.error) : undefined
      if (refused) throw refused
      if (out.reason === 'error')
        throw rpcError('INTERNAL_ERROR', {
          code: 'TURN_ERROR',
          turnEnd: { reason: 'error' },
          error: out.error,
        })
      return {
        stopReason: toAcpStopReason(out.reason as Exclude<TurnEndReason, 'error'>),
        _meta: { [HARNESS]: { phase: 'terminalQuiescence', turnEnd: { reason: out.reason } } },
      }
    } catch (error) {
      // The prompt's own input is refused the same way once the history failed verification, and with
      // its typed code when an attachment was refused.
      throw ledgerIntegrityRefusal(error) ?? attachmentRefusal(error) ?? error
    } finally {
      queued.cancel()
      const followUps =
        entry.inflight?.abort === abort &&
        completed &&
        !abort.signal.aborted &&
        (await runQueued(cx.commandQueue, p.sessionId, new AbortController().signal, async () => {
          const [row] = await entry.session.scan({ type: 'inbox', order: 'desc', limit: 1, lane: 'main' })
          return (
            (row?.data as { items?: Array<{ target: string; kind?: string }> } | null)?.items?.find(
              (item) => item.target === 'next-turn',
            )?.kind === 'follow_up'
          )
        }).catch(() => false))
      if (entry.inflight?.abort !== abort) {
        // An explicit send-now transferred this session's activity to a fresh runner.
      } else if (followUps && entry.inflight) continueFollowUps(entry, entry.inflight)
      else {
        entry.inflight = null
        cx.onPromptEnd?.(p.sessionId)
      }
    }
  })

  ep.register('session/cancel', async (params) => {
    const sessionId = (params as { sessionId: string }).sessionId
    requireOwner('session/cancel', sessionId)
    const e = cx.registry.get(sessionId)
    e?.inflight?.abort.abort()
  })

  // `modeId` is ACP's name for what this package calls a preset; `session/set_mode` is the one
  // reachable surface this deployment has for a preset switch today - `_agnes/v1/session.setPreset`
  // has no protocol schema yet (see `mapCore`'s doc comment in methods/agnes.ts). The validated-gate
  // shape is the same one that method would use: never hand the client-supplied name straight to
  // `session.setPreset()` without going through `cx.host.validatePresetSwitch()` first, so a switch
  // can never land on a preset this deployment did not mean to expose (minimal-rl, an unresolvable
  // name, a hard requirement this assembly cannot satisfy).
  ep.register('session/set_mode', async (params) => {
    const p = params as { sessionId: string; modeId: string }
    requireOwner('session/set_mode', p.sessionId)
    const entry = cx.registry.require(p.sessionId)
    try {
      const resolved = cx.host.validatePresetSwitch(p.modeId)
      await runQueued(cx.commandQueue, p.sessionId, new AbortController().signal, async () => {
        await entry.session.setPreset(resolved.view)
      })
      return {}
    } catch (e) {
      return mapCore(e)
    }
  })
}
