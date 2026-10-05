import type { ClientContext, WorkbenchSnapshot, WorkbenchTarget } from '@agnes/web-client'
import { comparisonCreationMessage } from './comparison-errors.js'
import { COMPARISON_PERMISSION_OPTIONS, comparisonPermissionLabel } from './comparison-permission.js'
import { createComparisonWorkspace } from './comparison-workspace.js'
import { bindJevWorkspace } from './jev-workspace.js'
import { createRuntimeRecordTrace } from './runtime-record-trace.js'

/** Loaded exclusively from the installed client descriptor, never imported by the Web shell. */
export function apply(ctx: ClientContext): void {
  const workbench = ctx.workbench
  if (!workbench) throw new Error('当前 Web 宿主不支持可扩展工作区。请升级宿主后启用 Jev 工作区。')
  const surfaces = workbench.surfaces
  let disposed = false
  const cleanup: (() => void | Promise<void>)[] = []
  ctx.effect(() => async () => {
    if (disposed) return
    disposed = true
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
  })
  let submitted: WorkbenchSnapshot | undefined
  const workspace = bindJevWorkspace(surfaces, ctx.agnes)
  cleanup.push(() => workspace.dispose())
  const records = createRuntimeRecordTrace(surfaces.aside, ctx.agnes, workspace.directStats.update, {
    onCut: (cut) => workbench.setReplayCut(cut),
  })
  cleanup.push(() => records.dispose())
  const target = (id: string): WorkbenchTarget => ({
    provider: 'jev-workspace',
    id,
    mode: 'comparison',
    title: `双线对比 ${id.slice(-8)}`,
    label: '双线对比 · Native + JevLoop',
    hint: '继续发送给当前双线；工作区与模型已冻结。打开双线对比可查看结果、审批或停止。',
    modelLabel: '对比模型已冻结',
    workspaceLabel: '双线隔离工作区',
    query: { comparison: id },
  })
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
      }
    },
    {
      host: surfaces.overlay,
      select: async (id) => {
        if (disposed) throw new Error('Jev 工作区已卸载；已接收的任务仍由后台持有。')
        await workbench.select(id ? target(id) : undefined)
      },
    },
  )
  cleanup.push(() => comparison.dispose())
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'jev-open-comparison secondary-button'
  open.textContent = '双线对比'
  open.hidden = true
  const showError = (error: unknown) => {
    if (disposed) return
    status.textContent =
      comparisonCreationMessage(error) ?? (error instanceof Error ? error.message : String(error))
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
  surfaces.toolbar.append(open, status)
  cleanup.push(() => {
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
        label: '双线对比 · Native + JevLoop',
        available: ['native', 'jevloop'].every((id) =>
          state.runtimes.some((runtime) => runtime.id === id && runtime.available),
        ),
        unavailableReason: '需要 Native 与 JevLoop 均可用',
        hint: '双线使用相同模型与默认预设，在隔离副本中运行；审批分别处理。',
        permissions: COMPARISON_PERMISSION_OPTIONS,
        permissionMessage: (mode) =>
          `双侧下一轮将使用「${comparisonPermissionLabel(mode)}」，对比目录保持隔离。`,
      },
    ],
    resolve: (url) => url.searchParams.get('comparison') ?? undefined,
    open: async (id) => {
      await comparison.open(id)
    },
    async submit(input) {
      if (disposed) throw new Error('Jev 工作区已卸载。')
      submitted = input.snapshot
      try {
        if (input.target) await comparison.submitDraft(input.target, input.text)
        else await comparison.startDraft(input.key, input.text)
      } finally {
        submitted = undefined
      }
    },
    close: () => comparison.close(),
    errorMessage: (error) => comparisonCreationMessage(error) ?? undefined,
  })
  cleanup.push(unregister)
  update(workbench.snapshot)
  if (workbench.target?.provider === 'jev-workspace')
    void comparison.open(workbench.target.id).catch(showError)
}
