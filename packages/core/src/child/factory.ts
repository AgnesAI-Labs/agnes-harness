import type { Provider } from '@agnes/protocol'
import type { ChildHandle, ChildrenFactory, ChildStatus } from '../effects/tool-context.js'
import type { Kernel } from '../kernel.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import { runWithInheritedConfigurationApproval } from '../step/configuration-admission.js'
import { resolveModel as resolvePrimaryModel } from '../step/inference.js'
import type { SessionImpl } from '../step/session.js'
import { assertSessionIdleGateMutable } from '../step/session-idle-gate.js'
import { CoreError } from '../types.js'
import type { ChildWorkspaceLifecycle } from '../workspace/runtime.js'
import { admitBudgetMode, admitGeneration } from './admission.js'
import {
  CHILD_DESCRIPTOR,
  deliverChildMessage,
  readChildDelivery,
  readChildDescriptor,
  retargetInterruptedInbox,
} from './continuation.js'
import { capToMicrocredits } from './credits.js'
import {
  acknowledgeParentMessage,
  persistParentMessage,
  receiveParentMessage,
  requestParentWake,
} from './parent-messages.js'
import { requireChildControl } from './store.js'
import { type ChildKind, type ChildTaskRecord, isTerminalChildState } from './types.js'

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
}

type CreationRefusal = Readonly<{
  kind: ChildKind
  parentKey: string
  writerRunId: string
  lane: string
  toolUseId: string
  callSeq: number
  code: CoreError['code']
}>

export class KernelChildren implements ChildrenFactory {
  private readonly handles = new Map<string, ChildHandle>()
  private readonly opening = new Map<string, Promise<ChildHandle>>()
  private readonly creating = new Set<Promise<ChildHandle>>()
  get allocationActive(): boolean {
    return this.creating.size > 0 || this.opening.size > 0
  }
  private readonly lifetime = new AbortController()
  private readonly failedDrains = new Map<string, { child: SessionImpl; error: unknown }>()
  /** Each attached handle's run without Host admission, for callers already inside one. */
  private readonly direct = new WeakMap<ChildHandle, ChildHandle['run']>()
  private readonly sessions = new Map<string, SessionImpl>()
  private readonly deliveries = new Map<string, Promise<unknown>>()
  private readonly deferredParentDeliveries = new Map<string, () => void>()
  private readonly interrupted = new Set<string>()
  private readonly runningChildren = new Map<string, Promise<unknown>>()
  private readonly admissionClosed = new Set<string>()
  // Only this factory can attest an explicit refusal before any creation mutation. An error's
  // class/code alone says nothing about whether a child or workspace has already been opened.
  readonly #refusals = new WeakMap<object, CreationRefusal>()

  constructor(
    private readonly kernel: Kernel,
    private readonly parent: () => SessionImpl,
  ) {}

  supportsRuntime(identity: Readonly<{ id: string; version: string }>): boolean {
    if (this.kernel.o.childSessionOpen) return this.kernel.o.childSessionSupportsRuntime?.(identity) === true
    return identity.id === 'native' && identity.version === '1'
  }

