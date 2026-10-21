import { admitBudgetMode, admitGeneration } from '@agnes/core-child-control/child/admission'
import { childAgentAllowlist, setChildAgentAllowlist } from '@agnes/core-child-control/child/allowlist'
import { capToMicrocredits } from '@agnes/core-child-control/child/credits'
import { requireChildControl, trackChildAttempt } from '@agnes/core-child-control/child/store'
import {
  type ChildKind,
  type ChildTaskRecord,
  isTerminalChildState,
} from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ChildHandle, ChildrenFactory, ChildStatus } from '@agnes/core-effects/effects/tool-context'
import type { ChildWorkspaceLifecycle } from '@agnes/core-effects/workspace/runtime'
import { forkChecks } from '@agnes/core-ledger/log/fork-seed'
import type { ChildAgentListing, ChildAgentResult, ChildAgentStatus } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import type { Kernel } from '../kernel.js'
import type { SessionImpl } from '../step/session.js'
import { deliverChildCompletion } from './completion-notice.js'
import { cancelOpenAttempt, reportFailedCreation } from './creation.js'
import { childExecutionReceipt } from './execution-receipt.js'
import { childModels, resolveChildModel } from './model-scope.js'
import { openDelegatedSession } from './open-session.js'
import type { ResidentStart, ResidentTurn } from './provider.js'
import type { ResolvedChildRole } from './roles.js'
import { bindChildFactory, childBackend } from './sessions.js'
import { snapshotFromLedger, snapshotFromRecord } from './status.js'

/**
 * The tree cap a deployment gets for free when its preset never names `subagent.tree_budget_credits`.
 * Every shipped preset left this unset, which made fork/spawn refuse unconditionally with E_BUDGET
 * regardless of `max_depth`/`max_fan_out` already inviting subagents — a missing knob, not a
 * deliberate "no subagents" decision. A deployment that wants a real ceiling still sets the field;
 * this only stands in for "nobody configured one".
 */
const DEFAULT_TREE_BUDGET_CREDITS = 20

type CreateOpts = Parameters<ChildrenFactory['create']>[0] & {
  input?: string
  parentEffectId?: string
  start?: boolean
  /** Keep the child after each turn so a later message can continue it. */
  resident?: boolean
  resolvedRole?: ResolvedChildRole
  recovering?: boolean
}

export class KernelChildren implements ChildrenFactory {
  private readonly childSessions = new Map<string, SessionImpl>()
  private session(key: string): SessionImpl | undefined {
    return this.childSessions.get(key) ?? this.kernel.get(key)
  }
  private readonly handles = new Map<string, ChildHandle>()
  private readonly runningTasks = new Map<string, Promise<unknown>>()
  private readonly residentTasks = new Map<string, Promise<unknown>>()
  private readonly cleanups = new Map<string, Promise<void>>()
  private readonly opening = new Map<string, Promise<ChildHandle>>()
  /** Each attached handle's run without Host admission, for callers already inside one. */
  private readonly direct = new WeakMap<ChildHandle, ChildHandle['run']>()
  private boundKey: string | undefined
  private readonly residents = new Map<
    string,
    { child: SessionImpl; idle: () => boolean; run: ChildHandle['run'] }
  >()
  private readonly turnSignals = new Map<string, AbortController>()
  private readonly continued = new Set<string>()
  private readonly humanStopped = new Set<string>()
  private readonly stopReady = new Map<string, () => void>()
  private readonly continueWaiters = new Map<string, () => void>()
  private readonly turnListeners = new Map<string, Set<(event: ResidentTurn) => void>>()
  private readonly completions = new Map<
    string,
    { promise: Promise<ChildAgentResult>; resolve: (value: ChildAgentResult) => void }
  >()

  constructor(
    private readonly kernel: Kernel,
    private readonly parent: () => SessionImpl,
  ) {}

  async create(opts: Parameters<ChildrenFactory['create']>[0]): Promise<ChildHandle> {
    return this.createWithKind(opts.role === undefined ? 'fork' : 'spawn', opts)
  }

