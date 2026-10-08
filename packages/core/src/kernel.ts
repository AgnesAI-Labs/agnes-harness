import { hasChildControl } from '@agnes/core-child-control/child/store'
import { isActiveChildState } from '@agnes/core-child-control/child/types'
import { defaultIds } from '@agnes/core-common/ids'
import { LEGACY_LOOP, LoopRegistry, loopKey } from '@agnes/core-common/loop/registry'
import type { PresetView } from '@agnes/core-common/step/preset'
import { type Clock, CoreError, type IdMinter, type Seq, type SessionKey } from '@agnes/core-common/types'
import { assertFsEnforces } from '@agnes/core-effects/effects/fs-guard'
import { platformFacts } from '@agnes/core-effects/effects/platform-facts'
import { SEAM_NAMES, type SeamImplementations } from '@agnes/core-effects/effects/seams'
import type { ChildrenFactory, FsOps, ToolContextDeps } from '@agnes/core-effects/effects/tool-context'
import type { HostToolDispatchPort } from '@agnes/core-effects/effects/tool-dispatch'
import { ToolPolicyRegistry, ToolRuntimeRegistry } from '@agnes/core-effects/effects/tool-providers'
import { SeamRuntime } from '@agnes/core-effects/effects/wrap'
import type {
  ChildWorkspaceRuntimePort,
  SessionWorkspaceLifecycle,
  SessionWorkspaceRuntime,
  WorkspaceInvocationPort,
} from '@agnes/core-effects/workspace/runtime'
import { CORE_CHECKS } from '@agnes/core-ledger/invariants/core-checks'
import { InvariantRegistry } from '@agnes/core-ledger/invariants/registry'
import { forkPaths } from '@agnes/core-ledger/log/fork-seed'
import type { Timers } from '@agnes/core-ledger/log/session-log'
import type { StorageAdapter } from '@agnes/core-ledger/log/storage'
import { ProjectionRegistry } from '@agnes/core-ledger/project/named'
import { openTracked } from '@agnes/core-ledger/reduce/tracker'
import type {
  ChildAgentParentScope,
  ChildAgentSessionService,
  HookContext,
  Logger,
  LoopEventRegistryPort,
  LoopFactory,
  LoopRegistryPort,
  LoopSelection,
  PlatformFacts,
  ToolPolicyRegistryPort,
  ToolRuntimeRegistryPort,
} from '@agnes/extension-api'
import { ProviderError } from '@agnes/extension-api'
import type { Actor, ApprovalMode, Provider, SessionStart } from '@agnes/protocol'
import { KernelChildren } from './child/factory.js'
import { bindChildFactory } from './child/sessions.js'
import { bindChildSessionToolFilter, ChildToolRegistry } from './child/tool-filter.js'
import { type DispatchContext, HookEngine } from './hooks/engine.js'
import { LoopEventRegistry } from './loop/events.js'
import { HookRegistry } from './registry/hooks.js'
import { ResourceRegistry } from './registry/resources.js'
import { SlotRegistry } from './registry/slots.js'
import { ToolRegistry } from './registry/tools.js'
import type { ContractRef } from './request/derive.js'
import type { CurrentRuntimeLookup, RuntimePromptPreloader } from './runtime/current.js'
import { CORE_OPS, type CoreOpName, replacementFor, validateReplacements } from './step/reentry.js'
import {
  type CompactionPort,
  type HookPort,
  noopHooks,
  type Operation,
  type ReplacementOperation,
  type SessionDeps,
  SessionImpl,
} from './step/session.js'

/**
 * The closed set of `x/core/*` diagnostic names. Five of them are written outside this file:
 * `registers-rebuilt` by the materialization check on open, `contribute-conflict`,
 * `context-breakdown` and `request-media-window` by the inference segment, plus
 * `manual-compaction` by the explicit session operation. A name missing from here stops `diag`
 * compiling at its call site, which is the point of closing the set rather than accepting any string.
 */
