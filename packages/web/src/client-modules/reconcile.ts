import { revokeContributionOwner, updateContributionAvailability } from '@agnes/web-client'
import {
  normalizeRuntimeError,
  type PluginRuntimeError,
  type PluginRuntimePhase,
  type RuntimeErrorStage,
  RuntimeStatusStore,
} from '@agnes/web-foundation/client-modules/runtime-status'
import { backendResourceUrl } from '../remote-frontend.js'
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
import { validDocumentAdmission } from './reconcile/roster.js'
import { prepareDocumentStyles } from './reconcile/styles.js'

const DEFAULT_TIMEOUTS = { import: 15_000, styles: 15_000, apply: 15_000, dispose: 5_000 }
type ReloadHint = { packageId: string; revision: string }

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
      return import(/* @vite-ignore */ backendResourceUrl(importUrls.resolve(url)))
    })
  const prepareStyles = options.prepareStyles ?? prepareDocumentStyles
  const moduleCache = options.moduleCache ?? { delete: () => undefined }
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  const packages = new Map<string, PackageState>()
  const statuses = new RuntimeStatusStore()
  const navigation = createRosterNavigation(locale)
  let generation = 0
  const startedExceptions = new Map<string, ReadyClientModule>()
  let reloadRequired = false
  let blockedPackages = new Set<string>()
  ctx.effect(() => () => {
    generation++
    for (const state of packages.values()) state.attempt?.abort()
    navigation.retain(new Set())
  })

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
        retainsMountedDuringAttempt: false,
        attempt: undefined,
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
    beginImport(rowId, target) {
      if (target.documentAdmission.kind === 'approved-presentation') startedExceptions.set(rowId, target)
    },
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

  function stopVisibleStyles(state: PackageState): void {
    state.retainsMountedDuringAttempt = false
    state.attempt?.abort()
    try {
      state.styles?.dispose()
      state.styles = undefined
    } catch {
      console.warn('[client-modules] retired stylesheet disposal failed')
    }
  }

  function selectRoster(roster: ClientRoster): ClientRoster {
    const modules = roster.modules.filter((mod) =>
      validDocumentAdmission(mod.documentAdmission, mod.contentDigest),
    )
    if (!reloadRequired && startedExceptions.size) {
      const byRow = new Map(modules.map((mod) => [rowKey(mod), mod]))
      reloadRequired = [...startedExceptions].some(([rowId, previous]) => {
        const next = byRow.get(rowId)
        return (
          next?.documentAdmission.kind !== 'approved-presentation' ||
          next.documentAdmission.bindingDigest !== previous.documentAdmission.bindingDigest ||
          next.contentDigest !== previous.contentDigest ||
          next.binding?.activationId !== previous.binding?.activationId ||
          next.revision !== previous.revision ||
          next.entryUrl !== previous.entryUrl
        )
      })
      if (reloadRequired) source.reloadRequired?.()
    }
    if (!reloadRequired) return { ...roster, modules }
    const { application: _application, ...facts } = roster
    return { ...facts, modules: modules.filter((mod) => mod.documentAdmission.kind === 'release') }
  }

  function projectBlockedStatuses(roster: ClientRoster): void {
    const blocked = new Set<string>()
    for (const status of roster.statuses) {
      if (status.state !== 'blocked' || status.reason !== 'native-ui-not-admitted') continue
      if (blocked.has(status.packageId)) continue
      blocked.add(status.packageId)
      const key = `admission:${status.packageId}`
      statuses.set(
        {
          packageId: status.packageId,
          revision: status.installedRevision,
          phase: 'idle',
          reason: 'native-ui-not-admitted',
        },
        key,
      )
    }
    for (const packageId of blockedPackages)
      if (!blocked.has(packageId)) statuses.delete(`admission:${packageId}`)
    blockedPackages = blocked
  }

  /**
   * Decide what each package should be doing and hand the work to that package's own queue. This
   * returns as soon as the work is enqueued: planning never awaits an import, a stylesheet fetch,
   * an apply or a teardown, so one slow module cannot delay another module's change.
   */
  function plan(roster: ClientRoster, fresh?: { reload: ReloadHint | undefined }): Promise<void>[] {
    const wanted = new Map(roster.modules.map((mod) => [rowKey(mod), mod]))
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
        stopVisibleStyles(state)
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
    if (!fresh) return waits
    const { reload } = fresh
    for (const [rowId, mod] of wanted) {
      if (blockedRows.has(rowId)) continue
      const state = stateOf(rowId)
      state.rosterPresent = true
      const unchanged =
        state.active?.revision === mod.revision &&
        state.active.entryUrl === mod.entryUrl &&
        state.active.contentDigest === mod.contentDigest &&
        state.active.documentAdmission.bindingDigest === mod.documentAdmission.bindingDigest &&
        state.active.documentAdmission.kind === mod.documentAdmission.kind &&
        JSON.stringify(state.active.binding) === JSON.stringify(mod.binding) &&
        JSON.stringify(state.active.presentationRoleBindings) ===
          JSON.stringify(mod.presentationRoleBindings) &&
        state.phase === 'active'
      const forced =
        mod.documentAdmission.kind === 'release' &&
        reload?.packageId === mod.packageId &&
        reload.revision === mod.revision
      if (!forced && unchanged) continue
      const previous = [state.active, state.target].find((item) => item?.entryUrl === mod.entryUrl)
      if (
        forced ||
        (previous?.entryUrl === mod.entryUrl &&
          (previous.revision !== mod.revision || previous.contentDigest !== mod.contentDigest))
      )
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
        if (!unchanged) {
          stopVisibleStyles(state)
          if (state.active) removeOwner(registrationOwner(rowId, state))
        }
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
      // Exact same-authority HMR can keep the mounted release until replacement is ready.
      state.retainsMountedDuringAttempt = unchanged
      waits.push(applyTarget(rowId, state, mod))
    }
    return waits
  }

  // Queries may overlap; only the newest request in the same selection may commit. Planning
  // is ordered, while each module keeps its independent lifecycle/loading queue.
  let planning: Promise<void> = Promise.resolve()
  function commitRoster(
    request: number,
    identity: string | undefined,
    raw: ClientRoster | undefined,
    reload?: ReloadHint,
  ): Promise<Promise<void>[]> {
    const commit = planning.then(() => {
      if (request !== generation || identity !== source.identity?.()) return []
      const roster = selectRoster(
        raw ?? {
          revision: '',
          // Keep mounted release UI for offline history, but retire exceptions and pending targets.
          modules: [...packages.values()].flatMap(({ active, phase }) =>
            phase === 'active' && active?.documentAdmission.kind === 'release' ? [active] : [],
          ),
          statuses: [],
        },
      )
      const waits = plan(roster, raw && { reload })
      source.commit?.(roster)
      projectBlockedStatuses(roster)
      return waits
    })
    planning = commit.then(
      () => undefined,
      () => undefined,
    )
    return commit
  }

  function retirePending(): number {
    const request = ++generation
    // No queued import, stylesheet preparation or activation may use authority that is being reread.
    for (const [rowId, state] of packages) {
      if (state.phase !== 'loading') continue
      state.epoch++
      state.target = undefined
      state.attempt?.abort()
      try {
        if (!state.active) removeOwner(registrationOwner(rowId, state))
      } catch {
        console.warn('[client-modules] pending module revocation failed')
      }
      const mounted = state.retainsMountedDuringAttempt
      state.retainsMountedDuringAttempt = false
      setPhase(rowId, state, mounted ? 'active' : 'idle')
    }
    return request
  }

  function runDiff(reload?: ReloadHint): Promise<void> {
    const identity = source.identity?.()
    const request = retirePending()
    const planned = Promise.resolve()
      .then(() => source.list())
      .then(
        (roster) => commitRoster(request, identity, roster, reload),
        () => commitRoster(request, identity, undefined),
      )
    return planned.then(async (waits) => {
      await Promise.allSettled(waits)
    })
  }

  return {
    retirePending,
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
