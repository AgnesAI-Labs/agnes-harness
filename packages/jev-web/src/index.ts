import type { ClientContext, WorkbenchSnapshot, WorkbenchTarget } from '@agnes/web-client'
import { comparisonCreationMessage } from './comparison-errors.js'
import { COMPARISON_PERMISSION_OPTIONS, comparisonPermissionLabel } from './comparison-permission.js'
import { createComparisonWorkspace } from './comparison-workspace.js'
import { JEV_LOCALE_NAMESPACE, jevLocaleCatalog, type Translate } from './jev-locale.js'
import { bindJevWorkspace } from './jev-workspace.js'
import { createRuntimeRecordTrace } from './runtime-record-trace.js'

/** Loaded exclusively from the installed client descriptor, never imported by the Web shell. */
export function apply(ctx: ClientContext): void {
  const workbench = ctx.workbench
  if (!workbench) throw new Error('当前 Web 宿主不支持可扩展工作区。请升级宿主后启用 Jev 工作区。')
  ctx.locale?.register(JEV_LOCALE_NAMESPACE, jevLocaleCatalog)
  const surfaces = workbench.surfaces
  let disposed = false
  let cleanup: (() => void | Promise<void>)[] = []
  const teardown = async (): Promise<void> => {
    const results = await Promise.allSettled(
      cleanup.reverse().map((dispose) => {
        try {
          return dispose()
        } catch (error) {
          return Promise.reject(error)
        }
      }),
    )
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        'Jev 工作区清理失败',
      )
  }
  let offLocale: (() => void) | undefined
  ctx.effect(() => async () => {
    if (disposed) return
    disposed = true
    offLocale?.()
    await teardown()
  })
  const mount = (): void => {
    if (disposed) return
    cleanup = []
    const t: Translate = (key, vars) => ctx.locale.t(key, vars)
    let submitted: WorkbenchSnapshot | undefined
    const workspace = bindJevWorkspace(surfaces, ctx.agnes, t)
    cleanup.push(() => workspace.dispose())
    const records = createRuntimeRecordTrace(surfaces.aside, ctx.agnes, workspace.directStats.update, {
      onCut: (cut) => workbench.setReplayCut(cut),
      t,
    })
    cleanup.push(() => records.dispose())
    const target = (id: string): WorkbenchTarget => {
      const jev = workbench.snapshot.runtimes.find((runtime) => runtime.id === 'jevloop')
      return {
        provider: 'jev-workspace',
        id,
        mode: 'comparison',
        title: t('entry.target.title', { id: id.slice(-8) }),
        label: t('entry.target.label'),
        hint: t('entry.target.hint'),
        modelLabel: t('entry.target.model'),
        workspaceLabel: t('entry.target.workspace'),
        ...(jev?.decisionBackends ? { decisionBackends: jev.decisionBackends } : {}),
        ...(jev?.defaultDecisionBackend ? { defaultDecisionBackend: jev.defaultDecisionBackend } : {}),
        query: { comparison: id },
      }
    }
    const comparison = createComparisonWorkspace(
      ctx.agnes,
      () => {
        const state = submitted ?? workbench.snapshot
        return {
          runtimes: state.runtimes,
          workspaces: state.workspaces,
          permissionMode: state.permissionMode,
          ...(state.cwd === undefined ? {} : { cwd: state.cwd }),
          ...(state.model === undefined ? {} : { model: state.model }),
          ...(state.jevStages === undefined ? {} : { jevStages: state.jevStages }),
        }
      },
      {
        host: surfaces.overlay,
        select: async (id) => {
          if (disposed) throw new Error('Jev 工作区已卸载；已接收的任务仍由后台持有。')
          await workbench.select(id ? target(id) : undefined)
        },
        t,
      },
    )
    cleanup.push(() => comparison.dispose())
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'jev-open-comparison secondary-button'
    open.textContent = t('entry.open')
    open.hidden = true
    const showError = (error: unknown) => {
      if (disposed) return
      status.textContent =
        comparisonCreationMessage(error, t) ?? (error instanceof Error ? error.message : String(error))
    }
    const status = document.createElement('span')
    status.className = 'jev-workspace-status'
    status.setAttribute('role', 'status')
    const openComparison = () => {
      status.textContent = ''
      void comparison
        .open(workbench.target?.provider === 'jev-workspace' ? workbench.target.id : undefined)
        .catch(showError)
    }
    open.addEventListener('click', openComparison)
    const configure = document.createElement('button')
    configure.type = 'button'
    configure.className = 'jev-open-settings secondary-button'
    configure.textContent = t('entry.configure')
    const openSettings = () => {
      void workbench.openSettings('jev').catch((error) => {
        if (disposed) return
        showError(error)
        status.hidden = false
      })
    }
    configure.addEventListener('click', openSettings)
    surfaces.toolbar.append(open, configure, status)
    cleanup.push(() => {
      configure.removeEventListener('click', openSettings)
      configure.remove()
      open.removeEventListener('click', openComparison)
      open.remove()
      status.remove()
    })
    let observed: string | undefined
    const update = (state: WorkbenchSnapshot) => {
      if (disposed) return
      open.disabled = !state.connected || state.sending || state.loading
      // The entry serves a fresh draft and the active comparison target. A single-line
      // session (either runtime, or still loading) cannot start or resume a comparison,
      // so the entry and its status stay hidden beside it.
      const comparisonTarget = workbench.target?.provider === 'jev-workspace'
      open.hidden = !comparisonTarget && (state.session !== undefined || state.loading)
      status.hidden = open.hidden
      const session = state.session?.runtime?.id === 'jevloop' ? state.session : undefined
      workspace.accounting.update(session?.id, session?.head)
      const identity = session ? `${session.id}:${session.runtime?.version}` : undefined
      if (identity !== observed) {
        observed = identity
        records.select(session?.id, session?.head ?? 0, session?.runtime)
      } else if (session) records.head(session.head)
      workspace.updateView(state.view)
    }
    const offState = workbench.subscribe(update)
    const offEvents = workbench.observe((event) => {
      if (!disposed && observed) records.observe(event)
    })
    cleanup.push(offState, offEvents)
    const unregister = workbench.register({
      id: 'jev-workspace',
      modes: (state) => [
        {
          id: 'comparison',
          label: t('entry.target.label'),
          available: ['native', 'jevloop'].every((id) =>
            state.runtimes.some((runtime) => runtime.id === id && runtime.available),
          ),
          unavailableReason: t('entry.mode.unavailable'),
          hint: t('entry.mode.hint'),
          // The option rows carry locale keys; the host picker renders them verbatim.
          permissions: COMPARISON_PERMISSION_OPTIONS.map((option) => ({
            ...option,
            label: t(option.label),
            description: t(option.description),
          })),
          permissionMessage: (mode) => t('entry.mode.permission', { mode: comparisonPermissionLabel(mode, t) }),
        },
      ],
      resolve: (url) => url.searchParams.get('comparison') ?? undefined,
      open: async (id) => {
        await comparison.open(id)
      },
      async submit(input) {
        if (disposed) throw new Error('Jev 工作区已卸载。')
        submitted = input.snapshot
        // Keep the two-argument call shape when this host made no per-round choice.
        const decisionBackend = input.snapshot.decisionBackend
        try {
          if (input.target)
            await (decisionBackend === undefined
              ? comparison.submitDraft(input.target, input.text)
              : comparison.submitDraft(input.target, input.text, decisionBackend))
          else
            await (decisionBackend === undefined
              ? comparison.startDraft(input.key, input.text)
              : comparison.startDraft(input.key, input.text, decisionBackend))
        } finally {
          submitted = undefined
        }
      },
      close: () => comparison.close(),
      errorMessage: (error) => comparisonCreationMessage(error, t) ?? undefined,
    })
    cleanup.push(unregister)
    update(workbench.snapshot)
    if (workbench.target?.provider === 'jev-workspace')
      void comparison.open(workbench.target.id).catch(showError)
  }
  mount()
  // 语言切换：整体卸载重挂，面板按新语言重建（与宿主 applyLocaleText 同一触发源）。
  offLocale = ctx.locale?.subscribe(() => {
    if (disposed) return
    void teardown()
      .catch(() => undefined)
      .then(() => mount())
  })
}