  async createWithKind(kind: ChildKind, opts: CreateOpts): Promise<ChildHandle> {
    const parent = this.parent()
    if (parent.turn?.hardBudgetCap !== undefined)
      throw new CoreError('E_BUDGET', 'Child delegation is unavailable in a hard-bounded turn')
    this.bindSession(parent.key)
    if (opts.parent !== parent.key)
      throw new CoreError('E_DEPTH_EXCEEDED', 'child factory parent mismatch', {
        expected: parent.key,
        actual: opts.parent,
      })
    if (opts.preset !== undefined && opts.preset !== parent.preset.name)
      throw new CoreError('E_DEPTH_EXCEEDED', 'default child factory cannot resolve another preset')

    if (opts.role !== undefined) {
      if (kind !== 'spawn' || opts.model !== undefined)
        throw new CoreError('E_ENVELOPE', 'role cannot be combined with fork or model')
      const roles = this.kernel.o.childRoles
      if (!roles) throw new CoreError('E_UNSUPPORTED', 'Application role delegation is unavailable')
      opts = { ...opts, resolvedRole: await roles.resolve(parent, opts.role) }
    }
    const store = requireChildControl(parent.d.log.storage)
    const mode = admitBudgetMode(parent.preset.budgetInherit)
    if (!mode.ok) throw new CoreError('E_UNSUPPORTED', mode.message)

    const parentDepth = generationDepthOf(parent)
    const admitted = admitGeneration(parentDepth, parent.preset.generationLimit)
    if (!admitted.ok) throw new CoreError('E_CHILD_LIMIT', admitted.message)
    if (opts.input === undefined || opts.input.length === 0)
      throw new CoreError('E_ENVELOPE', 'child create requires task input')

    const effectId = (opts.parentEffectId ?? 'direct') + (opts.role ? ':role-' + sha256Hex(opts.role) : '')
    const inputHash = sha256Hex(opts.input)
    const prefix = `${parent.key}:${parent.lane}:${effectId}:`
    const reused = (await store.listByParent(parent.key)).find(
      (row) => row.creationId.startsWith(prefix) && row.inputHash === inputHash,
    )
    if (reused) {
      const cached = this.handles.get(reused.childKey)
      if (cached) return cached
      if (opts.start === false && reused.creationPhase === 'deferred')
        return this.defer(kind, parent, reused, opts)
      return this.open(kind, parent, reused, opts)
    }
    const ordinal = await store.nextOrdinal(parent.key, effectId)
    const creationId = `${prefix}${ordinal}`
    const existing = await store.lookupByCreationId(creationId)
    if (existing) {
      if (existing.inputHash !== inputHash)
        throw new CoreError('E_CHILD_CONFLICT', 'creationId reused with different input', { creationId })
      const cached = this.handles.get(existing.childKey)
      if (cached) return cached
      if (opts.start === false && existing.creationPhase === 'deferred')
        return this.defer(kind, parent, existing, opts)
      return this.open(kind, parent, existing, opts)
    }

    const childKey = `${parent.key}/${this.kernel.ids.ulid()}`
    if (childKey.length > 512)
      throw new CoreError('E_CHILD_LIMIT', 'child session key exceeds protocol limit')
    const boundarySeq =
      opts.forkAt ?? (kind === 'fork' ? parent.op()?.meta.triggerSeq : undefined) ?? parent.lastSeq
    const modelTarget = opts.model === undefined ? undefined : this.resolveModel(parent, opts.model)
    if (opts.model !== undefined && modelTarget === undefined)
      throw new CoreError('E_MODEL_UNKNOWN', `default child factory cannot resolve model ${opts.model}`, {
        model: opts.model,
      })

    const rootTaskId = rootTaskIdOf(parent)
    const treeCap = capToMicrocredits(parent.preset.treeBudgetCredits ?? DEFAULT_TREE_BUDGET_CREDITS)
    await store.ensureRootScope(rootTaskId, treeCap)
    const childCap = opts.budget === undefined ? null : capToMicrocredits(opts.budget)
    const attemptId = `attempt:${this.kernel.ids.ulid()}`

    const untrackAttempt = trackChildAttempt(attemptId)
    try {
      const created = await store.createDelegatedChild({
        ...(opts.role ? { fresh: true } : {}),
        childKey,
        parentKey: parent.key,
        boundarySeq,
        creationId,
        attemptId,
        attemptStartedAt: parent.d.clock(),
        kind,
        rootTaskId,
        runtimeOwnerSessionKey: parent.key,
        generationDepth: admitted.childDepth,
        generationLimit: parent.preset.generationLimit,
        maxFanOut: parent.preset.maxFanOut,
        inputHash,
        inputText: opts.input,
        cwd: opts.cwd,
        actorId: parent.d.actor.id,
        isolation: opts.isolation ?? 'shared',
        workspaceId: `ws:${childKey}`,
        treeCapMicro: treeCap,
        childCapMicro: childCap,
        writerRunId: `${parent.writerRunId}/child/${this.kernel.ids.ulid()}`,
      })
      if (created.status === 'refused') {
        const code =
          created.reason === 'fan_out' || created.reason === 'generation' ? 'E_CHILD_LIMIT' : 'E_BUDGET'
        throw new CoreError(code, created.message)
      }
      if (created.status === 'conflict')
        throw new CoreError('E_CHILD_CONFLICT', 'creationId reused with different input', { creationId })
      const delegation = {
        kind,
        creationId,
        rootTaskId,
        generationDepth: admitted.childDepth,
      }
      const record = (await store.lookupByKey(created.record.childKey)) ?? created.record
      if (opts.start === false) {
        let deferred = record
        if (record.creationPhase === 'creating') {
          await store.deferCreatingChild({
            childKey: record.childKey,
            creationId: record.creationId,
            attemptId: record.attemptId,
            expectedRevision: record.creationRevision,
            deferredAt: parent.d.clock(),
          })
          deferred = (await store.lookupByKey(record.childKey)) ?? record
        }
        return this.defer(kind, parent, deferred, opts, modelTarget, delegation)
      }
      return await this.open(kind, parent, record, opts, modelTarget, delegation)
    } finally {
      untrackAttempt()
    }
  }

  get(childKey: string): ChildHandle | undefined {
    return this.handles.get(childKey)
  }

  /** A spawned child runs detached from the tool call that started it; the Host admits it. */
  private detached<T>(run: () => Promise<T>): Promise<T> {
    const admit = this.kernel.o.detachedChildRun
    return admit ? admit(run) : run()
  }

  private async dropLocalChild(childKey: string, child: SessionImpl): Promise<void> {
    setChildAgentAllowlist(childKey, undefined)
    this.handles.delete(childKey)
    this.residents.delete(childKey)
    this.continued.delete(childKey)
    this.humanStopped.delete(childKey)
    this.continueWaiters.get(childKey)?.()
    this.continueWaiters.delete(childKey)
    this.stopReady.get(childKey)?.()
    this.stopReady.delete(childKey)
    this.turnSignals.delete(childKey)
    this.turnListeners.delete(childKey)
    if (this.kernel.sessions.get(childKey) === child) this.kernel.sessions.delete(childKey)
    this.childSessions.delete(childKey)
    const cleanup = child.close()
    this.cleanups.set(childKey, cleanup)
    await cleanup
  }

  private bindSession(sessionKey: string): void {
    if (this.boundKey === sessionKey) return
    this.boundKey = sessionKey
    bindChildFactory(sessionKey, this)
  }

  roles() {
    return this.kernel.o.childRoles?.list(this.parent()) ?? Promise.resolve([])
  }

  models(): readonly { id: string; route: string; selector: string }[] {
    return childModels(this.parent().d.provider).map((model) => ({
      id: model.id,
      route: model.route,
      selector: `${model.route}/${model.id}`,
    }))
  }

