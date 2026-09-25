import type { Provider } from '@agnes/protocol'
import type { ChildHandle, ChildrenFactory, ChildStatus } from '../effects/tool-context.js'
import type { Kernel } from '../kernel.js'
import { sha256Hex } from '../request/hash.js'
import type { SessionImpl } from '../step/session.js'
import { CoreError } from '../types.js'
import type { ChildWorkspaceLifecycle } from '../workspace/runtime.js'
import { admitBudgetMode, admitGeneration } from './admission.js'
import { capToMicrocredits } from './credits.js'
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

export class KernelChildren implements ChildrenFactory {
  private readonly handles = new Map<string, ChildHandle>()
  private readonly opening = new Map<string, Promise<ChildHandle>>()

  constructor(
    private readonly kernel: Kernel,
    private readonly parent: () => SessionImpl,
  ) {}

  async create(opts: Parameters<ChildrenFactory['create']>[0]): Promise<ChildHandle> {
    return this.createWithKind('fork', opts)
  }

  async createWithKind(kind: ChildKind, opts: CreateOpts): Promise<ChildHandle> {
    const parent = this.parent()
    if (opts.parent !== parent.key)
      throw new CoreError('E_DEPTH_EXCEEDED', 'child factory parent mismatch', {
        expected: parent.key,
        actual: opts.parent,
      })
    if (opts.preset !== undefined && opts.preset !== parent.preset.name)
      throw new CoreError('E_DEPTH_EXCEEDED', 'default child factory cannot resolve another preset')

    const store = requireChildControl(parent.d.log.storage)
    const mode = admitBudgetMode(parent.preset.budgetInherit)
    if (!mode.ok) throw new CoreError('E_UNSUPPORTED', mode.message)

    const parentDepth = generationDepthOf(parent)
    const admitted = admitGeneration(parentDepth, parent.preset.generationLimit)
    if (!admitted.ok) throw new CoreError('E_CHILD_LIMIT', admitted.message)
    if (opts.input === undefined || opts.input.length === 0)
      throw new CoreError('E_ENVELOPE', 'child create requires task input')

    const effectId = opts.parentEffectId ?? 'direct'
    const inputHash = sha256Hex(opts.input)
    const prefix = `${parent.key}:${parent.lane}:${effectId}:`
    const reused = (await store.listByParent(parent.key)).find(
      (row) => row.creationId.startsWith(prefix) && row.inputHash === inputHash,
    )
    if (reused) {
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

    const created = await store.createDelegatedChild({
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

  private async dropLocalChild(childKey: string, child: SessionImpl): Promise<void> {
    this.handles.delete(childKey)
    if (this.kernel.sessions.get(childKey) === child) this.kernel.sessions.delete(childKey)
    await child.close().catch(() => undefined)
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
      workspace = await parent.d.childWorkspaceRuntime?.reserve(parent.key, attempt.childKey)
      handle = await this.attach(kind, parent, attempt, opts, modelTarget, delegation, workspace)
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
      if (live.state === 'creating') await store.casState(live.childKey, live.stateRevision, 'ready')
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
      let workspaceCloseDelegated = false
      if (handle) {
        workspaceCloseDelegated = true
        await handle.close().catch(() => undefined)
      }
      const child = this.kernel.sessions.get(attempt.childKey)
      if (child) {
        workspaceCloseDelegated = true
        await this.dropLocalChild(attempt.childKey, child)
      }
      if (!workspaceCloseDelegated) await workspace?.close().catch(() => undefined)
      this.handles.delete(attempt.childKey)
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
    const record = await store.lookupByKey(childKey)
    if (!record) return
    if (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled') return
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
      run: async (input) => {
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
        return inner.run(input ?? live.inputText)
      },
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
  ): Promise<ChildHandle> {
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
      compaction: { ...parent.preset.compaction, enabled: false },
    }
    const store = requireChildControl(parent.d.log.storage)
    const cwd = (await store.lookupByKey(record.childKey))?.cwd ?? record.cwd ?? opts.cwd
    const child = await this.kernel.session(record.childKey, {
      actor: parent.d.actor,
      resolvedProfileHash: parent.d.resolvedProfileHash,
      preset: childPreset,
      parent: {
        key: parent.key,
        boundarySeq: record.boundarySeq || parentBoundary(parent, opts, kind),
      },
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
    })
    const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
    const body = opts.input ?? record.inputText
    if (body && !inbox?.items?.length) {
      await child.enqueue('next-turn', {
        content: [{ type: 'text', text: body }],
        actor: child.d.actor,
      })
    }

    let state: 'ready' | 'running' | 'done' | 'error' | 'cancelled' =
      record.state === 'running' ? 'running' : 'ready'
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
        .catch(() => undefined)
    }
    const handle: ChildHandle = {
      key: record.childKey,
      run: async (input) => {
        const durable = await store.lookupByKey(record.childKey)
        if (durable && (isTerminalChildState(durable.state) || durable.state === 'cancelling'))
          throw new CoreError('E_UNSUPPORTED', `child ${record.childKey} is ${durable.state}`)
        if (state !== 'ready') throw new CoreError('E_LANE_BUSY', `child ${record.childKey} already started`)
        if (input !== undefined && sha256Hex(input) !== record.inputHash)
          throw new CoreError('E_CHILD_CONFLICT', 'run input does not match persisted create input')
        const live = await store.lookupByKey(record.childKey)
        if (live && !(await store.casState(record.childKey, live.stateRevision, 'running')))
          throw new CoreError('E_UNSUPPORTED', `child ${record.childKey} cannot start from ${live.state}`)
        state = 'running'
        try {
          const inbox = child.latest('inbox') as { items?: unknown[] } | undefined
          if (!inbox?.items?.length) {
            await child.enqueue('next-turn', {
              content: [{ type: 'text', text: input ?? '' }],
              actor: child.d.actor,
            })
          }
          const result = await child.run({
            until: 'turn-end',
            signal: new AbortController().signal,
          })
          if (result.reason !== 'completed') {
            state = result.reason === 'aborted' || result.reason === 'interrupted' ? 'cancelled' : 'error'
            throw new CoreError('E_RELATION', `child turn ended ${result.reason}`)
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
          await this.dropLocalChild(record.childKey, child)
        }
      },
      status: async (): Promise<ChildStatus> => {
        const terminal = state === 'done' || state === 'error' || state === 'cancelled'
        const text = terminal ? cachedText : await lastText().catch(() => cachedText)
        return {
          state: state === 'error' || state === 'cancelled' ? 'error' : state === 'done' ? 'done' : 'running',
          lastSeq: terminal ? cachedSeq : child.lastSeq,
          ...(text ? { text } : {}),
        }
      },
      close: async () => {
        if (kind === 'spawn' && (state === 'ready' || state === 'running')) {
          const live = await store.lookupByKey(record.childKey)
          if (live) await store.casState(record.childKey, live.stateRevision, 'recovery_pending')
          await child.close()
          this.kernel.sessions.delete(record.childKey)
          this.handles.delete(record.childKey)
          return
        }
        if (state === 'ready' || state === 'running') state = 'cancelled'
        await child.close()
        this.kernel.sessions.delete(record.childKey)
        this.handles.delete(record.childKey)
        await emitEnd(state === 'done' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed')
      },
      cancel: async () => {
        const idle = state === 'ready'
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

function snapshotFromRecord(record: ChildTaskRecord): ChildStatus {
  const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled'
  return {
    state:
      record.state === 'failed' || record.state === 'cancelled' ? 'error' : terminal ? 'done' : 'running',
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
