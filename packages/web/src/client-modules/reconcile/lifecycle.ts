import { type Context, FiberState } from '@agnes/cordis'
import { clientModule } from '@agnes/web-client'
import type {
  PluginRuntimeError,
  PluginRuntimePhase,
  RuntimeErrorStage,
} from '@agnes/web-foundation/client-modules/runtime-status'
import type {
  ClientModuleCache,
  ClientModuleLifecycleStep,
  ClientStylePreparer,
  ModuleImporter,
  PackageState,
  PreparedClientStyles,
  ReadyClientModule,
} from './contracts.js'
import { validateCatalogContract } from './catalog.js'
import { withTimeout } from './styles.js'

export interface ReconcileLifecycleContext {
  ctx: Context
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

  return { applyTarget, drainFiber, disposeCleanup }
}