export const CORE_DIAG_NAMES = [
  'projection-failed',
  'seam-failed',
  'hook-failed',
  'hook-context-overflow',
  'hook-compact-plan-ignored',
  'hook-quota',
  'operation-failed',
  'compaction-failed',
  'manual-compaction',
  'approval-callback-rejected',
  'invariant',
  'preset-switch',
  'refine-rollback',
  'budget-recount',
  'child-interrupted',
  'resume-closed',
  'ledger-tail-recovered',
  'tool-missing-on-resume',
  'tool-policy-refused-on-resume',
  'registers-rebuilt',
  'contribute-conflict',
  'context-breakdown',
  'request-media-window',
] as const
export type CoreDiagName = (typeof CORE_DIAG_NAMES)[number]

export type KernelOptions = {
  systemPrompt?: SessionOptions['systemPrompt']
  /** Host binds public child providers to Core-minted parent facts. */
  loopChildren?: (parent: ChildAgentParentScope) => ChildAgentSessionService
  toolRuntimes?: ToolRuntimeRegistryPort
  toolPolicies?: ToolPolicyRegistryPort
  loopEvents?: LoopEventRegistryPort
  loops?: LoopRegistryPort
  loop?: LoopSelection
  storage: StorageAdapter
  seams: SeamImplementations
  provider: Provider
  withModelSnapshot?: <T>(operation: () => Promise<T>) => Promise<T>
  operations?: Operation[]
  contract: ContractRef
  contractForModel?: (target: { route: string; model: string }) => ContractRef
  preset: PresetView
  children?: ChildrenFactory
  /**
   * Host admission for a spawned child's run. The run outlives the tool call that started it, so
   * the Host admits it as its own turn; without this port it runs unadmitted.
   */
  detachedChildRun?: <T>(run: () => Promise<T>) => Promise<T>
  hooks?: HookPort
  /** The engine is session-owned but reads the Kernel's shared registration table. */
  hooksFactory?: (session: SessionImpl, hooks: HookEngine) => HookPort
  /** Host-owned dynamic lease lookup for callbacks registered after Kernel construction. */
  hookLeaseFor?: (source: string) => HookContext['lease'] | undefined
  /** Retains only Host-minted SessionRef capabilities by exact object identity. */
  retainSessionRefIdentity?: (session: HookContext['session']) => boolean
  /**
   * A Host-only request contribution. Core calls it with the current accepted prompt immediately
   * before request assembly; unlike an extension hook, no extension receives that raw prompt.
   */
  runtimePromptPreloader?: RuntimePromptPreloader
  /** Host-owned lookup of the generation currently published for an open session. */
  currentRuntime?: CurrentRuntimeLookup
  /** Host-owned overlay apply. Core setPreset calls this and never talks to Cordis. */
  sessionOverlay?: import('./runtime/overlay.js').SessionOverlayPort
  compaction?: CompactionPort
  clock?: Clock
  ids?: IdMinter
  timers?: Timers
  fsOps: FsOps
  /** Host selects one session-pinned memory provider; omission preserves deployments without it. */
  memoryFor?: (input: {
    key: string
    cwd: string
  }) => import('@agnes/extension-api').MemorySession | undefined
  netFetch: ToolContextDeps['netFetch']
  publicFetch?: ToolContextDeps['publicFetch']
  /** Trusted resolved profile approval mode; only trusted profile resolution may set `off`. */
  approvalMode?: ApprovalMode
  /** Host-private dispatch attestation; extensions never receive this port. */
  hostToolDispatch?: HostToolDispatchPort
  /** Host-private artifact/media ports; auxiliary admission remains a non-root Core capability. */
  requestMedia?: SessionDeps['requestMedia']
  /** Host-owned whole-wire image token bound used only when the provider cannot count images. */
  imageInputTokenFallback?: SessionDeps['imageInputTokenFallback']
  logger?: Logger
  agnesVersion?: string
  leaseTtlMs?: number
  /** Shared reconcile gate handed to every session this Kernel assembles, including descendants. */
  quiet?: NonNullable<SessionImpl['d']['quiet']>
  /** Host publication admission shared by every session and descendant. */
  workspacePublication?: NonNullable<SessionImpl['d']['workspacePublication']>
}
export type { RuntimePromptPreload } from './runtime/current.js'
export type SessionOptions = {
  systemPrompt?: {
    config: () => Promise<import('@agnes/protocol').SystemPromptConfig>
    resolve(selection?: { id: string; version: string }): import('@agnes/extension-api').SystemPromptProvider
  }
  toolFilter?: import('@agnes/extension-api').ChildAgentToolFilter
  loop?: LoopSelection
  /** Host defaults affect new sessions only; reopening uses the ledger identity. */
  defaultLoop?: LoopSelection | (() => Promise<LoopSelection | undefined>)
  actor: Actor
  preset?: PresetView
  resolvedProfileHash: string | null
  seams?: Partial<SeamImplementations>
  cwd: string
  writerRunId: string
  lane?: string
  /** Host runtime identity carried unchanged into the assembled session. */
  workspaceRuntime?: SessionWorkspaceRuntime
  /** Safe authority identity retained after the raw workspace runtime is consumed. */
  workspaceIdentity?: import('@agnes/core-effects/workspace/runtime').WorkspaceSessionIdentity
  /** Sole invocation lease owner for every workspace capability used by this session. */
  workspaceInvocation?: WorkspaceInvocationPort
  /** Unique Host-owned close delegate for this session's runtime. */
  workspaceLease?: SessionWorkspaceLifecycle
  /** Host reservation port inherited by descendants opened by the default child factory. */
  childWorkspaceRuntime?: ChildWorkspaceRuntimePort
  /** A same-Kernel immutable prefix used by the default child-session factory. */
  parent?: { key: SessionKey; boundarySeq: Seq }
  /**
   * A new session opens without dispatching `session_start`, so nothing lands after its session/start
   * before the caller writes. For an importer filling the ledger verbatim: native rows point at each
   * other by sequence number. A resumed session ignores this and gets its hooks as always.
   */
  skipSessionStartHooks?: boolean
  /** Written into a new session's session/start; an importer's record of where the ledger came from. */
  imported?: SessionStart['imported']
  delegation?: {
    kind: 'fork' | 'spawn'
    creationId: string
    rootTaskId: string
    generationDepth: number
  }
}