  private completionOf(childKey: string): Promise<ChildAgentResult> {
    let entry = this.completions.get(childKey)
    if (!entry) {
      let resolve: (value: ChildAgentResult) => void = () => undefined
      const promise = new Promise<ChildAgentResult>((settle) => {
        resolve = settle
      })
      entry = { promise, resolve }
      this.completions.set(childKey, entry)
    }
    return entry.promise
  }

  private finishChild(childKey: string, result: ChildAgentResult): void {
    this.completionOf(childKey)
    this.completions.get(childKey)?.resolve(result)
    this.noteTurn(childKey, result.text, result.status)
  }

  private noteTurn(childKey: string, text: string, status: ChildAgentStatus): void {
    for (const listener of this.turnListeners.get(childKey) ?? []) listener({ text, status })
  }

  private pump(childKey: string): void {
    if (this.humanStopped.has(childKey)) return
    const resident = this.residents.get(childKey)
    if (!resident?.idle()) return
    const inbox = resident.child.latest('inbox') as { items?: unknown[] } | undefined
    if (!inbox?.items?.length) return
    void resident
      .run('')
      .finally(() => {
        if (this.residents.get(childKey)?.idle()) this.pump(childKey)
      })
      .catch(() => undefined)
  }

  private open(
    kind: ChildKind,
    parent: SessionImpl,
    record: ChildTaskRecord,
    opts: CreateOpts,
    modelTarget?: { route: string; model: string },
    delegation?: {
      kind: ChildKind
      creationId: string
      rootTaskId: string
      generationDepth: number
    },
  ): Promise<ChildHandle> {
    const cached = this.handles.get(record.childKey)
    if (cached) return Promise.resolve(cached)
    const active = this.opening.get(record.childKey)
    if (active) return active

    const releases: (() => void)[] = []
    const opening = this.openAttempt(kind, parent, record, opts, modelTarget, delegation, (attemptId) =>
      releases.push(trackChildAttempt(attemptId)),
    ).finally(() => {
      for (const release of releases) release()
      if (this.opening.get(record.childKey) === opening) this.opening.delete(record.childKey)
    })
    this.opening.set(record.childKey, opening)
    return opening
  }

  private async openAttempt(
    kind: ChildKind,
    parent: SessionImpl,
    initial: ChildTaskRecord,
    opts: CreateOpts,
    modelTarget: { route: string; model: string } | undefined,
    delegation:
      | { kind: ChildKind; creationId: string; rootTaskId: string; generationDepth: number }
      | undefined,
    track: (attemptId: string) => void,
  ): Promise<ChildHandle> {
    const store = requireChildControl(parent.d.log.storage)
    let attempt = (await store.lookupByKey(initial.childKey)) ?? initial
    if (attempt.creationPhase === 'deferred') {
      const nextAttemptId = `attempt:${this.kernel.ids.ulid()}`
      track(nextAttemptId)
      const begun = await store.beginChildAttempt({
        childKey: attempt.childKey,
        creationId: attempt.creationId,
        previousAttemptId: attempt.attemptId,
        nextAttemptId,
        expectedRevision: attempt.creationRevision,
        startedAt: parent.d.clock(),
      })
      if (!begun) throw new CoreError('E_CAS', 'deferred child was attached by another creation attempt')
      attempt = begun
    }
    if (attempt.creationPhase !== 'creating' && attempt.creationPhase !== 'committed')
      throw new CoreError('E_CAS', `child creation is ${attempt.creationPhase}`)

    let handle: ChildHandle | undefined
    let workspace: ChildWorkspaceLifecycle | undefined
    try {
      while (!parent.d.log.historyVerified) await parent.d.log.fullVerified()
      const historyCheck = parent.d.log.forkCheck()
      const checkParent = () => {
        historyCheck()
        if (parent.closingOrClosed) throw new CoreError('E_CLOSED', 'parent session closed')
      }
      if (isTerminalChildState(attempt.state) || attempt.state === 'cancelling')
        throw new CoreError('E_UNSUPPORTED', `child ${attempt.childKey} is ${attempt.state}`)
      workspace = opts.role
        ? undefined
        : await parent.d.childWorkspaceRuntime?.reserve(parent.key, attempt.childKey)
      checkParent()
      handle = await this.attach(kind, parent, attempt, opts, checkParent, modelTarget, delegation, workspace)
      checkParent()
      if (workspace && !workspace.commit())
        throw new CoreError('E_WORKSPACE_CLOSED', 'child workspace closed before commit', {
          childKey: attempt.childKey,
        })
      checkParent()
      if (
        attempt.creationPhase === 'creating' &&
        !(await store.commitCreatingChild({
          childKey: attempt.childKey,
          creationId: attempt.creationId,
          attemptId: attempt.attemptId,
          expectedRevision: attempt.creationRevision,
        }))
      )
        throw new CoreError('E_CAS', 'child creation attempt changed before commit')
      checkParent()
      const live = (await store.lookupByKey(attempt.childKey)) ?? attempt
      checkParent()
      if (live.state === 'creating') await store.casState(live.childKey, live.stateRevision, 'ready')
      checkParent()
      this.handles.set(attempt.childKey, handle)
      const child = this.session(attempt.childKey)
      if (child) forkChecks.delete(child.d.log)
      return handle
    } catch (error) {
      let cancellationError: unknown
      let live: ChildTaskRecord | null = null
      try {
        live = await store.lookupByKey(attempt.childKey)
      } catch (cause) {
        cancellationError = cause
      }
      if (
        !cancellationError &&
        live?.creationPhase === 'creating' &&
        live.creationId === attempt.creationId &&
        live.attemptId === attempt.attemptId
      ) {
        try {
          await cancelOpenAttempt(store, parent, live)
        } catch (cause) {
          cancellationError = cause
        }
      } else if (
        !cancellationError &&
        live &&
        !isTerminalChildState(live.state) &&
        live.creationId === attempt.creationId &&
        live.attemptId === attempt.attemptId
      ) {
        try {
          await store.casState(live.childKey, live.stateRevision, 'cancelled')
        } catch (cause) {
          cancellationError = cause
        }
      }
      let workspaceCloseDelegated = false
      const child = this.session(attempt.childKey)
      if (handle)
        await reportFailedCreation(parent, attempt.childKey, child?.state.creditsUsed ?? 0).catch(
          () => undefined,
        )
      if (child) {
        workspaceCloseDelegated = true
        // Never publish a completion/cost for a handle that was not admitted. That would also
        // wait on the very parent verification which invalidated this attempt.
        await child.d.log.abandon().catch(() => undefined)
        await this.dropLocalChild(attempt.childKey, child)
      }
      if (!workspaceCloseDelegated) await workspace?.close().catch(() => undefined)
      this.handles.delete(attempt.childKey)
      if (cancellationError)
        throw new AggregateError([error, cancellationError], 'child open and durable cancellation failed')
      throw error
    }
  }

