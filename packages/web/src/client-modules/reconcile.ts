/**
 * 宿主侧对账生命周期（web 客户端模块设计 WC10 的前端状态机，第一段前端轨）。
 *
 * 与合同的对应：同包串行、每包递增 epoch 只保留最新目标；import/apply 15s 超时、dispose 排干 5s；
 * 换版先预加载新入口再 dispose 旧 fiber；失败只隔离当前包，下一次名册失效提示可以重试；
 * 名册不再列出 = 禁用/卸载，dispose 级联撤销注册项（outlet 自动回到占位）。
 * 真实名册源（`_agnes/v1/clientModules.list`）属 P1a，这里只定义 RosterSource 契约；
 * 没有源时 reconciler 处于 idle，不加载任何模块（fail-closed）。
 */
import { type Context, FiberState } from '@agnes/cordis'
import {
  type ClientContext,
  clientModule,
  DSH_SLOT_CATALOG_VERSION,
  getDshSlotDefinition,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
  type ModuleIdentity,
} from '@agnes/web-client'
import {
  normalizeRuntimeError,
  type PluginRuntimeError,
  type PluginRuntimePhase,
  type PluginRuntimeState,
  type RuntimeErrorStage,
  RuntimeStatusStore,
} from './runtime-status.js'

/** 名册里的 ready 模块（WC3 modules 的最小子集）。 */
export interface ReadyClientModule {
  /** Stable lifecycle key for one browser row; omitted only by legacy roster producers. */
  rowId?: string
  packageId: string
  revision: string
  entryUrl: string
  styleUrls: string[]
  slots: string[]
  /** Required for DSH-aligned slots; omitted for the legacy Agnes slot set. */
  slotCatalogVersion?: string
  /** Digest of the daemon-verified immutable snapshot manifest. */
  contentDigest?: string
  extIds: string[]
  services?: string[]
  /** Explicit browser-safe manifest metadata; never a daemon runtime row config. */
  publicConfig?: Readonly<Record<string, unknown>>
}

function rowKey(module: Pick<ReadyClientModule, 'packageId' | 'rowId'>): string {
  return module.rowId ?? module.packageId
}

function validateCatalogContract(target: ReadyClientModule): string | undefined {
  const dshSlots = target.slots.filter((slot) => getDshSlotDefinition(slot) !== undefined)
  if (dshSlots.length === 0) return undefined
  if (target.slotCatalogVersion !== DSH_SLOT_CATALOG_VERSION)
    return `slot catalog version is not supported: ${target.slotCatalogVersion ?? 'missing'}`
  const hostOnly = dshSlots.find((slot) => !isPublicDshSlot(slot))
  if (hostOnly !== undefined) return `host-only slot cannot be contributed: ${hostOnly}`
  const unsupported = dshSlots.find((slot) => !isRuntimeSupportedDshSlot(slot))
  if (unsupported !== undefined) return `slot is not mounted by the current host: ${unsupported}`
  return undefined
}

/** 名册状态项（WC3 statuses 的最小子集）。 */
export interface ClientModuleStatus {
  packageId: string
  installedRevision: string
  backendRevision: string | null
  state: 'ready' | 'pending-activation' | 'blocked'
  reason?: string
}

export interface ClientRoster {
  revision: string
  modules: ReadyClientModule[]
  statuses: ClientModuleStatus[]
  /** Old daemon/browser lifecycle keys mapped to their canonical contribution row. */
  rowAliases?: Readonly<Record<string, string>>
}

/** 名册源契约；P1a 落地后由 SDK 客户端实现。 */
export interface RosterSource {
  list(): Promise<ClientRoster>
}

/** 可注入的模块导入器（测试用 fake 替换；生产是动态 import）。 */
export type ModuleImporter = (url: string) => Promise<unknown>

export type ClientModuleLifecycleStep =
  | 'invalidate'
  | 'prefetch'
  | 'cache-registry-delete'
  | 'drain'
  | 'remove-styles'
  | 'refresh'
  | 'await'

export interface ClientModuleCache {
  delete(entryUrl: string): Promise<void> | void
}

/** Prepared stylesheet set. Preparation fetches without applying; activation is the commit point. */
export interface PreparedClientStyles {
  activate(): void
  dispose(): void
}