  readCreationRefusal(
    error: unknown,
    binding: Readonly<{ kind: ChildKind; toolUseId: string; callSeq: number }>,
  ): CreationRefusal | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const proof = this.#refusals.get(error)
    const parent = this.parent()
    const call = parent.state.toolCalls.get(binding.toolUseId)
    return proof &&
      proof.parentKey === parent.key &&
      proof.writerRunId === parent.writerRunId &&
      proof.lane === parent.lane &&
      proof.kind === binding.kind &&
      proof.toolUseId === binding.toolUseId &&
      proof.callSeq === binding.callSeq &&
      call?.seq === binding.callSeq &&
      call.lane === parent.lane
      ? proof
      : undefined
  }

  #refuse(kind: ChildKind, opts: CreateOpts, error: CoreError): never {
    const parent = this.parent()
    const call = opts.parentEffectId ? parent.state.toolCalls.get(opts.parentEffectId) : undefined
    if (opts.parent === parent.key && opts.parentEffectId && call?.lane === parent.lane) {
      this.#refusals.set(
        error,
        Object.freeze({
          kind,
          parentKey: parent.key,
          writerRunId: parent.writerRunId,
          lane: parent.lane,
          toolUseId: opts.parentEffectId,
          callSeq: call.seq,
          code: error.code,
        }),
      )
    }
    throw error
  }

  async create(opts: Parameters<ChildrenFactory['create']>[0]): Promise<ChildHandle> {
    return this.createWithKind('fork', opts)
  }

  createWithKind(kind: ChildKind, opts: CreateOpts): Promise<ChildHandle> {
    assertSessionIdleGateMutable(this.parent())
    const signal = opts.signal ? AbortSignal.any([opts.signal, this.lifetime.signal]) : this.lifetime.signal
    const creating = this.createAttempt(kind, { ...opts, signal }).finally(() =>
      this.creating.delete(creating),
    )
    this.creating.add(creating)
    return creating
  }

  private async createAttempt(kind: ChildKind, opts: CreateOpts): Promise<ChildHandle> {
    const parent = this.parent()
    assertCreationLive(parent, opts.signal)
    if (!this.supportsRuntime(parent.runtimeIdentity))
      this.#refuse(kind, opts, new CoreError('E_UNSUPPORTED', 'this runtime has no child-session factory'))
    if (opts.parent !== parent.key)
      throw new CoreError('E_DEPTH_EXCEEDED', 'child factory parent mismatch', {
        expected: parent.key,
        actual: opts.parent,
      })
    if (opts.preset !== undefined && opts.preset !== parent.preset.name)
      this.#refuse(
        kind,
        opts,
        new CoreError('E_DEPTH_EXCEEDED', 'default child factory cannot resolve another preset'),
      )

    const store = requireChildControl(parent.d.log.storage)
    const mode = admitBudgetMode(parent.preset.budgetInherit)
    if (!mode.ok) this.#refuse(kind, opts, new CoreError('E_UNSUPPORTED', mode.message))

    const parentDepth = generationDepthOf(parent)
    const admitted = admitGeneration(parentDepth, parent.preset.generationLimit)
    if (!admitted.ok) this.#refuse(kind, opts, new CoreError('E_CHILD_LIMIT', admitted.message))
    if (opts.input === undefined || opts.input.length === 0)
      this.#refuse(kind, opts, new CoreError('E_ENVELOPE', 'child create requires task input'))

    const effectId = opts.parentEffectId ?? 'direct'
    const inputHash = sha256Hex(opts.input)
    const seedMode = kind === 'spawn' ? 'fresh' : 'history'
    const requestedBoundary = parentBoundary(parent, opts, kind)
    // Delegated forks inherit balanced, ended turns on every runtime. An explicit Native
    // history cut retains its API contract; existing child identities retain their stored seed.
    const boundarySeq =
      kind === 'spawn'
        ? 0
        : parent.runtimeIdentity.id === 'native' && opts.forkAt !== undefined
          ? requestedBoundary
          : ((await parent.scan({ type: 'turn/end', toSeq: requestedBoundary, order: 'desc', limit: 1 }))[0]
              ?.seq ?? 0)
    const modelTarget = opts.model === undefined ? undefined : this.resolveModel(parent, opts.model)
    if (opts.model !== undefined && modelTarget === undefined)
      this.#refuse(
        kind,
        opts,
        new CoreError('E_MODEL_UNKNOWN', `default child factory cannot resolve model ${opts.model}`, {
          model: opts.model,
        }),
      )
    const effectiveModel = modelTarget ?? resolvePrimaryModel(parent, 'primary')
    const assertIdentity = (row: ChildTaskRecord) => {
      const legacy = row.runtime === undefined && row.seedMode === undefined
      if (
        row.kind !== kind ||
        ((kind === 'spawn' || opts.forkAt !== undefined) && row.boundarySeq !== boundarySeq) ||
        (row.creationCwd ?? row.cwd) !== opts.cwd ||
        row.isolation !== (opts.isolation ?? 'shared') ||
        (legacy
          ? parent.runtimeIdentity.id !== 'native' || kind === 'spawn'
          : row.runtime?.id !== parent.runtimeIdentity.id ||
            row.runtime?.version !== parent.runtimeIdentity.version ||
            row.seedMode !== seedMode) ||
        (!legacy &&
          (row.model?.route !== effectiveModel?.route || row.model?.model !== effectiveModel?.model))
      )
        throw new CoreError('E_CHILD_CONFLICT', 'child creation identity changed')
    }
    const prefix = `${parent.key}:${parent.lane}:${effectId}:`
    const reused = (await store.listByParent(parent.key)).find(
      (row) => row.creationId.startsWith(prefix) && row.inputHash === inputHash,
    )
    if (reused) {
      assertIdentity(reused)
      const cached = this.handles.get(reused.childKey)
      if (cached) return cached
      if (kind === 'spawn' && opts.start === false && reused.creationPhase === 'deferred')
        return this.defer(kind, parent, reused, opts)
      return this.open(kind, parent, reused, opts)
    }
    const ordinal = await store.nextOrdinal(parent.key, effectId)
    const creationId = `${prefix}${ordinal}`
    const existing = await store.lookupByCreationId(creationId)
    if (existing) {
      assertIdentity(existing)
      if (existing.inputHash !== inputHash)
        throw new CoreError('E_CHILD_CONFLICT', 'creationId reused with different input', { creationId })
      const cached = this.handles.get(existing.childKey)
      if (cached) return cached
      if (kind === 'spawn' && opts.start === false && existing.creationPhase === 'deferred')
        return this.defer(kind, parent, existing, opts)
      return this.open(kind, parent, existing, opts)
    }

    const childKey = `${parent.key}/${this.kernel.ids.ulid()}`
    if (childKey.length > 512)
      throw new CoreError('E_CHILD_LIMIT', 'child session key exceeds protocol limit')
    const rootTaskId = rootTaskIdOf(parent)
    if (parent.preset.treeBudgetMode === 'unlimited' && parent.preset.treeBudgetCredits != null)
      throw new CoreError('E_BUDGET', 'unlimited tree budget cannot specify numeric credits')
    const treeCap =
      parent.preset.treeBudgetMode === 'unlimited'
        ? null
        : capToMicrocredits(parent.preset.treeBudgetCredits ?? DEFAULT_TREE_BUDGET_CREDITS)
    await store.ensureRootScope(rootTaskId, treeCap)
    const childCap = opts.budget === undefined ? null : capToMicrocredits(opts.budget)
    const attemptId = `attempt:${this.kernel.ids.ulid()}`

    const created = await store.createDelegatedChild({
      childKey,
      parentKey: parent.key,
      boundarySeq,
      creationId,
      attemptId,
      attemptStartedAt: parent.d.clock(),
      kind,
      runtime: { ...parent.runtimeIdentity },
      seedMode,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      creationCwd: opts.cwd,
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
    if (kind === 'spawn' && opts.start === false) {
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
    return this.open(kind, parent, record, opts, modelTarget, delegation)
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
    try {
      await child.close()
    } catch (error) {
      this.failedDrains.set(childKey, { child, error })
      throw error
    }
    this.failedDrains.delete(childKey)
    this.handles.delete(childKey)
    this.sessions.delete(childKey)
    this.admissionClosed.delete(childKey)
    if (this.kernel.sessions.get(childKey) === child) this.kernel.sessions.delete(childKey)
  }

  /** Parent close owns all descendants, including detached spawn and an in-progress opener. */
  async closeOwned(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.deliveries.values()])
    const retryDrains = [...this.failedDrains.values()]
    const openings = await Promise.allSettled([...this.creating, ...this.opening.values()])
    const handles = new Set([
      ...this.handles.values(),
      ...openings.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : [])),
    ])
    const results = await Promise.allSettled(
      [...handles].map(async (handle) => {
        await handle.cancel?.()
        await handle.close()
      }),
    )
    const failures = results.flatMap((item) => (item.status === 'rejected' ? [item.reason] : []))
    for (const drain of retryDrains) {
      try {
        await this.dropLocalChild(drain.child.key, drain.child)
      } catch (error) {
        failures.push(error)
      }
    }
    // An opener may fail its rollback drain while this close waits. That failure must retain
    // the parent writer; a subsequent close retries the exact owned child, never a replacement.
    for (const drain of this.failedDrains.values())
      if (!retryDrains.includes(drain)) failures.push(drain.error)
    if (failures.length) throw new AggregateError(failures, 'owned child drain failed')
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

    const opening = this.openAttempt(kind, parent, record, opts, modelTarget, delegation).finally(() => {
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
    modelTarget?: { route: string; model: string },
    delegation?: {
      kind: ChildKind
      creationId: string
      rootTaskId: string
      generationDepth: number
    },
  ): Promise<ChildHandle> {
    const store = requireChildControl(parent.d.log.storage)
    let attempt = (await store.lookupByKey(initial.childKey)) ?? initial
    if (attempt.creationPhase === 'deferred') {
      const begun = await store.beginChildAttempt({
        childKey: attempt.childKey,
        creationId: attempt.creationId,
        previousAttemptId: attempt.attemptId,
        nextAttemptId: `attempt:${this.kernel.ids.ulid()}`,
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
      assertCreationLive(parent, opts.signal)
      workspace = await parent.d.childWorkspaceRuntime?.reserve(parent.key, attempt.childKey)
      assertCreationLive(parent, opts.signal)
      handle = await this.attach(kind, parent, attempt, opts, modelTarget, delegation, workspace)
      assertCreationLive(parent, opts.signal)
      if (workspace && !workspace.commit())
        throw new CoreError('E_WORKSPACE_CLOSED', 'child workspace closed before commit', {
          childKey: attempt.childKey,
        })
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
      const live = (await store.lookupByKey(attempt.childKey)) ?? attempt
      assertCreationLive(parent, opts.signal)
      if (live.state === 'creating') await store.casState(live.childKey, live.stateRevision, 'ready')
      assertCreationLive(parent, opts.signal)
      this.handles.set(attempt.childKey, handle)
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
          await this.cancelOpenAttempt(store, parent, live)
        } catch (cause) {
          cancellationError = cause
        }
      }
      if (
        !cancellationError &&
        live?.creationPhase === 'committed' &&
        (parent.closingOrClosed || opts.signal?.aborted) &&
        !isTerminalChildState(live.state)
      ) {
        try {
          await store.casState(live.childKey, live.stateRevision, 'cancelled')
        } catch (cause) {
          cancellationError = cause
        }
      }
      let workspaceCloseDelegated = false
      const child = this.kernel.sessions.get(attempt.childKey)
      if (handle) {
        workspaceCloseDelegated = true
        try {
          await handle.close()
        } catch (cause) {
          if (child && !child.d.log.isClosed) this.failedDrains.set(attempt.childKey, { child, error: cause })
          cancellationError ??= cause
        }
      } else if (child) {
        workspaceCloseDelegated = true
        try {
          await this.dropLocalChild(attempt.childKey, child)
        } catch (cause) {
          cancellationError ??= cause
        }
      }
      if (!workspaceCloseDelegated) await workspace?.close().catch(() => undefined)
      if (!this.failedDrains.has(attempt.childKey)) this.handles.delete(attempt.childKey)
      if (cancellationError)
        throw new AggregateError([error, cancellationError], 'child open and durable cancellation failed')
      throw error
    }
  }

  private async cancelOpenAttempt(
    store: ReturnType<typeof requireChildControl>,
    parent: SessionImpl,
    attempt: ChildTaskRecord,
  ): Promise<void> {
    let failure: unknown
    for (let tries = 0; tries < 3; tries += 1) {
      try {
        await store.cancelCreatingChild({
          childKey: attempt.childKey,
          creationId: attempt.creationId,
          attemptId: attempt.attemptId,
          expectedRevision: attempt.creationRevision,
          reason: 'open_failed',
          cancelledAt: parent.d.clock(),
        })
        return
      } catch (error) {
        if (error instanceof CoreError && error.code === 'E_CAS') throw error
        failure = error
      }
    }
    throw new CoreError('E_STORAGE_FAULT', 'failed to persist child open cancellation', {
      childKey: attempt.childKey,
      attemptId: attempt.attemptId,
      cause: failure instanceof Error ? failure.message : String(failure),
    })
  }

  private owns(record: ChildTaskRecord, caller: string): boolean {
    return record.parentKey === caller || record.runtimeOwnerSessionKey === caller
  }

  private async cancelTree(store: ReturnType<typeof requireChildControl>, childKey: string): Promise<void> {
    let record = await store.lookupByKey(childKey)
    if (!record) return
    // A settled turn is not the end of a continuable conversation. Cancellation must persist
    // even when it races the explicit ready CAS used by a follow-up.
    while (record.state === 'completed' || record.state === 'failed' || record.state === 'interrupted') {
      if (record.creationPhase !== 'committed') {
        for (const kid of await store.listByParent(childKey)) await this.cancelTree(store, kid.childKey)
        return
      }
      if (await store.cancelContinuation({ childKey, expectedRevision: record.stateRevision })) {
        for (const kid of await store.listByParent(childKey)) await this.cancelTree(store, kid.childKey)
        const child = this.sessions.get(childKey)
        if (child) await this.dropLocalChild(childKey, child)
        return
      }
      const current = await store.lookupByKey(childKey)
      if (!current) return
      record = current
    }
    if (record.state === 'cancelled') return
    this.kernel.get(childKey)?.ac.abort()
    const handle = this.handles.get(childKey)
    if (handle?.cancel) await handle.cancel()
    else if (this.kernel.get(childKey)) {
      const live = await store.lookupByKey(childKey)
      if (live) await store.casState(childKey, live.stateRevision, 'cancelling')
    } else {
      await store.casState(childKey, record.stateRevision, 'cancelling')
    }
    for (const kid of await store.listByParent(childKey)) await this.cancelTree(store, kid.childKey)
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

  async sendMessage(
    childKey: string,
    input: string,
    options: { deliveryId: string; parentEffectId: string; signal: AbortSignal },
  ): Promise<{ childKey: string; messageId: string; acceptedSeq: number }> {
    const prior = this.deliveries.get(childKey) ?? Promise.resolve()
    const attempt = async () => {
      const parent = this.parent()
      assertCreationLive(parent, options.signal)
      await parent.d.log.storage.assertSessionAdmitted?.(parent.key)
      await parent.d.log.storage.assertSessionAdmitted?.(childKey)
      if (this.kernel.get(parent.key) !== parent)
        throw new CoreError('E_CLOSED', 'continuation requires the exact live owner')
      const store = requireChildControl(parent.d.log.storage)
      const senderRecord = await store.lookupByKey(parent.key)
      if (senderRecord?.parentKey === childKey) {
        const receiver = this.kernel.get(childKey)
        if (
          !receiver ||
          receiver.closingOrClosed ||
          !(receiver.d.children instanceof KernelChildren) ||
          receiver.d.children.sessions.get(parent.key) !== parent ||
          !(await receiver.d.children.ownsDirectRecord(receiver, senderRecord)) ||
          parent.d.runtimeOwnerSessionKey !== childKey ||
          senderRecord.state === 'cancelling' ||
          senderRecord.state === 'cancelled'
        )
          throw new CoreError('E_UNSUPPORTED', 'direct parent is not live or sender is not resident')
        await readChildDescriptor(receiver, senderRecord)
        const message = await persistParentMessage(parent, receiver.key, {
          deliveryId: `agent:${options.deliveryId}`,
          kind: 'agent-message',
          text: `Agent ${parent.key} sent a message: ${input}`,
        })
        options.signal.throwIfAborted()
        let receipt: Awaited<ReturnType<typeof receiveParentMessage>>
        try {
          receipt = await receiveParentMessage(receiver, message)
        } catch (error) {
          if (error instanceof CoreError && error.code === 'E_LANE_BUSY')
            this.deferParentDelivery(receiver, parent, message)
          throw error
        }
        this.requestWake(receiver)
        await acknowledgeParentMessage(parent, message, receipt)
        return receipt
      }
      let record = await store.lookupByKey(childKey)
      if (!record || !(await this.ownsDirectRecord(parent, record)))
        throw new CoreError('E_CHILD_NOT_FOUND', 'child does not belong to this owner')
      await readChildDescriptor(parent, record)
      if (
        record.state === 'cancelled' ||
        record.state === 'cancelling' ||
        record.creationPhase !== 'committed'
      )
        throw new CoreError('E_UNSUPPORTED', 'child cannot accept continuation')
      const accepted = await readChildDelivery(parent, record, input, options)
      if (accepted && isTerminalChildState(record.state)) return accepted
      if (this.admissionClosed.has(childKey)) {
        await this.runningChildren.get(childKey)?.catch(() => undefined)
        if (this.failedDrains.has(childKey)) throw new CoreError('E_CLOSED', 'child owner has not drained')
      }
      let handle = this.handles.get(childKey)
      let child = this.sessions.get(childKey)
      if (!handle || !child) {
        const signal = AbortSignal.any([options.signal, this.lifetime.signal])
        const workspace = await parent.d.childWorkspaceRuntime?.reserve(parent.key, childKey)
        try {
          handle = await this.attach(
            record.kind,
            parent,
            record,
            {
              parent: parent.key,
              cwd: record.cwd,
              signal,
            },
            record.model,
            undefined,
            workspace,
            true,
          )
          child = this.sessions.get(childKey)
          if (workspace && !workspace.commit())
            throw new CoreError('E_WORKSPACE_CLOSED', 'continuation workspace closed before admission')
          this.handles.set(childKey, handle)
        } catch (error) {
          const opened = this.sessions.get(childKey)
          if (opened) await this.dropLocalChild(childKey, opened)
          else await workspace?.close()
          throw error
        }
      }
      if (!child) throw new CoreError('E_RELATION', 'continuation session is unavailable')
      const residentRunning = (await handle.status()).state === 'running' && record.state === 'running'
      // Runtime-owned UNKNOWN effects remain parked; a new prompt cannot clear them.
      const phase = child.runtimeState().phase
      if (phase === 'parked' || (!residentRunning && child.pendingEffects().length))
        throw new CoreError('E_UNSUPPORTED', 'child requires effect reconciliation before continuation')
      record = (await store.lookupByKey(childKey)) ?? record
      const running = residentRunning
      if (!running && isTerminalChildState(record.state)) {
        const admitted = await store.beginContinuation({ childKey, expectedRevision: record.stateRevision })
        if (!admitted) throw new CoreError('E_CAS', 'child continuation changed before admission')
      }
      const receipt = await deliverChildMessage(
        child,
        parent,
        input,
        options,
        () => !this.admissionClosed.has(childKey),
      )
      if (!running) void handle.run(record.inputText).catch(() => undefined)
      else if (child.ac.signal.aborted) {
        const active = this.runningChildren.get(childKey)
        const resident = handle
        void active
          ?.catch(() => undefined)
          .then(async () => {
            const current = await store.lookupByKey(childKey)
            if (current?.state !== 'interrupted' || parent.closingOrClosed) return
            const restored = await store.beginContinuation({
              childKey,
              expectedRevision: current.stateRevision,
            })
            if (restored) await resident.run(current.inputText)
          })
          .catch(() => undefined)
      }
      return receipt
    }
    const delivery = prior
      .catch(() => undefined)
      .then(async () => {
        for (;;) {
          try {
            return await attempt()
          } catch (error) {
            if (
              !(error instanceof CoreError) ||
              error.code !== 'E_CLOSED' ||
              !this.admissionClosed.has(childKey) ||
              this.failedDrains.has(childKey) ||
              !this.runningChildren.has(childKey)
            )
              throw error
            await this.runningChildren.get(childKey)?.catch(() => undefined)
            options.signal.throwIfAborted()
          }
        }
      })
    this.deliveries.set(childKey, delivery)
    void delivery
      .finally(() => {
        if (this.deliveries.get(childKey) === delivery) this.deliveries.delete(childKey)
      })
      .catch(() => undefined)
    return delivery
  }

  private deferParentDelivery(
    receiver: SessionImpl,
    sender: SessionImpl,
    message: Awaited<ReturnType<typeof persistParentMessage>>,
  ): void {
    const key = `${receiver.key}\u0000${sender.key}\u0000${message.data.deliveryId}`
    if (this.deferredParentDeliveries.has(key)) return
    const writer = receiver.writerRunId
    let offIdle: (() => void) | undefined
    let offClose: (() => void) | undefined
    let stopped = false
    let running = false
    const stop = () => {
      stopped = true
      offIdle?.()
      offClose?.()
      this.deferredParentDeliveries.delete(key)
    }
    const watch = () => {
      offIdle ??= receiver.onExecutionIdle(() => {
        offIdle?.()
        offIdle = undefined
        void attempt()
      })
      // A hold can finish between receive's rejection and subscription. Avoid losing that edge.
      if (!receiver.configurationReserved && !receiver.idleGateReserved && !receiver.executionActive) {
        offIdle?.()
        offIdle = undefined
        queueMicrotask(() => {
          void attempt()
        })
      }
    }
    const attempt = async () => {
      if (stopped || running) return
      if (
        this.kernel.get(receiver.key) !== receiver ||
        receiver.writerRunId !== writer ||
        receiver.closingOrClosed
      ) {
        stop()
        return
      }
      if (receiver.configurationReserved || receiver.idleGateReserved || receiver.executionActive) {
        watch()
        return
      }
      running = true
      try {
        const source = (
          await sender.d.log.storage.scan(sender.key, { fromSeq: message.seq, toSeq: message.seq, limit: 1 })
        )[0]
        if (
          !source ||
          source.type !== 'x/core/child-outbox' ||
          source.origin !== 'system' ||
          source.trust !== 'trusted' ||
          source.lane !== sender.lane ||
          canonicalJson(source.data) !== canonicalJson(message.data) ||
          message.data.senderKey !== sender.key ||
          message.data.parentKey !== receiver.key
        )
          throw new CoreError('E_CHILD_CONFLICT', 'Deferred parent outbox source differs')
        if (this.kernel.get(receiver.key) !== receiver || receiver.closingOrClosed) {
          stop()
          return
        }
        const receipt = await receiveParentMessage(receiver, message)
        this.requestWake(receiver)
        stop()
        if (!sender.closingOrClosed && this.kernel.get(sender.key) === sender)
          await acknowledgeParentMessage(sender, message, receipt)
      } catch (error) {
        if (error instanceof CoreError && error.code === 'E_LANE_BUSY' && !receiver.closingOrClosed) watch()
        else stop() // Source/owner failures remain unknown in the durable outbox.
      } finally {
        running = false
      }
    }
    this.deferredParentDeliveries.set(key, stop)
    offClose = receiver.onClosing(stop)
    void attempt()
  }

  private requestWake(receiver: SessionImpl): void {
    requestParentWake(receiver, async () => {
      if (this.kernel.get(receiver.key) !== receiver || receiver.closingOrClosed)
        throw new CoreError('E_CLOSED', 'parent owner is unavailable')
      const record = await requireChildControl(receiver.d.log.storage).lookupByKey(receiver.key)
      const owner = record ? this.kernel.get(record.parentKey) : undefined
      if (
        record &&
        owner?.d.children instanceof KernelChildren &&
        owner.d.children.sessions.get(receiver.key) === receiver
      ) {
        const factory = owner.d.children
        // Its outer lifecycle is still running while it waits for descendants/inbox work.
        if (factory.runningChildren.has(receiver.key)) return
        const handle = factory.handles.get(receiver.key)
        if (!handle || record.state !== 'interrupted') return
        await readChildDescriptor(owner, record)
        const admitted = await requireChildControl(receiver.d.log.storage).beginContinuation({
          childKey: receiver.key,
          expectedRevision: record.stateRevision,
        })
        if (admitted) void handle.run(record.inputText).catch(() => undefined)
        return
      }
      await this.kernel.o.childParentWake?.(receiver)
    })
  }

  private async ownsDirectRecord(parent: SessionImpl, record: ChildTaskRecord): Promise<boolean> {
    if (record.parentKey !== parent.key) return false
    const parentTask = await requireChildControl(parent.d.log.storage).lookupByKey(parent.key)
    return record.runtimeOwnerSessionKey === (parentTask?.runtimeOwnerSessionKey ?? parent.key)
  }

  private ownedWork(): Promise<unknown>[] {
    const work: Promise<unknown>[] = [
      ...this.creating,
      ...this.opening.values(),
      ...this.deliveries.values(),
      ...this.runningChildren.values(),
    ]
    for (const session of this.sessions.values())
      if (session.d.children instanceof KernelChildren) work.push(...session.d.children.ownedWork())
    return work
  }

  private async waitForOwnedWork(owner: SessionImpl, signal: AbortSignal): Promise<void> {
    const work = this.ownedWork()
    if (!work.length) return
    signal.throwIfAborted()
    let notify!: () => void
    const changed = new Promise<void>((resolve) => {
      notify = resolve
    })
    const off = owner.onAppended(() => {
      if ((owner.latest('inbox') as { items?: unknown[] } | undefined)?.items?.length) notify()
    })
    const abort = () => notify()
    signal.addEventListener('abort', abort, { once: true })
    try {
      if ((owner.latest('inbox') as { items?: unknown[] } | undefined)?.items?.length) return
      await Promise.race([Promise.allSettled(work), changed])
      signal.throwIfAborted()
    } finally {
      off()
      signal.removeEventListener('abort', abort)
    }
  }

  async interrupt(childKey: string): Promise<void> {
    const parent = this.parent()
    assertCreationLive(parent, this.lifetime.signal)
    if (this.kernel.get(parent.key) !== parent)
      throw new CoreError('E_CLOSED', 'interrupt requires the exact live owner')
    await parent.d.log.storage.assertSessionAdmitted?.(parent.key)
    await parent.d.log.storage.assertSessionAdmitted?.(childKey)
    const record = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
    if (!record || !(await this.ownsDirectRecord(parent, record)))
      throw new CoreError('E_CHILD_NOT_FOUND', 'unknown child')
    await readChildDescriptor(parent, record)
    const child = this.sessions.get(childKey)
    if (!child?.state.openTurn.has(child.lane)) return
    this.interrupted.add(childKey)
    await child.abort(parent.d.actor)
  }

  async cancel(childKey: string): Promise<void> {
    const parent = this.parent()
    const store = requireChildControl(parent.d.log.storage)
    const record = await store.lookupByKey(childKey)
    if (!record || !this.owns(record, parent.key))
      throw new CoreError('E_CHILD_NOT_FOUND', `unknown child ${childKey}`, { childKey })
    await this.cancelTree(store, childKey)
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
      run: (input, runOptions) =>
        this.detached(async () => {
          const live = (await store.lookupByKey(record.childKey)) ?? record
          if (this.handles.get(record.childKey) === handle) this.handles.delete(record.childKey)
          const { signal: _creationSignal, ...deferredOpts } = opts
          inner ??= await this.open(
            kind,
            parent,
            live,
            {
              ...deferredOpts,
              ...(runOptions?.signal ? { signal: runOptions.signal } : {}),
              cwd: live.creationCwd ?? opts.cwd,
              input: input ?? live.inputText,
            },
            modelTarget,
            delegation,
          )
          this.handles.set(record.childKey, inner)
          return (this.direct.get(inner) ?? inner.run)(input ?? live.inputText, runOptions)
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
    modelTarget?: { route: string; model: string },
    delegation?: {
      kind: ChildKind
      creationId: string
      rootTaskId: string
      generationDepth: number
    },
    workspace?: ChildWorkspaceLifecycle,
    continuation = false,
  ): Promise<ChildHandle> {
    modelTarget = record.model ?? modelTarget
    const childPreset = {
      ...(modelTarget
        ? {
            ...parent.preset,
            model: {
              ...parent.preset.model,
              route: { ...parent.preset.model.route, primary: modelTarget.route },
              id: { ...parent.preset.model.id, primary: modelTarget.model },
            },
          }
        : parent.preset),
    }
    const store = requireChildControl(parent.d.log.storage)
    const cwd =
      workspace?.runtime.identity?.canonicalRoot ??
      (await store.lookupByKey(record.childKey))?.cwd ??
      record.cwd ??
      opts.cwd
    const options = {
      runtimeOwnerSessionKey: parent.key,
      actor: parent.d.actor,
      resolvedProfileHash: parent.d.resolvedProfileHash,
      preset: childPreset,
      cwd,
      writerRunId: `${parent.writerRunId}/child/${this.kernel.ids.ulid()}`,
      lane: parent.lane,
      ...(workspace
        ? {
            workspaceRuntime: workspace.runtime,
            workspaceIdentity: workspace.runtime.identity,
            workspaceLease: workspace,
            ...(workspace.sandbox ? { seams: { sandbox: workspace.sandbox } } : {}),
          }
        : {}),
      ...(parent.d.childWorkspaceRuntime ? { childWorkspaceRuntime: parent.d.childWorkspaceRuntime } : {}),
      delegation: delegation ?? {
        kind: record.kind,
        creationId: record.creationId,
        rootTaskId: record.rootTaskId,
        generationDepth: record.generationDepth,
      },
    }
    const history = continuation
      ? { kind: 'existing' as const }
      : (record.seedMode ?? 'history') === 'history' && record.boundarySeq > 0
        ? { kind: 'history' as const, parentKey: parent.key, boundarySeq: record.boundarySeq }
        : { kind: 'fresh' as const }
    assertCreationLive(parent, opts.signal)
    const child = this.kernel.o.childSessionOpen
      ? await this.kernel.o.childSessionOpen(parent, {
          key: record.childKey,
          options,
          seed: history,
          signal: opts.signal ?? new AbortController().signal,
        })
      : await this.kernel.session(record.childKey, {
          ...options,
          ...(history.kind === 'history'
            ? { parent: { key: history.parentKey, boundarySeq: history.boundarySeq } }
            : {}),
        })
    this.sessions.set(record.childKey, child)
    if (!continuation && record.runtime && record.model) {
      const descriptors = await child.scan({
        type: CHILD_DESCRIPTOR,
        fromSeq: record.boundarySeq + 1,
        limit: 2,
      })
      // A creation retry may reopen a log whose descriptor was already admitted. Never
      // append a second authority row, and do not adopt legacy children during continuation.
      if (descriptors.length === 0)
        await child.d.log.append([
          child.ev(
            CHILD_DESCRIPTOR,
            {
              version: 1,
              mode: kind === 'spawn' ? 'continuable' : 'one-shot',
              childKey: record.childKey,
              parentKey: parent.key,
              runtime: record.runtime,
              model: record.model,
              preset: childPreset.name,
              actor: { id: parent.d.actor.id, org: parent.d.actor.org, role: parent.d.actor.role },
            },
            { ignorable: true },
          ),
        ])
      else if (kind === 'spawn') await readChildDescriptor(parent, record)
    }
    const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
    const body = opts.input ?? record.inputText
    if (!continuation && body && !inbox?.items?.length) {
      await child.enqueue('next-turn', {
        content: [{ type: 'text', text: body }],
        actor: child.d.actor,
      })
    }

    let state: 'ready' | 'running' | 'done' | 'error' | 'cancelled' =
      !continuation && record.state === 'running' ? 'running' : 'ready'
    let ended = false
    let cachedText = ''
    let cachedSeq = 0
    let outputFromSeq = record.boundarySeq + 1
    let settlement: Awaited<ReturnType<typeof persistParentMessage>> | undefined
    let creditsAtOpen = child.state.creditsUsed
    const lastText = async (): Promise<string> => {
      const rows = await child.scan({
        type: 'assistant/message',
        fromSeq: outputFromSeq,
        order: 'desc',
        limit: 1,
      })
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
          locked
            ? 'cancelled'
            : outcome === 'cancelled'
              ? this.interrupted.has(record.childKey)
                ? 'interrupted'
                : 'cancelled'
              : outcome === 'completed'
                ? 'completed'
                : 'failed',
        )
      }
      // Hooks and the cost row report what was stored, which an earlier settlement may have decided.
      const stored = (await store.lookupByKey(record.childKey))?.state
      if (stored && isTerminalChildState(stored))
        outcome = stored === 'interrupted' ? 'cancelled' : (stored as typeof outcome)
      await parent.hooks
        .subagentEnd?.({ childKey: record.childKey, outcome, credits: Math.max(0, child.state.creditsUsed) })
        .catch(() => undefined)
      const cost = (
        await child
          .scan({ type: 'cost/ledger', fromSeq: record.boundarySeq + 1, order: 'desc', limit: 1 })
          .catch(() => [])
      )[0]
      const credits = Math.max(0, child.state.creditsUsed - creditsAtOpen)
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
        .catch(() => undefined)
      const terminal = await store.lookupByKey(record.childKey)
      if (
        kind === 'spawn' &&
        record.runtime &&
        record.model &&
        terminal &&
        !(
          this.interrupted.has(record.childKey) &&
          child.d.children instanceof KernelChildren &&
          child.d.children.ownedWork().length
        )
      ) {
        const summary =
          outcome === 'completed'
            ? `Background subagent ${record.childKey} finished and will do no further work unless you send it more.`
            : `Background subagent ${record.childKey} ${outcome === 'cancelled' ? 'was stopped' : 'failed'} before it finished.`
        settlement = await persistParentMessage(child, parent.key, {
          deliveryId: `settled:${terminal.stateRevision}`,
          kind: 'subagent-settled',
          outcome,
          text: `${summary}\n${cachedText ? `Its closing message:\n${cachedText}` : 'It left no closing message.'}`,
        })
      }
    }
    const controller = new AbortController()
    let activeRun: Promise<{ text: string; lastSeq: number }> | undefined
    const handle: ChildHandle = {
      key: record.childKey,
      run: (input, runOptions) => {
        if (activeRun)
          return Promise.reject(new CoreError('E_LANE_BUSY', `child ${record.childKey} already started`))
        const run = async () => {
          const durable = await store.lookupByKey(record.childKey)
          if (durable && (isTerminalChildState(durable.state) || durable.state === 'cancelling'))
            throw new CoreError('E_UNSUPPORTED', `child ${record.childKey} is ${durable.state}`)
          if (runOptions?.signal?.aborted || controller.signal.aborted)
            throw new DOMException('child run cancelled', 'AbortError')
          if (ended && kind === 'spawn' && durable?.state === 'ready') {
            ended = false
            state = 'ready'
            creditsAtOpen = child.state.creditsUsed
          }
          if (state !== 'ready')
            throw new CoreError('E_LANE_BUSY', `child ${record.childKey} already started`)
          if (!continuation && input !== undefined && sha256Hex(input) !== record.inputHash)
            throw new CoreError('E_CHILD_CONFLICT', 'run input does not match persisted create input')
          const live = await store.lookupByKey(record.childKey)
          if (live && !(await store.casState(record.childKey, live.stateRevision, 'running')))
            throw new CoreError('E_UNSUPPORTED', `child ${record.childKey} cannot start from ${live.state}`)
          state = 'running'
          outputFromSeq = child.lastSeq + 1
          settlement = undefined
          try {
            await retargetInterruptedInbox(child)
            const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
            if (!inbox?.items?.length) {
              await child.enqueue('next-turn', {
                content: [{ type: 'text', text: input ?? '' }],
                actor: child.d.actor,
              })
            }
            for (;;) {
              await retargetInterruptedInbox(child)
              const result = await child.run({
                until: kind === 'spawn' ? 'idle' : 'turn-end',
                signal: runOptions?.signal
                  ? AbortSignal.any([controller.signal, runOptions.signal])
                  : controller.signal,
              })
              if (result.reason !== 'completed') {
                state = result.reason === 'aborted' || result.reason === 'interrupted' ? 'cancelled' : 'error'
                throw new CoreError('E_RELATION', `child turn ended ${result.reason}`)
              }
              const more = await child.locked(async () => {
                const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
                if (kind === 'spawn' && inbox?.items?.length) return true
                if (
                  kind === 'spawn' &&
                  child.d.children instanceof KernelChildren &&
                  child.d.children.ownedWork().length
                )
                  return 'wait' as const
                this.admissionClosed.add(record.childKey)
                return false
              })
              if (more === 'wait' && child.d.children instanceof KernelChildren) {
                await child.d.children.waitForOwnedWork(child, child.ac.signal)
                continue
              }
              if (!more) break
            }
            state = 'done'
            return { text: await lastText(), lastSeq: child.lastSeq }
          } catch (error) {
            if (state === 'running') state = child.ac.signal.aborted ? 'cancelled' : 'error'
            throw error
          } finally {
            cachedText = await lastText().catch(() => cachedText)
            cachedSeq = child.lastSeq
            await emitEnd(state === 'done' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed')
            // An interrupt preserves the live conversation and its published descendants.
            if (!this.interrupted.delete(record.childKey)) await this.dropLocalChild(record.childKey, child)
            if (settlement && this.kernel.get(parent.key) === parent && !parent.closingOrClosed) {
              // Source was persisted by the child owner; receipt waits for successful descendant drain.
              // The parent's receipt is canonical even when the child writer has already closed.
              try {
                await receiveParentMessage(parent, settlement)
                this.requestWake(parent)
              } catch (error) {
                if (error instanceof CoreError && error.code === 'E_LANE_BUSY')
                  this.deferParentDelivery(parent, child, settlement)
                // Other source/owner failures remain pending; never guess a cold parent owner.
              }
            }
          }
        }
        const result = runWithInheritedConfigurationApproval(parent, child, run)
        activeRun = result
        this.runningChildren.set(record.childKey, result)
        const settled = () => {
          if (activeRun === result) activeRun = undefined
          if (this.runningChildren.get(record.childKey) === result)
            this.runningChildren.delete(record.childKey)
          // Delivery can precede the interrupt signal. Resume only its still-pending inbox,
          // after this run drained, through the same fenced new-turn CAS as a normal follow-up.
          void (async () => {
            if (
              kind !== 'spawn' ||
              parent.closingOrClosed ||
              child.closingOrClosed ||
              child.runtimeState().phase === 'parked' ||
              child.pendingEffects().length
            )
              return
            const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
            if (!inbox?.items?.length) return
            const current = await store.lookupByKey(record.childKey)
            if (current?.state !== 'interrupted') return
            const admitted = await store.beginContinuation({
              childKey: record.childKey,
              expectedRevision: current.stateRevision,
            })
            if (admitted) await handle.run(current.inputText)
          })().catch(() => undefined)
        }
        void result.then(settled, settled)
        return result
      },
      status: async (): Promise<ChildStatus> => {
        const terminal = state === 'done' || state === 'error' || state === 'cancelled'
        const text = terminal ? cachedText : await lastText().catch(() => cachedText)
        return {
          state:
            state === 'cancelled'
              ? 'cancelled'
              : state === 'error'
                ? 'error'
                : state === 'done'
                  ? 'done'
                  : 'running',
          lastSeq: terminal ? cachedSeq : child.lastSeq,
          ...(text ? { text } : {}),
        }
      },
      close: async () => {
        controller.abort()
        child.ac.abort()
        await activeRun?.catch(() => undefined)
        if (!this.kernel.sessions.has(record.childKey)) return
        const durable = await store.lookupByKey(record.childKey)
        if (durable && isTerminalChildState(durable.state))
          state =
            durable.state === 'cancelled' ? 'cancelled' : durable.state === 'completed' ? 'done' : 'error'
        if (kind === 'spawn' && (state === 'ready' || state === 'running')) {
          const live = await store.lookupByKey(record.childKey)
          if (live) await store.casState(record.childKey, live.stateRevision, 'recovery_pending')
          await this.dropLocalChild(record.childKey, child)
          return
        }
        if (state === 'ready' || state === 'running') state = 'cancelled'
        await this.dropLocalChild(record.childKey, child)
        await emitEnd(state === 'done' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed')
      },
      cancel: async () => {
        const idle = state === 'ready'
        if (state === 'ready' || state === 'running') {
          controller.abort()
          child.ac.abort()
          state = 'cancelled'
        }
        const live = await store.lookupByKey(record.childKey)
        if (live && live.state !== 'cancelled' && live.state !== 'completed' && live.state !== 'failed')
          await store.casState(record.childKey, live.stateRevision, idle ? 'cancelled' : 'cancelling')
        if (!idle) await activeRun?.catch(() => undefined)
        await emitEnd('cancelled')
        // Unstarted children never enter run.finally; release now. An in-flight run still owns the
        // session until that path ends — aborting is not proof it has stopped writing.
        if (idle) await this.dropLocalChild(record.childKey, child)
      },
    }
    const run = handle.run
    this.direct.set(handle, run)
    if (kind === 'spawn') handle.run = (input, runOptions) => this.detached(() => run(input, runOptions))
    await parent.hooks
      .subagentStart?.({ childKey: record.childKey, kind, budget: opts.budget ?? null })
      .catch(() => undefined)
    return handle
  }

  private resolveModel(parent: SessionImpl, selector: string): { route: string; model: string } | undefined {
    let models: ReturnType<Provider['models']>
    try {
      models = parent.d.provider.models()
    } catch {
      return undefined
    }
    const slotRoute = parent.preset.model.route[selector]
    if (slotRoute !== undefined) {
      const pinned = parent.preset.model.id[selector]
      const record = models.find(
        (item) => item.route === slotRoute && (pinned ? item.id === pinned : item.slot === selector),
      )
      const fallback = models.find((item) => item.route === slotRoute)
      const model = pinned ?? record?.id ?? fallback?.id
      return model === undefined ? undefined : { route: slotRoute, model }
    }
    const byId = models.filter((item) => item.id === selector)
    const currentRoute = parent.preset.model.route.primary ?? 'default'
    const current = byId.find((item) => item.route === currentRoute)
    if (current) return { route: current.route, model: current.id }
    const only = byId.length === 1 ? byId[0] : undefined
    if (only) return { route: only.route, model: only.id }
    const slash = selector.indexOf('/')
    if (slash > 0) {
      const route = selector.slice(0, slash)
      const model = selector.slice(slash + 1)
      if (models.some((item) => item.route === route && item.id === model)) return { route, model }
    }
    return undefined
  }
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

function parentBoundary(parent: SessionImpl, opts: CreateOpts, kind: ChildKind): number {
  return opts.forkAt ?? (kind === 'fork' ? parent.op()?.meta.triggerSeq : undefined) ?? parent.lastSeq
}

function assertCreationLive(parent: SessionImpl, signal?: AbortSignal): void {
  assertSessionIdleGateMutable(parent)
  if (parent.closingOrClosed) throw new CoreError('E_CLOSED', 'child owner is closing')
  signal?.throwIfAborted()
}

function snapshotFromRecord(record: ChildTaskRecord): ChildStatus {
  const terminal = isTerminalChildState(record.state)
  return {
    state:
      record.state === 'cancelled' || record.state === 'interrupted'
        ? 'cancelled'
        : record.state === 'failed'
          ? 'error'
          : terminal
            ? 'done'
            : 'running',
    lastSeq: 0,
  }
}

async function snapshotFromLedger(parent: SessionImpl, record: ChildTaskRecord): Promise<ChildStatus> {
  const base = snapshotFromRecord(record)
  try {
    const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
    const tail = await parent.d.log.storage.scan(record.childKey, { fromSeq, order: 'desc', limit: 1 })
    const msgs = await parent.d.log.storage.scan(record.childKey, {
      fromSeq,
      type: 'assistant/message',
      order: 'desc',
      limit: 1,
    })
    const content = (msgs[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content
    const text = (content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    return {
      ...base,
      lastSeq: tail[0]?.seq ?? base.lastSeq,
      ...(text ? { text } : {}),
    }
  } catch {
    return base
  }
}