  private owns(record: ChildTaskRecord, caller: string): boolean {
    return record.parentKey === caller || record.runtimeOwnerSessionKey === caller
  }

  private async cancelTree(store: ReturnType<typeof requireChildControl>, childKey: string): Promise<void> {
    const record = await store.lookupByKey(childKey)
    if (!record) return
    // Capture descendants' owner before abort can close and unbind the parent session.
    const descendants = childBackend(childKey)
    const children = await store.listByParent(childKey)
    const handle = this.handles.get(childKey)
    this.session(childKey)?.ac.abort()
    const results = await Promise.allSettled(
      children.map((kid) =>
        descendants ? descendants.cancel(kid.childKey) : this.cancelTree(store, kid.childKey),
      ),
    )
    try {
      if (handle?.cancel) await handle.cancel()
      else {
        const live = await store.lookupByKey(childKey)
        if (live && !isTerminalChildState(live.state))
          await store.casState(childKey, live.stateRevision, 'cancelling')
      }
    } catch (error) {
      results.push({ status: 'rejected', reason: error })
    }
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Child subtree cleanup failed',
      )
  }

  async resume(childKey: string): Promise<ChildHandle> {
    const parent = this.parent()
    const store = requireChildControl(parent.d.log.storage)
    const record = await store.lookupByKey(childKey)
    if (!record || !this.owns(record, parent.key))
      throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
    const cached = this.handles.get(childKey)
    if (cached) {
      if (record.state === 'ready' || record.state === 'creating')
        void cached.run(record.inputText).catch(() => undefined)
      return cached
    }
    throw new CoreError('E_UNSUPPORTED', 'cross-instance child resume is not supported in this release', {
      childKey,
    })
  }

  async cancel(childKey: string): Promise<void> {
    const parent = this.parent()
    const store = requireChildControl(parent.d.log.storage)
    const record = await store.lookupByKey(childKey)
    if (!record || !this.owns(record, parent.key))
      throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
    await this.cancelTree(store, childKey)
    // A cancelled turn may reject its run promise; joining it still completes cancellation.
    await Promise.allSettled([this.residentTasks.get(childKey), this.runningTasks.get(childKey)])
    await this.cleanups.get(childKey)
    this.finishChild(childKey, { status: 'cancelled', text: '' })
  }

  inspect = async (childKey: string): Promise<ChildStatus | null> => {
    const parent = this.parent()
    if (!parent) return null
    const store = requireChildControl(parent.d.log.storage)
    const record = await store.lookupByKey(childKey)
    if (!record) return null
    if (record.parentKey !== parent.key && record.runtimeOwnerSessionKey !== parent.key) return null
    const handle = this.handles.get(childKey)
    if (handle) return handle.status()
    return snapshotFromLedger(parent, record)
  }

  private defer(
    kind: ChildKind,
    parent: SessionImpl,
    record: ChildTaskRecord,
    opts: CreateOpts,
    modelTarget?: { route: string; model: string },
    delegation?: {
      kind: ChildKind
      creationId: string
      rootTaskId: string
      generationDepth: number
    },
  ): ChildHandle {
    const store = requireChildControl(parent.d.log.storage)
    let inner: ChildHandle | undefined
    const handle: ChildHandle = {
      key: record.childKey,
      ...(opts.resolvedRole ? { role: opts.resolvedRole.role } : {}),
      run: (input) =>
        this.detached(async () => {
          const live = (await store.lookupByKey(record.childKey)) ?? record
          if (this.handles.get(record.childKey) === handle) this.handles.delete(record.childKey)
          inner ??= await this.open(
            kind,
            parent,
            live,
            { ...opts, cwd: live.cwd, input: input ?? live.inputText },
            modelTarget,
            delegation,
          )
          this.handles.set(record.childKey, inner)
          return (this.direct.get(inner) ?? inner.run)(input ?? live.inputText)
        }),
      status: async () => {
        if (inner) return inner.status()
        return snapshotFromRecord((await store.lookupByKey(record.childKey)) ?? record)
      },
      close: async () => {
        if (inner) return inner.close()
        const live = await store.lookupByKey(record.childKey)
        if (live && (live.state === 'ready' || live.state === 'running'))
          await store.casState(
            record.childKey,
            live.stateRevision,
            kind === 'spawn' ? 'recovery_pending' : 'cancelled',
          )
        this.handles.delete(record.childKey)
      },
      cancel: async () => {
        if (inner?.cancel) return inner.cancel()
        const live = await store.lookupByKey(record.childKey)
        if (live && live.state !== 'cancelled' && live.state !== 'completed' && live.state !== 'failed')
          await store.casState(record.childKey, live.stateRevision, 'cancelled')
        this.handles.delete(record.childKey)
      },
    }
    this.handles.set(record.childKey, handle)
    return handle
  }

  private async attach(
    kind: ChildKind,
    parent: SessionImpl,
    record: ChildTaskRecord,
    opts: CreateOpts,
    checkParent: () => void,
    modelTarget?: { route: string; model: string },
    delegation?: {
      kind: ChildKind
      creationId: string
      rootTaskId: string
      generationDepth: number
    },
    workspace?: ChildWorkspaceLifecycle,
  ): Promise<ChildHandle> {
    const store = requireChildControl(parent.d.log.storage)
    const child = await openDelegatedSession(
      this.kernel,
      parent,
      record,
      opts,
      checkParent,
      modelTarget,
      delegation,
      workspace,
    )
    this.childSessions.set(child.key, child)
    forkChecks.set(child.d.log, checkParent)
    checkParent()
    const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
    const body = opts.input ?? record.inputText
    if (!opts.recovering && body && !inbox?.items?.length) {
      await child.enqueue('next-turn', {
        content: [
          {
            type: 'text',
            text: 'You are a delegated child agent. Complete the task below in this session using its disclosed tools and working directory. Return your result to the delegating agent; do not repeat the parent orchestration. Any inherited conversation is background, not your task.',
          },
          { type: 'text', text: body },
        ],
        actor: child.d.actor,
      })
      checkParent()
    }

    let state: 'ready' | 'running' | 'done' | 'error' | 'cancelled' =
      record.state === 'running' && !opts.recovering ? 'running' : 'ready'
    let ended = false
    let cachedText = ''
    let cachedSeq = 0
    const lastText = async (): Promise<string> => {
      const rows = await child.scan({ type: 'assistant/message', order: 'desc', limit: 1 })
      const content = (rows[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
        ?.content
      return (content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    }
    const emitEnd = async (outcome: 'completed' | 'cancelled' | 'failed'): Promise<void> => {
      if (ended) return
      ended = true
      const live = await store.lookupByKey(record.childKey)
      if (live) {
        const locked = live.state === 'cancelled' || live.state === 'cancelling'
        await store.casState(
          record.childKey,
          live.stateRevision,
          locked || outcome === 'cancelled' ? 'cancelled' : outcome === 'completed' ? 'completed' : 'failed',
        )
      }
      // Hooks and the cost row report what was stored, which an earlier settlement may have decided.
      const stored = (await store.lookupByKey(record.childKey))?.state
      if (stored && isTerminalChildState(stored)) outcome = stored as typeof outcome
      await parent.hooks
        .subagentEnd?.({ childKey: record.childKey, outcome, credits: Math.max(0, child.state.creditsUsed) })
        .catch(() => undefined)
      const cost = (await child.scan({ type: 'cost/ledger', order: 'desc', limit: 1 }).catch(() => []))[0]
      const credits = Math.max(0, child.state.creditsUsed)
      await parent.d.log
        .append([
          parent.ev('subagent/cost', {
            childKey: record.childKey,
            originSessionKey: child.key,
            originCostSeq: Math.max(1, cost?.seq ?? child.lastSeq),
            settlementRevision: Math.max(1, live?.stateRevision ?? 1),
            complete: outcome === 'completed',
            ...(outcome === 'completed'
              ? { credits, creditSource: 'estimated' as const }
              : { creditSource: 'unknown' as const }),
          }),
        ])
        .catch(() => undefined) // Only after the terminal state is durable; a missed delivery is repaired by the parent's recovery scan.
      await deliverChildCompletion(parent, record, outcome, { credits }).catch(() => undefined)
    }
    const handle: ChildHandle = {
      key: record.childKey,
      ...(child.d.roleDelegation ? { role: child.d.roleDelegation.role } : {}),
      run: async (input) => {
        const durable = await store.lookupByKey(record.childKey)
        if (durable && (isTerminalChildState(durable.state) || durable.state === 'cancelling'))
          throw new CoreError('E_UNSUPPORTED', `child ${record.childKey} is ${durable.state}`)
        if (state !== 'ready') throw new CoreError('E_LANE_BUSY', `child ${record.childKey} already started`)
        const continuation = opts.resident === true && this.continued.has(record.childKey)
        if (!continuation && input !== undefined && sha256Hex(input) !== record.inputHash)
          throw new CoreError('E_CHILD_CONFLICT', 'run input does not match persisted create input')
        const live = await store.lookupByKey(record.childKey)
        if (
          live &&
          live.state !== 'running' &&
          !(await store.casState(record.childKey, live.stateRevision, 'running'))
        )
          throw new CoreError('E_UNSUPPORTED', `child ${record.childKey} cannot start from ${live.state}`)
        state = 'running'
        const turnAbort = new AbortController()
        this.turnSignals.set(record.childKey, turnAbort)
        let residentHold = false
        try {
          const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
          if (!inbox?.items?.length && !child.op()) {
            await child.enqueue('next-turn', {
              content: [{ type: 'text', text: input ?? '' }],
              actor: child.d.actor,
            })
          }
          if (opts.recovering && child.op()) await child.resume()
          let result = await child.run({
            until: 'turn-end',
            signal: turnAbort.signal,
          })
          // A human stop retains the child, its constraints and the parent's waiting workflow.
          // Continue opens a new turn only after Core has drained cancellation and reset its driver.
          while (
            !opts.resident &&
            this.humanStopped.has(record.childKey) &&
            state === 'running' &&
            (result.reason === 'aborted' || result.reason === 'interrupted')
          ) {
            const stopped = await store.lookupByKey(record.childKey)
            if (stopped?.state === 'running')
              await store.casState(record.childKey, stopped.stateRevision, 'ready')
            this.noteTurn(record.childKey, await lastText(), 'interrupted')
            await new Promise<void>((resolve) => {
              this.continueWaiters.set(record.childKey, resolve)
              this.stopReady.get(record.childKey)?.()
            })
            this.continueWaiters.delete(record.childKey)
            if (state !== 'running') throw new CoreError('E_RELATION', 'Child was disposed while stopped')
            const ready = await store.lookupByKey(record.childKey)
            if (!ready || !(await store.casState(record.childKey, ready.stateRevision, 'running')))
              throw new CoreError('E_RELATION', 'Stopped child cannot continue')
            result = await child.run({ until: 'turn-end', signal: turnAbort.signal })
          }
          const text = await lastText()
          // A human stop preserves the resident while its cancelled driver is being rebuilt.
          if (
            opts.resident &&
            (!child.ac.signal.aborted || this.humanStopped.has(record.childKey)) &&
            (result.reason === 'completed' || result.reason === 'aborted' || result.reason === 'interrupted')
          ) {
            state = 'ready'
            this.continued.add(record.childKey)
            residentHold = true
            const parked = await store.lookupByKey(record.childKey)
            if (parked?.state === 'running')
              await store.casState(record.childKey, parked.stateRevision, 'ready')
            const status: ChildAgentStatus = result.reason === 'completed' ? 'idle' : 'interrupted'
            this.noteTurn(record.childKey, text, status)
            if (status === 'idle')
              await deliverChildCompletion(parent, record, 'completed', {
                credits: Math.max(0, child.state.creditsUsed),
                continuable: true,
              }).catch(() => undefined)
            queueMicrotask(() => this.pump(record.childKey))
            return { text, lastSeq: child.lastSeq }
          }
          if (result.reason !== 'completed') {
            state = result.reason === 'aborted' || result.reason === 'interrupted' ? 'cancelled' : 'error'
            throw new CoreError('E_RELATION', `child turn ended ${result.reason}`)
          }
          state = 'done'
          return { text, lastSeq: child.lastSeq }
        } catch (error) {
          if (opts.resident && turnAbort.signal.aborted && state === 'running') {
            state = 'ready'
            this.continued.add(record.childKey)
            residentHold = true
            const text = await lastText().catch(() => '')
            const parked = await store.lookupByKey(record.childKey)
            if (parked?.state === 'running')
              await store.casState(record.childKey, parked.stateRevision, 'ready').catch(() => false)
            this.noteTurn(record.childKey, text, 'interrupted')
            queueMicrotask(() => this.pump(record.childKey))
            return { text, lastSeq: child.lastSeq }
          }
          if (state === 'running') state = child.ac.signal.aborted ? 'cancelled' : 'error'
          throw error
        } finally {
          this.stopReady.get(record.childKey)?.()
          this.turnSignals.delete(record.childKey)
          cachedText = await lastText().catch(() => cachedText)
          cachedSeq = child.lastSeq
          if (!residentHold) {
            const outcome = state === 'done' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed'
            await emitEnd(outcome)
            this.finishChild(record.childKey, { status: outcome, text: cachedText })
            await this.dropLocalChild(record.childKey, child)
          }
        }
      },
      status: async (): Promise<ChildStatus> => {
        const terminal = state === 'done' || state === 'error' || state === 'cancelled'
        const text = terminal ? cachedText : await lastText().catch(() => cachedText)
        return {
          state: state === 'error' || state === 'cancelled' ? 'error' : state === 'done' ? 'done' : 'running',
          lastSeq: terminal ? cachedSeq : child.lastSeq,
          ...(opts.resident && state === 'ready' && this.continued.has(record.childKey)
            ? { idle: true }
            : {}),
          ...(text ? { text } : {}),
          receipt: await childExecutionReceipt(parent, record),
        }
      },
      close: async () => {
        this.humanStopped.delete(record.childKey)
        this.stopReady.get(record.childKey)?.()
        this.continueWaiters.get(record.childKey)?.()
        if (this.continueWaiters.has(record.childKey)) state = 'cancelled'
        if (kind === 'spawn' && (state === 'ready' || state === 'running')) {
          const live = await store.lookupByKey(record.childKey)
          if (live) await store.casState(record.childKey, live.stateRevision, 'recovery_pending')
          await child.close()
          this.childSessions.delete(record.childKey)
          this.kernel.sessions.delete(record.childKey)
          this.handles.delete(record.childKey)
          return
        }
        if (state === 'ready' || state === 'running') state = 'cancelled'
        await child.close()
        this.childSessions.delete(record.childKey)
        this.kernel.sessions.delete(record.childKey)
        this.handles.delete(record.childKey)
        await emitEnd(state === 'done' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed')
      },
      cancel: async () => {
        const idle = state === 'ready'
        this.humanStopped.delete(record.childKey)
        this.stopReady.get(record.childKey)?.()
        this.continueWaiters.get(record.childKey)?.()
        if (state === 'ready' || state === 'running') {
          child.ac.abort()
          state = 'cancelled'
        }
        const live = await store.lookupByKey(record.childKey)
        if (live && live.state !== 'cancelled' && live.state !== 'completed' && live.state !== 'failed')
          await store.casState(record.childKey, live.stateRevision, idle ? 'cancelled' : 'cancelling')
        await emitEnd('cancelled')
        // Unstarted children never enter run.finally; release now. An in-flight run still owns the
        // session until that path ends — aborting is not proof it has stopped writing.
        if (idle) await this.dropLocalChild(record.childKey, child)
      },
    }
    const originalRun = handle.run
    const run: ChildHandle['run'] = (input) => {
      const task = originalRun(input)
      this.runningTasks.set(record.childKey, task)
      void task
        .finally(() => {
          if (this.runningTasks.get(record.childKey) === task) this.runningTasks.delete(record.childKey)
        })
        .catch(() => undefined)
      return task
    }
    handle.run = run
    this.direct.set(handle, run)
    if (opts.resident) {
      this.residents.set(record.childKey, {
        child,
        idle: () => state === 'ready' && this.continued.has(record.childKey),
        run,
      })
    }
    if (kind === 'spawn' || opts.resident) handle.run = (input) => this.detached(() => run(input))
    await parent.hooks
      .subagentStart?.({ childKey: record.childKey, kind, budget: opts.budget ?? null })
      .catch(() => undefined)
    checkParent()
    return handle
  }

  async startResident(input: ResidentStart): Promise<{ id: string }> {
    const parent = this.parent()
    const child = await this.createWithKind(input.fork ? 'fork' : 'spawn', {
      parent: parent.key,
      cwd: input.cwd,
      input: input.task,
      resident: true,
      start: false,
      ...(input.invocationId ? { parentEffectId: 'loop-child-' + sha256Hex(input.invocationId) } : {}),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.toolFilter ? { toolFilter: input.toolFilter } : {}),
    })
    const task = child.run(input.task).catch(async (error: unknown) => {
      // Cancellation can race deferred open: run may refuse before entering its finally.
      const opened = this.session(child.key)
      if (opened) await this.dropLocalChild(child.key, opened)
      const record = await requireChildControl(parent.d.log.storage).lookupByKey(child.key)
      this.finishChild(child.key, {
        status: record?.state === 'cancelled' || record?.state === 'cancelling' ? 'cancelled' : 'failed',
        text: error instanceof Error ? error.message : String(error),
      })
    })
    this.residentTasks.set(child.key, task)
    void task
      .finally(() => {
        if (this.residentTasks.get(child.key) === task) this.residentTasks.delete(child.key)
      })
      .catch(() => undefined)
    return { id: child.key }
  }

  /** Locate the durable creation fence; opening an existing child never mints a new identity. */
  async adoptResident(input: ResidentStart & { invocationId: string }): Promise<{ id: string }> {
    const parent = this.parent()
    const store = requireChildControl(parent.d.log.storage)
    const prefix = parent.key + ':' + parent.lane + ':loop-child-' + sha256Hex(input.invocationId) + ':'
    const record = (await store.listByParent(parent.key)).find((row) => row.creationId.startsWith(prefix))
    if (!record || !this.owns(record, parent.key) || record.inputHash !== sha256Hex(input.task))
      throw new CoreError('E_CHILD_NOT_FOUND', 'Child invocation has no durable creation identity')
    if (isTerminalChildState(record.state) || record.state === 'cancelling')
      throw new CoreError('E_UNSUPPORTED', 'Child invocation has already terminated')
    if (this.handles.has(record.childKey)) return { id: record.childKey }
    const opts: CreateOpts = {
      parent: parent.key,
      cwd: record.cwd,
      input: record.inputText,
      resident: true,
      recovering: true,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.toolFilter ? { toolFilter: input.toolFilter } : {}),
    }
    const model = input.model === undefined ? undefined : this.resolveModel(parent, input.model)
    if (input.model !== undefined && !model)
      throw new CoreError('E_UNSUPPORTED', 'Child model is unavailable')
    const needsInitialTurn = record.creationPhase !== 'committed'
    const handle = await this.open(record.kind, parent, record, opts, model)
    const resident = this.residents.get(record.childKey)!
    const inbox = resident.child.latest('inbox') as { items?: unknown[] } | undefined
    if (resident.child.op() || inbox?.items?.length || needsInitialTurn) {
      void handle.run(record.inputText).catch((error: unknown) => {
        this.finishChild(record.childKey, { status: 'failed', text: String(error) })
      })
    } else {
      this.continued.add(record.childKey)
    }
    return { id: record.childKey }
  }

  async startFork(input: ResidentStart): Promise<{ id: string; text: string }> {
    const parent = this.parent()
    const child = await this.createWithKind('fork', {
      parent: parent.key,
      cwd: input.cwd,
      input: input.task,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
    })
    try {
      const result = await child.run(input.task)
      return { id: child.key, text: result.text }
    } finally {
      await child.close().catch(() => undefined)
    }
  }

  private childStatus(record: ChildTaskRecord): ChildAgentStatus {
    if (this.humanStopped.has(record.childKey)) return 'interrupted'
    if (this.residents.get(record.childKey)?.idle()) return 'idle'
    switch (record.state) {
      case 'completed':
        return 'completed'
      case 'failed':
        return 'failed'
      case 'cancelled':
        return 'cancelled'
      case 'ready':
      case 'creating':
        return 'starting'
      default:
        return 'running'
    }
  }

  async list(): Promise<readonly ChildAgentListing[]> {
    const parent = this.parent()
    this.bindSession(parent.key)
    const store = requireChildControl(parent.d.log.storage)
    const rows = await store.listByParent(parent.key)
    return Promise.all(
      rows.map(async (row) => {
        const resident = this.residents.get(row.childKey)
        const text = (await this.inspect(row.childKey))?.text
        return {
          id: row.childKey,
          providerId: 'in-process',
          status: this.childStatus(row),
          continuable: resident !== undefined,
          ...(text ? { text } : {}),
        }
      }),
    )
  }

  /** Parent-owned Web controls use the same pinned session controls as top-level turns. */
  async humanControl(
    childKey: string,
    action: 'stop' | 'continue',
    actor: Actor,
    admissionId: string,
    text?: string,
  ): Promise<number> {
    const parent = this.parent()
    const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
    if (!record || !this.owns(record, parent.key))
      throw new CoreError('E_CHILD_NOT_FOUND', 'Child is not owned by this parent')
    const child = this.session(childKey)
    if (!child)
      throw new CoreError('E_UNSUPPORTED', 'Child has no live control endpoint', { control: action })
    if (action === 'stop') {
      await child.controls.require('interrupt', actor)
      if (!child.op())
        throw new CoreError('E_RELATION', 'Child has no running turn', { reason: 'CONTROL_NOT_RUNNING' })
      if (this.humanStopped.has(childKey))
        throw new CoreError('E_RELATION', 'Child stop already requested', { reason: 'CONTROL_NOT_RUNNING' })
      this.humanStopped.add(childKey)
      const ready = this.turnSignals.has(childKey)
        ? new Promise<void>((resolve) => this.stopReady.set(childKey, resolve))
        : Promise.resolve()
      try {
        const seq = await child.controls.apply('cancel', actor, admissionId)
        await ready
        return seq
      } catch (error) {
        this.humanStopped.delete(childKey)
        this.continueWaiters.get(childKey)?.()
        throw error
      } finally {
        this.stopReady.delete(childKey)
      }
    }
    await child.controls.require('steer', actor)
    if (!text?.trim()) throw new CoreError('E_ENVELOPE', 'Continue requires a message')
    const waiter = this.continueWaiters.get(childKey)
    if (!waiter && !this.residents.has(childKey))
      throw new CoreError('E_UNSUPPORTED', 'Child is not continuable', { control: 'continue' })
    const seq = await child.enqueue(child.op() ? 'next-step' : 'next-turn', {
      content: [{ type: 'text', text }],
      kind: 'steer',
      actor,
      // Internal message/control IDs need the same stable digest shape as RPC admissions.
      admissionId: /^[0-9a-f]{64}$/.test(admissionId) ? admissionId : sha256Hex(admissionId),
    })
    await child.d.log.append([child.controls.fact('child-continue', 'applied', actor, { admissionId })])
    this.humanStopped.delete(childKey)
    if (waiter) waiter()
    else this.pump(childKey)
    return seq
  }

  async humanControlState(
    childKey: string,
  ): Promise<import('@agnes/protocol/gen/agnes-v1').SessionControlledChild> {
    const parent = this.parent()
    const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
    if (!record || !this.owns(record, parent.key))
      throw new CoreError('E_CHILD_NOT_FOUND', 'Child is not owned by this parent')
    const child = this.session(childKey)
    let totalTokens: number | null = null
    {
      const costs = await parent.d.log.storage.scan(childKey, {
        type: 'cost/ledger',
        fromSeq: (record.boundarySeq + 1) as typeof record.boundarySeq,
        limit: 500,
      })
      const tokens = costs.map((row) => {
        const tokens = (row.data as { tokens?: { input?: number; output?: number } }).tokens
        return typeof tokens?.input === 'number' && typeof tokens.output === 'number'
          ? tokens.input + tokens.output
          : undefined
      })
      if (costs.length && costs.length < 500 && tokens.every((value) => typeof value === 'number'))
        totalTokens = tokens.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    }
    const first = await parent.d.log.storage.scan(childKey, {
      type: 'turn/start',
      fromSeq: (record.boundarySeq + 1) as typeof record.boundarySeq,
      limit: 1,
    })
    const last = await parent.d.log.storage.scan(childKey, {
      type: 'turn/end',
      fromSeq: (record.boundarySeq + 1) as typeof record.boundarySeq,
      order: 'desc',
      limit: 1,
    })
    const end = child?.op() ? parent.d.clock() : last[0] ? Date.parse(last[0].ts) : null
    const start = first[0] ? Date.parse(first[0].ts) : null
    return {
      id: childKey,
      parentId: parent.key,
      providerId: 'in-process',
      status: this.childStatus(record),
      controls: {
        stop: child?.d.loopFactory.controls?.interrupt === true && child.op() !== null,
        continue:
          child?.d.loopFactory.controls?.steer === true &&
          (this.continueWaiters.has(childKey) || this.residents.has(childKey)),
      },
      durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      totalTokens,
    }
  }

  async sendMessage(childKey: string, text: string, signal: AbortSignal): Promise<{ messageId: string }> {
    signal.throwIfAborted()
    if (!text) throw new CoreError('E_ENVELOPE', 'message must not be empty')
    const resident = this.residents.get(childKey)
    if (!resident) return this.missingContinuable(childKey)
    const messageId = this.kernel.ids.ulid()
    await this.humanControl(childKey, 'continue', resident.child.d.actor, messageId, text)
    return { messageId }
  }

  async interrupt(childKey: string): Promise<{ accepted: boolean }> {
    if (!this.residents.has(childKey)) return this.missingContinuable(childKey)
    const child = this.session(childKey)
    if (!child?.op() || this.humanStopped.has(childKey)) return { accepted: false }
    try {
      await this.humanControl(childKey, 'stop', child.d.actor, this.kernel.ids.ulid())
    } catch (error) {
      // The turn can end after the running check above and before stop is applied.
      if (controlNotRunning(error)) return { accepted: false }
      throw error
    }
    return { accepted: true }
  }

  private async missingContinuable(childKey: string): Promise<never> {
    const parent = this.parent()
    const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
    if (record && this.owns(record, parent.key))
      throw new CoreError('E_UNSUPPORTED', `child ${childKey} is not continuable`, { childKey })
    throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
  }

  onTurn(childKey: string, listener: (event: ResidentTurn) => void): () => void {
    let listeners = this.turnListeners.get(childKey)
    if (!listeners) {
      listeners = new Set()
      this.turnListeners.set(childKey, listeners)
    }
    listeners.add(listener)
    return () => listeners?.delete(listener)
  }

  completion(childKey: string): Promise<ChildAgentResult> {
    return this.completionOf(childKey)
  }

  private resolveModel(parent: SessionImpl, selector: string): { route: string; model: string } | undefined {
    return resolveChildModel(parent.d.provider, parent.preset, selector)
  }
}

function controlNotRunning(error: unknown): boolean {
  return (
    error instanceof CoreError &&
    error.code === 'E_RELATION' &&
    error.detail?.reason === 'CONTROL_NOT_RUNNING'
  )
}

function generationDepthOf(session: SessionImpl): number {
  const start = session.state.session as { delegation?: { generationDepth?: number } } | null
  return start?.delegation?.generationDepth ?? 0
}

function rootTaskIdOf(session: SessionImpl): string {
  const start = session.state.session as { delegation?: { rootTaskId?: string } } | null
  if (start?.delegation?.rootTaskId) return start.delegation.rootTaskId
  const turn = session.state.openTurn.get(session.lane)
  return `${session.key}:${session.lane}:${turn?.startSeq ?? 0}`
}