const NO_LOG: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
// A far-future, unbounded grant. The `lease` field on HookContext exists for turn-scoped events
// (tool_call, before_step, ...) where an extension's remaining execution budget is meaningful; the
// three lifecycle events dispatched below (session_start / resources_discover / shutdown) share the
// same context shape without sharing that meaning, so they get a permissive stand-in rather than a
// real per-extension grant.
const NO_LEASE: HookContext['lease'] = Object.freeze({
  expiresAt: '9999-12-31T23:59:59.999Z',
  scope: Object.freeze({}),
  budget: Object.freeze({ remaining: Number.MAX_SAFE_INTEGER }),
})

/**
 * Kernel-level lifecycle events are dispatched once per session open/close, never inside a running
 * turn, so they get a fresh signal rather than a turn's `AbortController` — there is no in-flight
 * work for them to inherit cancellation from, and reusing a session's turn signal would risk handing
 * an already-aborted one to `shutdown` (which fires after the session's own controller is aborted).
 */
function lifecycleContext(session: SessionImpl, logger: Logger, replayed: boolean): DispatchContext {
  return {
    session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
    replayed,
    signal: new AbortController().signal,
    lease: NO_LEASE,
    log: logger,
  }
}

/** Default owner for registry-backed lifecycle hooks when no richer per-session port is fitted. */
function lifecyclePort(session: SessionImpl, hooks: HookEngine, logger: Logger): HookPort {
  return {
    ...noopHooks,
    async sessionStart(payload) {
      const replayed = payload.reason === 'resume'
      await hooks.dispatch('session_start', () => payload, lifecycleContext(session, logger, replayed))
      if (replayed)
        await hooks.dispatch(
          'resources_discover',
          () => ({
            actor: session.d.actor,
            cwd: payload.cwd,
            registered: session
              .currentResources()
              .snapshot()
              .map((record) => record.entry),
          }),
          lifecycleContext(session, logger, true),
        )
    },
    async shutdown() {
      await hooks.dispatch('shutdown', () => ({ reason: 'close' }), lifecycleContext(session, logger, false))
    },
    async subagentStart(payload) {
      await hooks.dispatch('subagent_start', () => payload, lifecycleContext(session, logger, false))
    },
    async subagentEnd(payload) {
      await hooks.dispatch('subagent_end', () => payload, lifecycleContext(session, logger, false))
    },
  }
}

