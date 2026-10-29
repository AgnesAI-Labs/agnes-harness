import { revokeContributionOwner, updateContributionAvailability } from '@agnes/web-client'
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
  ReadyClientModule,
  ReconcilerOptions,
} from './reconcile/contracts.js'
import { createReconcileLifecycle } from './reconcile/lifecycle.js'
import { createRosterNavigation } from './reconcile/navigation.js'
import { prepareDocumentStyles } from './reconcile/styles.js'

const DEFAULT_TIMEOUTS = { import: 15_000, styles: 15_000, apply: 15_000, dispose: 5_000 }

/** Reuse immutable module URLs across roster rebinding; only explicit code changes bust ESM. */
export function createModuleImportUrls() {
  const versions = new Map<string, number>()
  let generation = 0
  return {
    resolve(url: string): string {
      const version = versions.get(url)
      if (version === undefined) return url
      const separator = url.includes('?') ? '&' : '?'
      return `${url}${separator}agnes_hmr=${version}`
    },
    invalidate(url: string): void {
      versions.set(url, ++generation)
    },
  }
}

export function createReconciler(options: ReconcilerOptions): ClientReconciler {
  const { ctx, source, locale } = options
  const removeRegistrations =
    options.removeOwner ??
    ((packageId: string) => {
      const registry = (ctx as unknown as { slots?: { removeOwner(owner: string): void } }).slots
      registry?.removeOwner(packageId)
    })
  const removeOwner = (owner: string) => {
    revokeContributionOwner(owner)
    removeRegistrations(owner)
  }
  const importUrls = createModuleImportUrls()
  const importer =
    options.importer ??
    ((url: string) => {
      // A repeated session binding may use the same reviewed code. Explicit hot reload and
      // same-URL revisions advance the query token; normal rebinding reuses the ESM namespace.
      return import(/* @vite-ignore */ importUrls.resolve(url))
    })
  const prepareStyles = options.prepareStyles ?? prepareDocumentStyles
  const moduleCache = options.moduleCache ?? { delete: () => undefined }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  const packages = new Map<string, PackageState>()
  const statuses = new RuntimeStatusStore()
  const navigation = createRosterNavigation(locale)
  ctx.effect(() => () => navigation.retain(new Set()))

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
    if (phase === 'active') navigation.remove(rowId)
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
    navigation.remove(rowId)
    revokeContributionOwner(registrationOwner(rowId, state))
    setPhase(rowId, state, 'failed', {
      ...normalizeRuntimeError(stage, undefined, (key) => locale?.t(key) ?? key),
      ...(state.target?.presentationRoles ? { roles: [...state.target.presentationRoles] } : {}),
    })
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
  const { applyTarget, disposeCleanup } = createReconcileLifecycle({
    identity: () => source.identity?.(),
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
  function plan(roster: ClientRoster, reload?: { packageId: string; revision: string }): Promise<void>[] {
    const wanted = new Map(
      roster.modules.filter((mod) => !mod.intelligentComponents?.length).map((mod) => [rowKey(mod), mod]),
    )
    const blockedRows = migrateRosterAliases(roster.rowAliases, wanted)
    // A generation rebuild can withdraw executable rows before their replacement is ready.
    // Keep only their host-owned declarations; old module authority is still revoked below.
    const transitioning = new Set(
      roster.statuses
        .filter(
          (status) =>
            status.state === 'pending-activation' ||
            (status.state === 'blocked' && status.reason === 'backend-revision-unavailable'),
        )
        .map((status) => status.packageId),
    )
    const suspended = new Set(
      [...packages]
        .filter(
          ([id, state]) => !wanted.has(id) && !blockedRows.has(id) && transitioning.has(state.packageId),
        )
        .map(([id]) => id),
    )
    navigation.retain(new Set([...wanted.keys(), ...suspended].filter((id) => !blockedRows.has(id))))
    const waits: Promise<void>[] = []
    // Packages removed from the roster: dispose, cascading registration removal; keep the module record resident.
    for (const [rowId, state] of packages) {
      if (
        (!wanted.has(rowId) || blockedRows.has(rowId)) &&
        (state.rosterPresent || state.cleanupPending) &&
        !state.cleanupQueued
      ) {
        state.rosterPresent = false
        const removalEpoch = ++state.epoch
        const previous = state.active ?? state.target
        const declaration = previous && navigation.describe(previous)
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
          if (declaration && suspended.has(rowId)) navigation.prepare(rowId, declaration, () => {})
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
        JSON.stringify(state.active.binding) === JSON.stringify(mod.binding) &&
        JSON.stringify(state.active.presentationRoleBindings) ===
          JSON.stringify(mod.presentationRoleBindings) &&
        state.phase === 'active'
      const pending =
        state.target?.revision === mod.revision &&
        state.target.entryUrl === mod.entryUrl &&
        JSON.stringify(state.target.binding) === JSON.stringify(mod.binding) &&
        JSON.stringify(state.target.presentationRoleBindings) ===
          JSON.stringify(mod.presentationRoleBindings) &&
        (state.phase === 'loading' || state.phase === 'active')
      const forced = reload?.packageId === mod.packageId && reload.revision === mod.revision
      if (!forced && (unchanged || pending)) continue
      const previous = [state.active, state.target].find((item) => item?.entryUrl === mod.entryUrl)
      if (forced || (previous?.entryUrl === mod.entryUrl && previous.revision !== mod.revision))
        importUrls.invalidate(mod.entryUrl)
      const declaration = navigation.describe(mod)
      if (
        mod.binding &&
        state.active?.binding &&
        JSON.stringify(mod.binding) !== JSON.stringify(state.active.binding)
      ) {
        if (
          mod.binding.owner !== state.active.binding.owner ||
          (mod.binding.activationId !== state.active.binding.activationId &&
            mod.binding.lifetime === 'profile')
        )
          revokeContributionOwner(registrationOwner(rowId, state))
        else updateContributionAvailability(registrationOwner(rowId, state), mod.binding)
      }
      try {
        if (state.active) removeOwner(registrationOwner(rowId, state))
        if (
          state.phase !== 'failed' &&
          navigation.prepare(
            rowId,
            declaration,
            () => {
              void runDiff()
            },
            Boolean(state.active),
          )
        )
          continue
      } catch {
        fail(rowId, state, 'apply')
        continue
      }
      waits.push(applyTarget(rowId, state, mod))
    }
    return waits
  }

  // Queries may overlap; only the newest request in the same selection may commit. Planning
  // is ordered, while each module keeps its independent lifecycle/loading queue.
  let planning: Promise<void> = Promise.resolve()
  let generation = 0
  let scope: string | undefined
  function runDiff(reload?: { packageId: string; revision: string }): Promise<void> {
    const request = ++generation
    const identity = source.identity?.()
    if (identity !== scope) {
      scope = identity
      // Retire pending work from the old scope. Active root modules stay mounted until the
      // authoritative roster changes them; a session switch alone must not tear down their UI.
      for (const [rowId, state] of packages) {
        if (state.phase !== 'loading') continue
        state.epoch++
        state.target = undefined
        setPhase(rowId, state, state.active ? 'active' : 'idle')
      }
    }
    const read = Promise.resolve().then(() => source.list())
    const planned = read.then(
      (roster) => {
        const commit = planning.then(() => {
          if (request !== generation || identity !== source.identity?.()) return []
          source.commit?.(roster)
          return plan(roster, reload)
        })
        planning = commit.then(
          () => undefined,
          () => undefined,
        )
        return commit
      },
      () => [],
    )
    return planned.then(async (waits) => {
      await Promise.allSettled(waits)
    })
  }

  return {
    reconcileNow: () => runDiff(),
    invalidate: () => runDiff(),
    reload: (packageId, revision) => runDiff({ packageId, revision }),
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
