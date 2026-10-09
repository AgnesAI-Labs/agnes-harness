import {
  normalizeRuntimeError,
  type PluginRuntimeError,
  type PluginRuntimePhase,
  type RuntimeErrorStage,
  RuntimeStatusStore,
} from '@agnes/web-foundation/client-modules/runtime-status'
import { rowKey } from './reconcile/catalog.js'
import type {
  ClientModuleLifecycleStep,
  ClientReconciler,
  ClientRoster,
  PackageState,
  PreparedClientStyles,
  ReadyClientModule,
  ReconcilerOptions,
} from './reconcile/contracts.js'
import { createReconcileLifecycle } from './reconcile/lifecycle.js'
import { prepareDocumentStyles } from './reconcile/styles.js'

const DEFAULT_TIMEOUTS = { import: 15_000, styles: 15_000, apply: 15_000, dispose: 5_000 }

export function createReconciler(options: ReconcilerOptions): ClientReconciler {
  const { ctx, source, locale } = options
  const removeOwner =
    options.removeOwner ??
    ((packageId: string) => {
      const registry = (ctx as unknown as { slots?: { removeOwner(owner: string): void } }).slots
      registry?.removeOwner(packageId)
    })
  let importGeneration = 0
  const importer =
    options.importer ??
    ((url: string) => {
      // Native ESM namespaces are cached by the complete URL.  Development builds deliberately
      // keep the roster revision stable, so importing the bare entryUrl would return the old
      // namespace forever.  A fresh query is only the browser-native cache boundary; the server
      // still serves the same immutable path and the roster remains the identity authority.
      const separator = url.includes('?') ? '&' : '?'
      return import(/* @vite-ignore */ `${url}${separator}agnes_hmr=${++importGeneration}`)
    })
  const prepareStyles = options.prepareStyles ?? prepareDocumentStyles
  const moduleCache = options.moduleCache ?? { delete: () => undefined }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  const packages = new Map<string, PackageState>()
  const statuses = new RuntimeStatusStore()

  async function lifecycle(step: ClientModuleLifecycleStep, packageId: string): Promise<void> {
    await options.onLifecycleStep?.(step, packageId)
  }

  function stateOf(packageId: string): PackageState {
    let state = packages.get(packageId)
    if (!state) {
      state = {
        packageId,
        revision: undefined,
        phase: 'idle',
        epoch: 0,
        target: undefined,
        active: undefined,
        ownerRowId: undefined,
        fiber: undefined,
        styles: undefined,
        draining: undefined,
        rosterPresent: false,
        cleanup: { fiber: undefined, styles: undefined },
        cleanupPending: false,
        cleanupQueued: false,
        failure: undefined,
        chain: Promise.resolve(),
      }
      packages.set(packageId, state)
    }
    return state
  }

  function setPhase(
    rowId: string,
    state: PackageState,
    phase: PluginRuntimePhase,
    failure?: PluginRuntimeError,
  ): void {
    state.phase = phase
    state.failure = failure
    statuses.set(
      {
        packageId: state.packageId,
        revision: state.revision,
        phase,
        ...(failure === undefined ? {} : { error: failure }),
      },
      rowId,
    )
  }

  function fail(rowId: string, state: PackageState, stage: RuntimeErrorStage): void {
    setPhase(
      rowId,
      state,
      'failed',
      normalizeRuntimeError(stage, undefined, (key) => locale?.t(key) ?? key),
    )
  }

  function registrationOwner(rowId: string, state: PackageState): string {
    return state.ownerRowId ?? rowId
  }

  const registry = (
    ctx as unknown as {
      slots?: {
        spec?: (name: string) => unknown
        onEntryError?: (
          listener: (
            name: string,
            entry: { owner?: string },
            error: unknown,
            info: { abdicated: boolean },
          ) => void,
        ) => () => void
      }
    }
  ).slots
  registry?.onEntryError?.((_name, entry) => {
    if (!entry.owner) return
    const state = packages.get(entry.owner)
    if (state?.phase !== 'active') return
    fail(entry.owner, state, 'render')
  })
  const { applyTarget, drainFiber, disposeCleanup } = createReconcileLifecycle({
    ctx,
    registry,
    timeouts,
    importer,
    prepareStyles,
    moduleCache,
    removeOwner,
    registrationOwner,
    lifecycle,
    fail,
    setPhase,
  })

  function migrateRosterAliases(
    rawAliases: Readonly<Record<string, string>> | undefined,
    wanted: Map<string, ReadyClientModule>,
  ): Set<string> {
    const isWebRowId = (value: string): boolean =>
      value.startsWith('web:') && value.length >= 5 && value.length <= 256 && !value.includes('\0')
    const blocked = new Set<string>()
    const raw = new Map(Object.entries(rawAliases ?? {}))
    const resolved = new Map<string, string>()
    const resolving = new Set<string>()
    const resolve = (source: string): string | undefined => {
      const cached = resolved.get(source)
      if (cached !== undefined) return cached
      if (resolving.has(source)) return undefined
      resolving.add(source)
      const target = raw.get(source)
      const value = target === undefined ? source : resolve(target)
      resolving.delete(source)
      if (value !== undefined) resolved.set(source, value)
      return value
    }
    const sourcesByTarget = new Map<string, string[]>()
    for (const [oldRowId, rawTarget] of raw) {
      if (!isWebRowId(oldRowId) || !isWebRowId(rawTarget) || oldRowId === rawTarget) {
        if (wanted.has(rawTarget)) blocked.add(rawTarget)
        continue
      }
      const target = resolve(oldRowId)
      if (target === undefined) {
        blocked.add(oldRowId)
        if (wanted.has(rawTarget)) blocked.add(rawTarget)
        continue
      }
      if (!wanted.has(target)) continue
      const sources = sourcesByTarget.get(target) ?? []
      sources.push(oldRowId)
      sourcesByTarget.set(target, sources)
    }
    for (const [target, sources] of sourcesByTarget) {
      const liveSources = sources.filter(
        (source) =>
          packages.has(source) ||
          wanted.has(source) ||
          (source.startsWith('web:') && packages.has(source.slice('web:'.length))),
      )
      if (liveSources.length > 1) {
        blocked.add(target)
        for (const source of liveSources) blocked.add(source)
      }
    }
    for (const oldRowId of raw.keys()) {
      const target = resolve(oldRowId)
      if (target === undefined || !wanted.has(target) || blocked.has(oldRowId) || blocked.has(target))
        continue
      if (wanted.has(oldRowId)) {
        blocked.add(oldRowId)
        blocked.add(target)
        continue
      }
      const lifecycleSource = packages.has(oldRowId)
        ? oldRowId
        : oldRowId.startsWith('web:') && packages.has(oldRowId.slice('web:'.length))
          ? oldRowId.slice('web:'.length)
          : oldRowId
      const state = packages.get(lifecycleSource)
      if (state === undefined) continue
      if (packages.has(target)) {
        blocked.add(lifecycleSource)
        blocked.add(target)
        continue
      }
      packages.delete(lifecycleSource)
      packages.set(target, state)
      state.ownerRowId ??= lifecycleSource
      const rewrite = (module: ReadyClientModule | undefined): ReadyClientModule | undefined =>
        module === undefined ? undefined : { ...module, rowId: target }
      state.target = rewrite(state.target)
      state.active = rewrite(state.active)
      statuses.delete(lifecycleSource)
    }
    return blocked
  }

  /**
   * Decide what each package should be doing and hand the work to that package's own queue. This
   * returns as soon as the work is enqueued: planning never awaits an import, a stylesheet fetch,
   * an apply or a teardown, so one slow module cannot delay another module's change.
   */
  function plan(roster: ClientRoster): Promise<void>[] {
    const wanted = new Map(roster.modules.map((mod) => [rowKey(mod), mod]))
    const blockedRows = migrateRosterAliases(roster.rowAliases, wanted)
    const waits: Promise<void>[] = []
    // 名册不再列出的包：dispose（级联撤销注册项）；模块记录本身驻留（B1）。
    for (const [rowId, state] of packages) {
      if (
        (!wanted.has(rowId) || blockedRows.has(rowId)) &&
        (state.rosterPresent || state.cleanupPending) &&
        !state.cleanupQueued
      ) {
        state.rosterPresent = false
        const removalEpoch = ++state.epoch
        state.target = undefined
        state.cleanup = {
          fiber: state.cleanup.fiber ?? state.fiber,
          styles: state.cleanup.styles ?? state.styles,
        }
        state.cleanupPending = Boolean(state.cleanup.fiber || state.cleanup.styles)
        state.fiber = undefined
        state.styles = undefined
        state.active = undefined
        setPhase(rowId, state, 'stopping')
        // Revoke immediately. The disposer below may be slow or reject, and neither case may
        // leave a stale module registration rendering in the page.
        try {
          const ownerRowId = registrationOwner(rowId, state)
          removeOwner(ownerRowId)
        } catch {
          console.warn('[client-modules] 名册撤回时回收模块注册项失败')
        }
        if (!state.cleanupPending) {
          setPhase(rowId, state, 'idle')
          continue
        }
        state.cleanupQueued = true
        state.chain = state.chain.then(async () => {
          state.cleanupQueued = false
          const cleaned = await disposeCleanup(rowId, state)
          if (state.epoch !== removalEpoch) return
          if (cleaned)
            blockedRows.has(rowId) ? fail(rowId, state, 'row-alias') : setPhase(rowId, state, 'idle')
          else fail(rowId, state, 'dispose')
        })
        waits.push(state.chain)
      }
    }
    for (const rowId of blockedRows) {
      if (packages.has(rowId)) continue
      const state = stateOf(rowId)
      state.rosterPresent = false
      fail(rowId, state, 'row-alias')
    }
    for (const [rowId, mod] of wanted) {
      if (blockedRows.has(rowId)) continue
      const state = stateOf(rowId)
      state.rosterPresent = true
      const unchanged =
        state.active?.revision === mod.revision &&
        state.active.entryUrl === mod.entryUrl &&
        state.phase === 'active'
      const pending =
        state.target?.revision === mod.revision &&
        state.target.entryUrl === mod.entryUrl &&
        (state.phase === 'loading' || state.phase === 'active')
      if (unchanged || pending) continue
      waits.push(applyTarget(rowId, state, mod))
    }
    return waits
  }

  // Roster reads are serialized so two notifications cannot plan against each other's half-applied
  // state; the work they enqueue stays outside that critical section.
  let planning: Promise<void> = Promise.resolve()
  function runDiff(): Promise<void> {
    const planned = planning.then(async (): Promise<Promise<void>[]> => {
      try {
        return plan(await source.list())
      } catch {
        // 名册读取失败保持现状：失败不能伪造 ready（WC10），下次触发再对账。
        return []
      }
    })
    planning = planned.then(
      () => undefined,
      () => undefined,
    )
    return planned.then(async (waits) => {
      await Promise.allSettled(waits)
    })
  }

  return {
    reconcileNow: () => runDiff(),
    invalidate: () => runDiff(),
    async reload(packageId, revision) {
      const roster = await source.list()
      const targets = roster.modules.filter(
        (module) => module.packageId === packageId && module.revision === revision,
      )
      // An out-of-order event may refer to a snapshot that was subsequently revoked. Reconcile
      // the authoritative roster in that case, rather than reviving the event's package.
      if (targets.length === 0) {
        await runDiff()
        return
      }
      const pending: Promise<void>[] = []
      // `applyTarget` preloads before it drains/disposes the old fiber; this explicit path bypasses
      // the normal same-revision idempotency gate. Keep the old active identity until
      // prefetch succeeds so a transient build/import failure leaves the old UI serving while the
      // next frame remains retryable.
      for (const target of targets) {
        const key = rowKey(target)
        const state = stateOf(key)
        state.rosterPresent = true
        pending.push(applyTarget(key, state, target))
      }
      await Promise.all(pending)
    },
    snapshot() {
      return statuses.snapshot()
    },
    subscribe: (listener) => statuses.subscribe(listener),
  }
}

export type { ClientContext } from '@agnes/web-client'
export type {
  ClientModuleCache,
  ClientModuleConfig,
  ClientModuleLifecycleStep,
  ClientModuleStatus,
  ClientReconciler,
  ClientRoster,
  ClientStylePreparer,
  ModuleImporter,
  PreparedClientStyles,
  ReadyClientModule,
  ReconcilerOptions,
  RosterSource,
} from './reconcile/contracts.js'