/** The composition root: it fits the seams, opens ledgers, and hands back assembled sessions. */
export class Kernel {
  readonly toolRuntimes: ToolRuntimeRegistryPort
  readonly toolPolicies: ToolPolicyRegistryPort
  readonly loopEvents: LoopEventRegistryPort
  readonly loops: LoopRegistryPort
  readonly tools = new ToolRegistry()
  readonly sessions = new Map<SessionKey, SessionImpl>()
  readonly clock: Clock
  readonly ids: IdMinter
  // Computed once from the fitted seam at construction; every session's hook engine reuses it.
  private readonly platform: PlatformFacts
  readonly hooks: HookEngine
  readonly invariants: InvariantRegistry
  readonly projections = new ProjectionRegistry()
  readonly slots = new SlotRegistry()
  readonly resources = new ResourceRegistry()
  // Held separately from `hooks` because `HookEngine` does not expose the underlying registry's
  // `registrations(source)` — it only re-exposes `on`/`snapshot`/`resetTurn`/`dispatch`. Keeping this
  // reference lets `Kernel.registrations()` aggregate hook ownership without adding a pass-through
  // method to a file outside this task's scope (`hooks/engine.ts`).
  private readonly hookRegistry = new HookRegistry()
  private readonly factoryHooks = new WeakSet<HookPort>()

  private constructor(readonly o: KernelOptions) {
    this.toolRuntimes = o.toolRuntimes ?? new ToolRuntimeRegistry()
    this.toolPolicies = o.toolPolicies ?? new ToolPolicyRegistry()
    this.loopEvents = o.loopEvents ?? new LoopEventRegistry()
    this.loops = o.loops ?? new LoopRegistry()
    this.clock = o.clock ?? (() => Date.now())
    this.ids = o.ids ?? defaultIds(this.clock)
    const logger = o.logger ?? NO_LOG
    this.platform = platformFacts(o.seams.platform)
    this.hooks = this.createHookEngine(logger, o.preset)
    this.invariants = new InvariantRegistry()
    this.invariants.register('@agnes/core', CORE_CHECKS)
    this.invariants.mode =
      o.preset.telemetry.invariants === 'strict' ? 'strict' : o.preset.telemetry.invariants ? 'on' : 'off'
  }

  /** Scheduling and quota are per session; only immutable registration ownership is shared. */
  private createHookEngine(logger: Logger, preset: PresetView): HookEngine {
    return new HookEngine(
      {
        onFailure: (failure) => logger.warn('hook failed', failure as never),
        diag: (name, data) => {
          logger.warn(`x/core/${name}`, data as never)
        },
        eventsPerTurn: preset.ext.eventsPerTurn,
        platform: this.platform,
        ...(this.o.hookLeaseFor ? { leaseFor: this.o.hookLeaseFor } : {}),
        ...(this.o.retainSessionRefIdentity
          ? { retainSessionRefIdentity: this.o.retainSessionRefIdentity }
          : {}),
      },
      this.hookRegistry,
    )
  }

  /**
   * Fails closed on a missing seam rather than substituting a default. A default approval seam is
   * one that says yes, and a default ledger is one that bills nothing: the absence of an
   * implementation is a deployment that has not decided, not a deployment that decided to allow.
   */
  static create(o: KernelOptions): Kernel {
    if (o.hooks && o.hooksFactory) throw new CoreError('E_ENVELOPE', 'choose hooks or hooksFactory')
    for (const name of SEAM_NAMES)
      if (!o.seams[name] || typeof o.seams[name] !== 'object') throw new CoreError('E_SEAM_MISSING', name)
    validateReplacements(o.operations ?? [])
    return new Kernel(o)
  }

  get(key: SessionKey): SessionImpl | undefined {
    return this.sessions.get(key)
  }

  /** Clear per-session seam decisions after the Host publishes a new dynamic seam provider. */
  invalidateSeams(): void {
    for (const session of this.sessions.values()) session.d.runtime.invalidate()
  }

  /** All Core-owned registrations, for complete owner cleanup verification. */
  registrations(source: string): string[] {
    return [
      ...this.tools.registrations(source),
      ...this.hookRegistry.registrations(source),
      ...this.slots.registrations(source),
      ...this.resources.registrations(source),
      ...this.projections.registrations(source),
    ]
  }