export type ClientStylePreparer = (
  target: ReadyClientModule,
  timeoutMs: number,
) => Promise<PreparedClientStyles>

export interface ReconcilerOptions {
  ctx: Context
  source: RosterSource
  /** Remove registrations owned by one browser row before/after its fiber teardown. */
  removeOwner?: (rowId: string) => void
  importer?: ModuleImporter
  /** Drop an old module namespace from an author/runtime registry before its fiber is drained. */
  moduleCache?: ClientModuleCache
  /** Lifecycle probe used by focused tests and diagnostics; it does not own reconciliation. */
  onLifecycleStep?: (step: ClientModuleLifecycleStep, packageId: string) => Promise<void> | void
  /** Stylesheet preparation is injectable so lifecycle tests do not need a browser network stack. */
  prepareStyles?: ClientStylePreparer
  /** 超时可注入以便测试；毫秒。 */
  timeouts?: { import?: number; styles?: number; apply?: number; dispose?: number }
}

interface PackageState {
  packageId: string
  revision: string | undefined
  phase: PluginRuntimePhase
  epoch: number
  target: ReadyClientModule | undefined
  active: ReadyClientModule | undefined
  /** Registration owner may remain on a legacy row until its fiber is drained. */
  ownerRowId: string | undefined
  fiber: { dispose(): Promise<void> | void } | undefined
  styles: PreparedClientStyles | undefined
  draining: Promise<void> | undefined
  /** Whether the current roster still contains this package. Used to make revocation one-shot. */
  rosterPresent: boolean
  cleanup: {
    fiber: { dispose(): Promise<void> | void } | undefined
    styles: PreparedClientStyles | undefined
  }
  cleanupPending: boolean
  cleanupQueued: boolean
  failure: PluginRuntimeError | undefined
  chain: Promise<void>
}

const DEFAULT_TIMEOUTS = { import: 15_000, styles: 15_000, apply: 15_000, dispose: 5_000 }

