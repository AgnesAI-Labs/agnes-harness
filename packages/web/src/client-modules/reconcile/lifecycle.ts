import { type Context, FiberState } from '@agnes/cordis'
import { clientModule, isRuntimeSupportedDshSlot } from '@agnes/web-client'
import type {
  PluginRuntimeError,
  PluginRuntimePhase,
  RuntimeErrorStage,
} from '@agnes/web-foundation/client-modules/runtime-status'
import { validateCatalogContract } from './catalog.js'
import type {
  ClientModuleCache,
  ClientModuleLifecycleStep,
  ClientStylePreparer,
  ModuleImporter,
  PackageState,
  PreparedClientStyles,
  ReadyClientModule,
} from './contracts.js'
import { withTimeout } from './styles.js'

export interface ReconcileLifecycleContext {
  ctx: Context
  identity(): string | undefined
  registry: { spec?: (name: string) => unknown } | undefined
  timeouts: { import: number; styles: number; apply: number; dispose: number }
  importer: ModuleImporter
  prepareStyles: ClientStylePreparer
  moduleCache: ClientModuleCache
  removeOwner(rowId: string): void
  registrationOwner(rowId: string, state: PackageState): string
  lifecycle(step: ClientModuleLifecycleStep, packageId: string): Promise<void>
  fail(rowId: string, state: PackageState, stage: RuntimeErrorStage): void
  setPhase(rowId: string, state: PackageState, phase: PluginRuntimePhase, failure?: PluginRuntimeError): void
}