  private readonly construction = new AbortController()
  private readonly creating = new Set<Promise<SessionImpl>>()
  private closing?: Promise<void>

  session(key: SessionKey, so: SessionOptions): Promise<SessionImpl> {
    if (this.construction.signal.aborted) return Promise.reject(new CoreError('E_CLOSED', 'kernel closed'))
    const creating = this.openSession(key, so)
    this.creating.add(creating)
    void creating.then(
      () => this.creating.delete(creating),
      () => this.creating.delete(creating),
    )
    return creating
  }

  private async openSession(key: SessionKey, so: SessionOptions): Promise<SessionImpl> {
    const preset = so.preset ?? this.o.preset
    const lane = so.lane ?? 'main'
    let existing = this.sessions.get(key)
    if (existing?.closingOrClosed) {
      // Wait for shutdown and lease release; failed cleanup must not be bypassed by reopening.
      await existing.close()
      if (this.sessions.get(key) === existing) this.sessions.delete(key)
      existing = this.sessions.get(key)
    }
    // A cached session is handed back only to a caller asking for the session it already is. The
    // key alone is not that question: `actor` is what `runtime.authorize` decides against and what
    // every `approval/asked` is derived from, so returning the cached instance to a second caller
    // silently runs that caller's work as the first caller's principal. The same holds one field
    // over for the writer lease, the working directory, the lane and the preset — a mismatch is a
    // deployment error, and it fails closed rather than resolving in the first caller's favour.
    if (existing) {
      const want = {
        actor: so.actor.id,
        role: so.actor.role,
        org: so.actor.org,
        lane,
        cwd: so.cwd,
        preset: preset.name,
        writerRunId: so.writerRunId,
        ...(so.loop ? { loop: loopKey(so.loop) } : {}),
        parentKey: so.parent?.key,
        parentBoundary: so.parent?.boundarySeq,
      }
      const have = {
        actor: existing.d.actor.id,
        role: existing.d.actor.role,
        org: existing.d.actor.org,
        lane: existing.lane,
        cwd: existing.d.cwd,
        preset: existing.preset.name,
        writerRunId: existing.writerRunId,
        ...(so.loop ? { loop: loopKey(existing.loop) } : {}),
        parentKey: existing.d.log.parent?.key,
        parentBoundary: existing.d.log.parent?.boundarySeq,
      }
      for (const [k, v] of Object.entries(want))
        if (v !== (have as Record<string, unknown>)[k])
          throw new CoreError('E_LANE_BUSY', `session ${key} is already open with a different ${k}`, {
            field: k,
          })
      // Per-session seam overrides cannot be reconciled after assembly either: the runtime is built
      // once and a second caller's overrides would simply not be fitted.
      if (so.seams && Object.keys(so.seams).length > 0)
        throw new CoreError('E_LANE_BUSY', `session ${key} is already open; seams cannot be refitted`)
      return existing
    }
    const logger = this.o.logger ?? NO_LOG
    // The one obligation core keeps now that it no longer compares paths itself: the file system a
    // session is about to be given has to refuse what the sandbox says it refuses. Checked before
    // the writer lease is taken, so a deployment that got this wrong fails at open rather than
    // holding a lease nobody can take back - and before the first tool call rather than after it.
    const fitted = { ...this.o.seams, ...(so.seams ?? {}) }
    const fsOps = so.workspaceRuntime?.fs ?? this.o.fsOps
    await assertFsEnforces(fsOps, fitted.sandbox.fsPolicy())
    let forked: Awaited<ReturnType<SessionImpl['d']['log']['forkInto']>> | undefined
    const requestedLoop = async () =>
      so.loop ??
      (typeof so.defaultLoop === 'function' ? await so.defaultLoop() : so.defaultLoop) ??
      preset.loop ??
      this.o.loop ??
      LEGACY_LOOP
    if (so.parent) {
      const selection = await requestedLoop()
      this.loops.resolve(selection)
      const parent = this.sessions.get(so.parent.key)
      if (!parent)
        throw new CoreError('E_DEPTH_EXCEEDED', `parent session ${so.parent.key} is not open`, {
          parent: so.parent.key,
        })
      forked = await parent.d.log.forkInto(so.parent.boundarySeq, key, {
        actor: so.actor,
        agnesVersion: this.o.agnesVersion ?? '0.0.0',
        preset: preset.name,
        resolvedProfileHash: so.resolvedProfileHash,
        writerRunId: so.writerRunId,
        lane,
        loop: selection,
        modelSelections: Object.entries(preset.model.id).flatMap(([slot, model]) => {
          const route = preset.model.route[slot]
          return model && route
            ? [
                {
                  slot,
                  route,
                  model,
                  ...(preset.model.thinking[slot] === undefined
                    ? {}
                    : { thinking: preset.model.thinking[slot] }),
                  ...(preset.model.contextWindow?.[slot] === undefined
                    ? {}
                    : { contextWindow: preset.model.contextWindow[slot] }),
                },
              ]
            : []
        }),
        ...(so.delegation ? { delegation: so.delegation } : {}),
      })
      const path = forkPaths.get(forked)
      forkPaths.delete(forked)
      if (path?.path === 'cold-open')
        logger.warn('delegated child opened cold', { path: path.path, reason: path.reason })
    }
    // openTracked owns the SurfaceCache: it replays the ledger into it on open and keeps it live
    // through onAppended. A second one built here would never be fed, so session.surface() would
    // report nothing and the model would never see the conversation.
    let tracked: Awaited<ReturnType<typeof openTracked>>
    try {
      tracked = await openTracked({
        storage: this.o.storage,
        key,
        writerRunId: so.writerRunId,
        ttlMs: this.o.leaseTtlMs ?? 30_000,
        ids: this.ids,
        clock: this.clock,
        lane,
        ...(forked ? { existing: forked } : {}),
        ...(this.o.timers ? { timers: this.o.timers } : {}),
      })
    } catch (error) {
      // Abandoned rather than closed: a writer whose open never finished is marked faulted before its
      // lease is handed back.
      await forked?.abandon().catch(() => undefined)
      throw error
    }
    const { log, tracker, surface, ui, registersRebuilt } = tracked
    let systemPrompt: import('./request/system-prompt.js').PinnedSystemPrompt | undefined
    let loopFactory: LoopFactory
    try {
      const promptPort = so.systemPrompt ?? this.o.systemPrompt
      const persistedPrompt = tracker.state.session?.systemPrompt
      if (persistedPrompt && !promptPort)
        throw new CoreError('E_ENVELOPE', 'pinned system prompt provider is unavailable')
      if (promptPort) {
        const parentPrompt = so.parent ? this.sessions.get(so.parent.key)?.d.systemPrompt : undefined
        const config: import('@agnes/protocol').SystemPromptConfig = tracker.state.session
          ? structuredClone(persistedPrompt?.config ?? {})
          : parentPrompt
            ? structuredClone(parentPrompt.config)
            : await promptPort.config()
        const identity =
          persistedPrompt?.provider ??
          (parentPrompt
            ? { id: parentPrompt.provider.id, version: parentPrompt.provider.version }
            : config.provider)
        systemPrompt = { config: structuredClone(config), provider: promptPort.resolve(identity) }
      }
      const selection = tracker.state.session
        ? (tracker.state.session.loop ?? LEGACY_LOOP)
        : await requestedLoop()
      try {
        loopFactory = this.loops.resolve(selection)
      } catch (error) {
        // Session opening retains its published missing-loop code; registry callers receive ProviderError.
        if (error instanceof ProviderError && error.code === 'E_PROVIDER_UNKNOWN')
          throw new CoreError('E_LOOP_MISSING', error.message, { loop: selection })
        throw error
      }
    } catch (error) {
      await log.close()
      throw error
    }
    const workspaceInvocation = so.workspaceInvocation ?? so.workspaceRuntime?.invocation
    const workspaceIdentity = so.workspaceIdentity ?? so.workspaceRuntime?.identity
    const quietGroup = so.parent ? (this.sessions.get(so.parent.key)?.d.quietGroup ?? so.parent.key) : key
    const runtime = new SeamRuntime(fitted, preset, {
      clock: this.clock,
      onFailure: (f) => logger.warn('seam failed', { ...f }),
      ...(this.o.timers ? { timers: this.o.timers } : {}),
      ...(workspaceInvocation ? { workspaceInvocation } : {}),
      ...(this.o.workspacePublication ? { workspacePublication: this.o.workspacePublication } : {}),
    })
    // The Operation, if any, standing in for each of core's own named step-machine segments. Built
    // once per session here (rather than read fresh by whatever eventually dispatches on it) because
    // `this.o.operations` is a Kernel-wide, assembly-time list — it cannot change under a running
    // session, so there is nothing to gain from recomputing it per step.
    const segments = Object.fromEntries(
      CORE_OPS.map((n) => [n, replacementFor(this.o.operations ?? [], n)] as const),
    ) as Partial<{ [K in CoreOpName]: ReplacementOperation<K> | undefined }>
    let session!: SessionImpl
    const children = this.o.children ?? new KernelChildren(this, () => session)
    const toolFilter = so.toolFilter
    const memory = this.o.memoryFor?.({ key, cwd: so.cwd })
    session = new SessionImpl({
      ...(memory ? { memory } : {}),
      log,
      tracker,
      surface,
      ui,
      slotFills: () => {
        const deadline = Date.now() + 1000
        return this.slots.snapshot(
          { key, lane, workspaceRoot: so.cwd },
          { remainingMs: () => deadline - Date.now() },
        )
      },
      lane,
      runtime,
      provider: this.o.provider,
      loopFactory,
      ...(this.o.loopChildren ? { bindLoopChildren: this.o.loopChildren } : {}),
      ...(so.toolFilter ? { loopChildToolFilter: so.toolFilter } : {}),
      toolRuntimes: this.toolRuntimes,
      toolPolicies: this.toolPolicies,
      loopEvents: this.loopEvents,
      loopResume: !forked && Boolean(tracker.state.session),
      ...(this.o.withModelSnapshot ? { withModelSnapshot: this.o.withModelSnapshot } : {}),
      registry: so.toolFilter ? new ChildToolRegistry(this.tools, so.toolFilter) : this.tools,
      resources: this.resources,
      ...(this.o.currentRuntime
        ? {
            currentRuntime: so.toolFilter
              ? {
                  current: (key: string) => {
                    const current = this.o.currentRuntime?.current(key)
                    return current && toolFilter
                      ? { ...current, tools: new ChildToolRegistry(current.tools, toolFilter) }
                      : undefined
                  },
                }
              : this.o.currentRuntime,
          }
        : {}),
      ...(this.o.sessionOverlay ? { sessionOverlay: this.o.sessionOverlay } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      operations: this.o.operations ?? [],
      preset,
      contract: this.o.contract,
      ...(this.o.contractForModel ? { contractForModel: this.o.contractForModel } : {}),
      children,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceInvocation ? { workspaceInvocation } : {}),
      ...(this.o.workspacePublication ? { workspacePublication: this.o.workspacePublication } : {}),
      ...(so.workspaceLease ? { workspaceLease: so.workspaceLease } : {}),
      ...(so.childWorkspaceRuntime ? { childWorkspaceRuntime: so.childWorkspaceRuntime } : {}),
      ids: this.ids,
      clock: this.clock,
      actor: so.actor,
      resolvedProfileHash: so.resolvedProfileHash,
      ...(so.imported ? { imported: so.imported } : {}),
      cwd: so.cwd,
      netFetch: this.o.netFetch,
      ...(this.o.publicFetch ? { publicFetch: this.o.publicFetch } : {}),
      ...(this.o.approvalMode ? { approvalMode: this.o.approvalMode } : {}),
      ...(this.o.hostToolDispatch ? { hostToolDispatch: this.o.hostToolDispatch } : {}),
      ...(this.o.requestMedia ? { requestMedia: this.o.requestMedia } : {}),
      ...(this.o.imageInputTokenFallback ? { imageInputTokenFallback: this.o.imageInputTokenFallback } : {}),
      logger,
      invariants: this.invariants,
      segments,
      ...(this.o.timers ? { timers: this.o.timers } : {}),
      ...(this.o.hooks ? { hooks: this.o.hooks } : {}),
      ...(this.o.compaction ? { compaction: this.o.compaction } : {}),
      ...(this.o.runtimePromptPreloader ? { runtimePromptPreloader: this.o.runtimePromptPreloader } : {}),
      ...(this.o.quiet ? { quiet: this.o.quiet } : {}),
      ...(this.o.quiet ? { quietGroup } : {}),
      agnesVersion: this.o.agnesVersion ?? '0.0.0',
    })
    if (so.toolFilter) bindChildSessionToolFilter(session, so.toolFilter)
    if (children instanceof KernelChildren) bindChildFactory(session.key, children)
    const sessionHooks = this.createHookEngine(logger, preset)
    let factoryPort: HookPort | undefined
    const cancelCreation = () => {
      void session.close().catch(() => undefined)
    }
    this.construction.signal.addEventListener('abort', cancelCreation, { once: true })
    try {
      this.construction.signal.throwIfAborted()
      if (this.o.hooksFactory) {
        const hooks = this.o.hooksFactory(session, sessionHooks)
        if (
          !hooks ||
          !['beforeStep', 'toolCall', 'turnStopping', 'context', 'beforeRequest'].every(
            (name) => typeof (hooks as unknown as Record<string, unknown>)[name] === 'function',
          )
        )
          throw new CoreError('E_ENVELOPE', 'invalid session hook factory result')
        if (this.factoryHooks.has(hooks))
          throw new CoreError('E_ENVELOPE', 'hook factory reused a session port')
        this.factoryHooks.add(hooks)
        factoryPort = hooks
        session.hooks = hooks
      } else if (!this.o.hooks) {
        // SessionImpl is the sole lifecycle caller. This default keeps Kernel-owned registrations
        // live without adding a second dispatch beside a fitted hooksFactory port.
        session.hooks = lifecyclePort(session, sessionHooks, logger)
      }
      const reason = forked ? 'new' : session.state.session ? 'resume' : 'new'
      await session.start()
      this.construction.signal.throwIfAborted()
      if (!(so.skipSessionStartHooks && reason === 'new'))
        await session.hooks.sessionStart?.({ reason, preset: session.preset.name, cwd: so.cwd })
      this.construction.signal.throwIfAborted()
    } catch (error) {
      if (factoryPort) this.factoryHooks.delete(factoryPort)
      try {
        await session.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'session initialization and cleanup failed')
      }
      throw error
    } finally {
      this.construction.signal.removeEventListener('abort', cancelCreation)
    }
    this.sessions.set(key, session)
    if (registersRebuilt) await session.diag('registers-rebuilt', { sessionKey: key })
    if (log.recovery) {
      const [lastRecovery] = await log.scan({ type: 'x/core/ledger-tail-recovered', order: 'desc', limit: 1 })
      if (
        (lastRecovery?.data as { diagnosticId?: unknown } | undefined)?.diagnosticId !==
        log.recovery.diagnosticId
      )
        await log.append([session.ev('x/core/ledger-tail-recovered', log.recovery, { ignorable: true })])
    }
    return session
  }

  /**
   * Every session is closed even if one of them throws, and storage is closed either way: a lease
   * held by a session whose log refused to close is a lease nobody can take back, and the first
   * failure taking the rest of the shutdown with it is how that happens.
   */
  close(): Promise<void> {
    if (!this.closing) {
      this.construction.abort()
      this.closing = this.closeOwned()
    }
    return this.closing
  }

  private async closeOwned(): Promise<void> {
    await Promise.allSettled([...this.creating])
    const failures: unknown[] = []
    for (const s of this.sessions.values()) {
      const storage = s.d.log.storage
      if (hasChildControl(storage)) {
        const rec = await storage.lookupByKey(s.key).catch(() => null)
        if (rec && isActiveChildState(rec.state) && rec.state !== 'recovery_pending') {
          const next = rec.state === 'cancelling' ? 'cancelled' : 'failed'
          await storage.casState(s.key, rec.stateRevision, next).catch((err: unknown) => {
            failures.push(err)
          })
        }
      }
      await s.close().catch((err: unknown) => {
        failures.push(err)
      })
    }
    this.sessions.clear()
    try {
      await this.o.storage.close()
    } catch (err) {
      failures.push(err)
    }
    if (failures[0]) throw failures[0]
  }
}

export { KernelChildren } from './child/factory.js'