export interface ClientReconciler {
  reconcileNow(): Promise<void>
  /** 名册失效提示（WC10 packages_changed 的语义：推送是失效提示，必须重读名册）。 */
  invalidate(): Promise<void>
  /**
   * Reload one snapshot named by the SSE channel.  The hint is never trusted as an asset URL: we
   * first reread the daemon roster, then only apply its matching immutable module row.  A failed
   * reload remains retryable on the next event/invalidation; there is intentionally no blacklist.
   */
  reload(packageId: string, revision: string): Promise<void>
  subscribe(listener: (state: PluginRuntimeState) => void): () => void
  snapshot(): Map<string, PluginRuntimeState>
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function prepareDocumentStyles(
  target: ReadyClientModule,
  timeoutMs: number,
): Promise<PreparedClientStyles> {
  if (target.styleUrls.length === 0) return { activate() {}, dispose() {} }
  const links = target.styleUrls.map((href) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.media = 'not all'
    link.dataset.plugin = target.packageId
    return link
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const loaded = Promise.all(
      links.map(
        (link) =>
          new Promise<void>((resolve, reject) => {
            link.addEventListener('load', () => resolve(), { once: true })
            link.addEventListener('error', () => reject(new Error(`stylesheet failed: ${link.href}`)), {
              once: true,
            })
            document.head.append(link)
          }),
      ),
    )
    await Promise.race([
      loaded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`styles ${target.packageId} timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    for (const link of links) link.remove()
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  let disposed = false
  return {
    activate() {
      if (!disposed) for (const link of links) link.media = 'all'
    },
    dispose() {
      disposed = true
      for (const link of links) link.remove()
    },
  }
}

export function createReconciler(options: ReconcilerOptions): ClientReconciler {
  const { ctx, source } = options
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
    setPhase(rowId, state, 'failed', normalizeRuntimeError(stage, undefined))
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

  // 回收从未提交给 state 的 fiber（apply 失败/超时或 epoch 失配）：state.fiber 还没见过它，
  // 名册移除的卸载分支捕获不到，不在这里 dispose 就是泄漏。dispose 失败只记日志。
  async function discardUncommitted(
    fiber: { dispose(): Promise<void> | void } | undefined,
    rowId: string,
  ): Promise<void> {
    if (!fiber) return
    try {
      await withTimeout(Promise.resolve(fiber.dispose()), timeouts.dispose, `dispose ${rowId}`)
    } catch {
      // Plugin exceptions can contain import URLs or author-supplied input. Roster identities are
      // validated upstream rather than here, so browser diagnostics expose no plugin-controlled
      // values at all; runtime-status carries the safe code for the affected row.
      console.warn('[client-modules] 回收未提交的 fiber 失败')
    } finally {
      // A failed/stale disposer is not allowed to leave slots visible. This is deliberately
      // idempotent and also covers a fiber whose apply registered entries before rejecting.
      try {
        removeOwner(rowId)
      } catch {
        console.warn('[client-modules] 回收模块注册项失败')
      }
    }
  }

  async function drainFiber(
    state: PackageState,
    fiber: { dispose(): Promise<void> | void },
    rowId: string,
  ): Promise<void> {
    const drain = Promise.resolve().then(() => fiber.dispose())
    let settled!: Promise<void>
    settled = drain
      .then(
        () => undefined,
        (error: unknown) => Promise.reject(error),
      )
      .finally(() => {
        if (state.draining === settled) state.draining = undefined
      })
    state.draining = settled
    await withTimeout(settled, timeouts.dispose, `dispose ${rowId}`)
  }

  async function disposeCleanup(rowId: string, state: PackageState): Promise<boolean> {
    if (!state.cleanupPending) return true
    let fiber = state.cleanup.fiber
    let styles = state.cleanup.styles
    if (fiber) {
      try {
        await drainFiber(state, fiber, rowId)
        fiber = undefined
      } catch {
        // Keep the fiber for a later retry, but continue with independent host resources below.
      }
    }
    if (styles) {
      try {
        styles.dispose()
        styles = undefined
      } catch {
        // A custom style disposer may fail independently; retain it for a later retry.
      }
    }
    if (fiber || styles) {
      // A timeout or rejected disposer remains retryable. The stylesheet must not be discarded
      // merely because the fiber failed: otherwise a later retry can never restore the host UI.
      state.cleanup = { fiber, styles }
      state.cleanupPending = true
      return false
    }
    state.cleanup = { fiber: undefined, styles: undefined }
    state.cleanupPending = false
    const ownerRowId = registrationOwner(rowId, state)
    state.ownerRowId = undefined
    try {
      removeOwner(ownerRowId)
    } catch {
      console.warn('[client-modules] 名册撤回后回收模块注册项失败')
    }
    return true
  }

  function applyTarget(rowId: string, state: PackageState, target: ReadyClientModule): Promise<void> {
    const epoch = ++state.epoch
    state.packageId = target.packageId
    state.target = target
    setPhase(rowId, state, 'loading')
    const run = async (): Promise<void> => {
      let mod: unknown
      let stagedStyles: PreparedClientStyles | undefined
      try {
        if (state.cleanupPending && !(await disposeCleanup(rowId, state))) {
          if (epoch === state.epoch) fail(rowId, state, 'dispose')
          return
        }
        // A timed-out disposer may still be unwinding.  Do not let the next retry mount a new
        // fiber until that old fiber has actually settled; removing its registrations is not a
        // substitute for draining its asynchronous work.
        await state.draining?.catch(() => undefined)
        const catalogError = validateCatalogContract(target)
        const unsupportedSlot = target.slots.find((slot) => registry?.spec && !registry.spec(slot))
        if (catalogError !== undefined || unsupportedSlot !== undefined) {
          if (epoch === state.epoch) fail(rowId, state, 'unsupported-slot')
          return
        }
        await lifecycle('invalidate', rowId)
        await lifecycle('prefetch', rowId)
        mod = await withTimeout(importer(target.entryUrl), timeouts.import, `import ${rowId}`)
      } catch (error) {
        if (epoch === state.epoch)
          fail(
            rowId,
            state,
            error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'import',
          )
        return
      }
      try {
        stagedStyles = await prepareStyles(target, timeouts.styles)
      } catch (error) {
        stagedStyles?.dispose()
        if (epoch === state.epoch)
          fail(
            rowId,
            state,
            error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'styles',
          )
        return
      }
      try {
        if (
          typeof mod !== 'object' ||
          mod === null ||
          typeof (mod as Record<string, unknown>).apply !== 'function'
        ) {
          if (epoch === state.epoch) fail(rowId, state, 'module-shape')
          stagedStyles.dispose()
          return
        }
        if (epoch !== state.epoch) {
          stagedStyles.dispose()
          return
        }

        const old = state.fiber
        const oldStyles = state.styles
        const oldEntryUrl = state.active?.entryUrl ?? target.entryUrl
        await lifecycle('cache-registry-delete', rowId)
        if (old || oldStyles || state.active) await moduleCache.delete(oldEntryUrl)
        const oldOwnerRowId = registrationOwner(rowId, state)
        try {
          removeOwner(oldOwnerRowId)
        } catch {
          console.warn('[client-modules] 旧模块注册项回收失败')
        }
        state.fiber = undefined
        state.styles = undefined
        state.active = undefined
        if (old) {
          try {
            await lifecycle('drain', rowId)
            await drainFiber(state, old, rowId)
          } catch (error) {
            stagedStyles.dispose()
            state.cleanup = { fiber: old, styles: oldStyles }
            state.cleanupPending = Boolean(old || oldStyles)
            if (epoch === state.epoch)
              fail(
                rowId,
                state,
                error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'dispose',
              )
            return
          }
        }
        await lifecycle('remove-styles', rowId)
        oldStyles?.dispose()
        state.ownerRowId = undefined
        if (epoch !== state.epoch) {
          stagedStyles.dispose()
          try {
            removeOwner(oldOwnerRowId)
          } catch {
            console.warn('[client-modules] 过期模块注册项回收失败')
          }
          return
        }

        // fiber 先由本次 run 局部持有，通过 epoch 检查后才提交给 state；旧 registry 早已删除，
        // 因此 apply 期间不会出现同包双挂。
        let fiber: { dispose(): Promise<void> | void } | undefined
        try {
          await lifecycle('refresh', rowId)
          stagedStyles.activate()
          const created = ctx.plugin(clientModule(mod as never), {
            rowId,
            packageId: target.packageId,
            revision: target.revision,
            allowedSlots: target.slots,
            ...(target.slotCatalogVersion === undefined
              ? {}
              : { slotCatalogVersion: target.slotCatalogVersion }),
            ...(target.contentDigest === undefined ? {} : { contentDigest: target.contentDigest }),
            ...(target.services === undefined ? {} : { services: target.services }),
            ...(target.publicConfig === undefined ? {} : { publicConfig: target.publicConfig }),
          })
          fiber = created
          await lifecycle('await', rowId)
          const settled = await withTimeout(Promise.resolve(created), timeouts.apply, `apply ${rowId}`)
          // Cordis contains module callback failures on the fiber and resolves its awaitable
          // after moving the fiber to FAILED.  A settled awaitable therefore is not proof that
          // the browser module activated; publish only an actually ACTIVE fiber so an apply
          // failure cannot masquerade as a successful roster entry.
          const fiberState = (settled as { state?: FiberState }).state
          if (fiberState !== undefined && fiberState !== FiberState.ACTIVE)
            throw new Error(`client module ${rowId} did not activate`)
        } catch {
          await discardUncommitted(fiber, rowId)
          stagedStyles.dispose()
          if (epoch === state.epoch) fail(rowId, state, 'apply')
          return
        }
        if (epoch !== state.epoch) {
          await discardUncommitted(fiber, rowId)
          stagedStyles.dispose()
          return
        }
        state.fiber = fiber
        state.styles = stagedStyles
        state.active = target
        state.ownerRowId = rowId
        state.revision = target.revision
        setPhase(rowId, state, 'active')
      } catch (error) {
        stagedStyles?.dispose()
        if (epoch === state.epoch)
          fail(
            rowId,
            state,
            error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'reconcile',
          )
      }
    }
    // 同包串行：所有应用排队在前一个之后（WC10）。
    state.chain = state.chain.then(run, run)
    return state.chain
  }

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
      const unchanged = state.active?.revision === mod.revision && state.phase === 'active'
      const pending =
        state.target?.revision === mod.revision && (state.phase === 'loading' || state.phase === 'active')
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

/** 供宿主判断模块身份的类型出口（clientModule config 的形状）。 */
export type ClientModuleConfig = ModuleIdentity & Record<string, unknown>
export type { ClientContext }