export function createReconcileLifecycle(context: ReconcileLifecycleContext) {
  const {
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
  } = context

  // Reclaim a fiber never committed to state (apply failure/timeout or epoch mismatch): state.fiber has not seen it,
  // so roster-removal cleanup cannot catch it. Failing to dispose here leaks; disposal failures are logged only.
  async function discardUncommitted(
    fiber: { dispose(): Promise<void> | void } | undefined,
    rowId: string,
  ): Promise<void> {
    if (!fiber) return
    removeOwner(rowId)
    try {
      await withTimeout(Promise.resolve(fiber.dispose()), timeouts.dispose, `dispose ${rowId}`)
    } catch {
      // Plugin exceptions can contain import URLs or author-supplied input. Roster identities are
      // validated upstream rather than here, so browser diagnostics expose no plugin-controlled
      // values at all; runtime-status carries the safe code for the affected row.
      console.warn('[client-modules] 回收未提交的 fiber 失败')
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
    let drainFailed = false
    let fiber = state.cleanup.fiber
    let styles = state.cleanup.styles
    if (fiber) {
      try {
        await drainFiber(state, fiber, rowId)
        fiber = undefined
      } catch {
        // Authority was synchronously revoked. Quarantine an uncooperative disposer;
        // its identity-bound registrations cannot remove or revive the replacement.
        drainFailed = true
        fiber = undefined
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
    return !drainFailed
  }

  function applyTarget(rowId: string, state: PackageState, target: ReadyClientModule): Promise<void> {
    const epoch = ++state.epoch
    const identity = context.identity()
    const current = () => epoch === state.epoch && identity === context.identity()
    state.packageId = target.packageId
    state.target = target
    setPhase(rowId, state, 'loading')
    const run = async (): Promise<void> => {
      let mod: unknown
      let stagedStyles: PreparedClientStyles | undefined
      try {
        if (state.cleanupPending && !(await disposeCleanup(rowId, state))) {
          if (current()) fail(rowId, state, 'dispose')
          return
        }
        const catalogError = validateCatalogContract(target)
        const unsupportedSlot = target.slots.find(
          (slot) => registry?.spec && !registry.spec(slot) && !isRuntimeSupportedDshSlot(slot),
        )
        if (catalogError !== undefined || unsupportedSlot !== undefined) {
          if (current()) fail(rowId, state, 'unsupported-slot')
          return
        }
        await lifecycle('invalidate', rowId)
        await lifecycle('prefetch', rowId)
        // Preparation is independent within this module. Settle both sides before failure or
        // replacement so a late stylesheet cannot escape cleanup; activation stays serial.
        const [script, styles] = await Promise.allSettled([
          Promise.resolve().then(() =>
            withTimeout(importer(target.entryUrl), timeouts.import, `import ${rowId}`),
          ),
          Promise.resolve().then(() => prepareStyles(target, timeouts.styles)),
        ])
        if (styles.status === 'fulfilled') stagedStyles = styles.value
        if (script.status === 'rejected' || styles.status === 'rejected') {
          stagedStyles?.dispose()
          const error =
            script.status === 'rejected'
              ? script.reason
              : styles.status === 'rejected'
                ? styles.reason
                : undefined
          if (current())
            fail(
              rowId,
              state,
              error instanceof Error && error.message.includes('timeout')
                ? 'timeout'
                : script.status === 'rejected'
                  ? 'import'
                  : 'styles',
            )
          return
        }
        mod = script.value
        stagedStyles = styles.value
      } catch (error) {
        stagedStyles?.dispose()
        if (current())
          fail(
            rowId,
            state,
            error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'import',
          )
        return
      }
      try {
        if (
          typeof mod !== 'object' ||
          mod === null ||
          typeof (mod as Record<string, unknown>).apply !== 'function'
        ) {
          if (current()) fail(rowId, state, 'module-shape')
          stagedStyles.dispose()
          return
        }
        if (!current()) {
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
          } catch {
            // The old scope has no authority. A failed drain must not block a fresh mount.
            console.warn('[client-modules] retired fiber disposal failed')
          }
        }
        await lifecycle('remove-styles', rowId)
        oldStyles?.dispose()
        state.ownerRowId = undefined
        if (!current()) {
          stagedStyles.dispose()
          try {
            removeOwner(oldOwnerRowId)
          } catch {
            console.warn('[client-modules] 过期模块注册项回收失败')
          }
          return
        }

        // This run holds the fiber locally until the epoch check passes, then commits it to state. The old registry is gone,
        // so apply never mounts the same package twice.
        let fiber: { dispose(): Promise<void> | void } | undefined
        try {
          await lifecycle('refresh', rowId)
          stagedStyles.activate()
          const created = ctx.plugin(clientModule(mod as never), {
            ...(target.exampleOf ? { exampleOf: target.exampleOf } : {}),
            ...(target.pageEntry ? { pageEntry: target.pageEntry } : {}),
            ...(target.binding ? { binding: target.binding } : {}),
            ...(target.clientId ? { clientId: target.clientId } : {}),
            ...(target.presentationRoleBindings
              ? { presentationRoleBindings: target.presentationRoleBindings }
              : {}),
            ...(target.presentationRoles ? { presentationRoles: target.presentationRoles } : {}),
            ...(target.homeEntries ? { homeEntries: target.homeEntries } : {}),
            ...(target.examplePages ? { examplePages: target.examplePages } : {}),
            rowId,
            packageId: target.packageId,
            revision: target.revision,
            allowedSlots: target.slots,
            ...(target.slotCatalogVersion === undefined
              ? {}
              : { slotCatalogVersion: target.slotCatalogVersion }),
            ...(target.contentDigest === undefined ? {} : { contentDigest: target.contentDigest }),
            ...(target.services === undefined ? {} : { services: target.services }),
            ...(target.backendOwner ? { backendOwner: target.backendOwner } : {}),
            ...(target.streams ? { streams: target.streams } : {}),
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
          if (current()) fail(rowId, state, 'apply')
          return
        }
        if (!current()) {
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
        if (current())
          fail(
            rowId,
            state,
            error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'reconcile',
          )
      }
    }
    // Serialize within each package: queue each application after the previous one.
    state.chain = state.chain.then(run, run)
    return state.chain
  }

  return { applyTarget, drainFiber, disposeCleanup }
}
