import {
  type ConfigSnapshot,
  type PageSessionMeta,
  readSessionTitle,
  type UITimeline,
  type UITurn,
  type WorkspaceEntry,
} from '@agnes/protocol'
import {
  createClient,
  type LedgerEvent,
  memoryJournal,
  type PermissionOutcome,
  type PermissionRequest,
  type Session,
} from '@agnes/sdk/browser'
import { bindDismissibleDialog } from '@agnes/web-admin-frame'
import { createPendingCoordinator } from './admin-pane-coordinator.js'
import { bindAppearance, bindSkinGroup } from './appearance.js'
import type { ApprovalAction } from './approval.js'
import { installBrowserLogCapture } from './browser-log.js'
import { type ClaimResolver, startClientModules } from './client-modules/boot.js'
import { startPluginHotReload } from './client-modules/hot-reload.js'
import type { RosterSource } from './client-modules/reconcile.js'
import { bindSlotCardContext } from './client-modules/timeline-slot.js'
import type { ComposerView } from './composer.js'
import { rememberWebComposer, selectionFromMemory } from './composer-memory.js'
import { createComputerUseStatusController } from './computer-use.js'
import { createDiagnosticsDialog } from './diagnostics-dialog.js'
import {
  APPROVAL_SEARCH_PAGES,
  approvalOutsideWindow,
  createLiveProjection,
  findApproval,
  type LiveProjection,
} from './live-projection.js'
import type { ModelPickerOption } from './model-picker.js'
import { renderWorkspaceOptions } from './navigation.js'
import { type PermissionMode, permissionLabel, yoloEnabled } from './permission-picker.js'
import {
  canSubmitComposer,
  composerActionPresentation,
  composerHintPresentation,
  errorNotice,
  type KnownSessionModel,
  modelSelectAccessibleName,
  modelSelectLabel,
  setButtonLabel,
  shouldShowEmptyState,
  workspaceErrorNotice,
} from './presentation.js'
import { createReconnectController } from './reconnect.js'
import { createSessionActions, forkTitle } from './session-actions.js'
import { bindWebSession, loadWebSession } from './session-binding.js'
import { createTitleRefresh, sessionTitle } from './session-title.js'
import { createSettingsController } from './settings.js'
import {
  cacheSkinEntry,
  clearSkinCache,
  fetchSkinCss,
  planSkinReconcile,
  readSkinCache,
  SKIN_STORAGE_KEY,
  type SkinRosterEntry,
} from './skin.js'
import { safeThemeStorage } from './theme.js'
import {
  durableApprovalActions,
  nodeText,
  type RunReceipt,
  receiptFromTurns,
  recordRunEvent,
  type WebView,
  webView,
} from './view.js'
import { requestWorkspacePicker, workspacePickerAvailable } from './workspace-picker.js'

installBrowserLogCapture()

function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}
const button = (id: string) => element(id, 'button')
const composerDraftKey = 'agnes-web-composer-draft'
const savedComposerDraft = sessionStorage.getItem(composerDraftKey)
const notice = element('notice', 'p')
const conversation = element('conversation-shell', 'div')
const newSessionDialog = element('new-session', 'dialog')
const newSessionForm = element('new-session-form', 'form')
const newSessionCwd = element('new-session-cwd', 'input')
const newSessionCancel = button('new-session-cancel')
const newSessionCreate = button('new-session-create')
const workspacePick = button('workspace-pick')
const workspacePickerState = element('workspace-picker-state', 'p')
const workspaceManual = element('workspace-manual', 'details')
const wsUrl = element('agnes-config', 'meta').dataset.ws
const client = createClient({
  transport: { kind: 'ws', url: wsUrl ?? '', protocols: ['agnes-v1'] },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
let intentionalClose = false
const reconnect = createReconnectController({ reload: () => location.reload() })
// 客户端模块底座（WC8）：Cordis 根 + 五个宿主服务 + workbench.panel 挂载点。
// 名册真源是 `_agnes/v1/clientModules.list`（P1a）；profile 要等 config.get() 才报出，
// 之前名册按空处理（fail-closed，不加载任何模块）。
const moduleExtIds = new Map<string, string[]>()
const rosterSource: RosterSource = {
  async list() {
    if (!profileName) return { revision: '', modules: [], statuses: [] }
    const roster = await client.clientModules.list(profileName)
    // `rows` is the authoritative browser lifecycle surface.  The legacy
    // `modules` compatibility projection deliberately cannot carry every
    // immutable declaration, including the per-module service allow-list.
    const modules = roster.rows.flatMap((row) => {
      if (
        !row.enabled ||
        row.phase !== 'ready' ||
        row.packageId === undefined ||
        row.revision === undefined ||
        row.entryUrl === undefined ||
        row.styleUrls === undefined ||
        row.slots === undefined ||
        row.extIds === undefined
      )
        return []
      return [
        {
          rowId: row.rowId,
          packageId: row.packageId,
          revision: row.revision,
          entryUrl: row.entryUrl,
          styleUrls: row.styleUrls,
          slots: row.slots,
          ...(row.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: row.slotCatalogVersion }),
          ...(row.contentDigest === undefined ? {} : { contentDigest: row.contentDigest }),
          extIds: row.extIds,
          services: row.services ?? [],
          ...(row.publicConfig ? { publicConfig: row.publicConfig } : {}),
        },
      ]
    })
    // 认领真源（WC9）：名册刷新即重建 owner(browser row) → extIds 映射。
    // A package may publish several independent browser rows, so packageId is
    // deliberately not used as the slot-owner key here.
    moduleExtIds.clear()
    for (const mod of modules) moduleExtIds.set(mod.rowId ?? mod.packageId, mod.extIds)
    return {
      revision: roster.revision,
      modules,
      statuses: roster.statuses,
      ...(roster.rowAliases === undefined ? {} : { rowAliases: roster.rowAliases }),
    }
  },
}
// 时间线卡片的按包认领（WC9）：fill.extId 命中注册项归属包的名册 extIds 才认领。
const claimSlotCard: ClaimResolver = (entry, extId) =>
  entry.owner !== undefined && (moduleExtIds.get(entry.owner)?.includes(extId) ?? false)
const clientModules = await startClientModules({
  agnes: client,
  clientServiceCaller: async (module, sessionId, service, input) => {
    const response = await fetch('/api/client-modules/service', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ rowId: module.rowId ?? module.packageId, sessionId, service, input }),
    })
    if (!response.ok) throw new Error('插件后端服务当前不可用。')
    const body: unknown = await response.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || !('output' in body))
      throw new Error('插件后端服务返回无效结果。')
    return (body as { output: unknown }).output
  },
  clientEffectCaller: async (module, sessionId, service, commandId, input) => {
    const response = await fetch('/api/client-modules/effect', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        rowId: module.rowId ?? module.packageId,
        sessionId,
        service,
        commandId,
        input,
      }),
    })
    if (!response.ok) throw new Error('插件命令当前不可用或结果未知。')
    const body: unknown = await response.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || !('output' in body)) throw new Error('插件命令返回无效结果。')
    return (body as { output: unknown }).output
  },
  authorizeCommand: ({ owner, command }) =>
    window.confirm(
      `是否允许插件 ${owner} 执行命令“${command.title ?? command.id}”${command.effectService ? `（服务：${command.effectService}）` : ''}？`,
    ),
  panelContainer: document.getElementById('main-content') ?? undefined,
  sidebarContainer: document.querySelector<HTMLElement>('aside.sidebar') ?? undefined,
  sidebar: {
    actions: {
      newSession: () => run(beginNewDraft),
      addWorkspace: () =>
        run(async () => {
          if (!draftingNew) await beginNewDraft()
          openNewSessionDialog()
        }),
      openSettings: () => {
        settingsRegion.open('model')
        run(() => settings.open())
      },
      openSession: (id) =>
        run(async () => {
          if (sessionPending) return
          await open(id)
          clientModules.sidebar?.close()
        }),
      sessionAction: (action, id, title, trigger) => {
        void sessionActions.act(action, id, title, trigger)
      },
      loadMore: (cursor) =>
        run(async () => {
          await list(cursor)
        }),
    },
  },
  transcript: { onFork: forkTurn },
  conversationContainer: conversation,
  topbarContainer: document.querySelector<HTMLElement>('header.topbar') ?? undefined,
  approvalContainer: document.getElementById('approval') ?? undefined,
  composerContainer: document.getElementById('composer-mount') ?? undefined,
  composer: {
    initialDraft: savedComposerDraft ?? '',
    onCancel: handleComposerCancel,
    onDraftChange: handleComposerDraftChange,
    onError: showError,
    onModelSelect: selectModel,
    onPermissionSelect: selectPermission,
    onSubmit: submitComposer,
    onWorkspace: handleComposerWorkspace,
  },
  traceContainer: document.getElementById('trace-panel') ?? undefined,
  trace: {
    toggle: button('view-trace'),
    chatToggle: button('view-chat'),
    conversation,
  },
  rightbarContainer: document.getElementById('rightbar-panel') ?? undefined,
  settingsPaneContainer: document.getElementById('config') ?? undefined,
  settings: {
    onChange: ({ pane, tab }) => {
      if (pane === 'model') void settings.open()
      else if (pane === 'plugin') void openAdminPane('plugin')
      else if (pane === 'resources') void openAdminPane('resources', tab ?? 'skills')
      else if (pane === 'archived') void sessionActions.loadArchived()
      else if (pane === 'computer-use') void computerUseStatus.refresh()
      else {
        appearance.sync()
        void skinGroup.refresh()
      }
    },
  },
  rosterSource,
})
const tracePanel = clientModules.trace as NonNullable<typeof clientModules.trace>
if (!tracePanel) throw new Error('missing trace region')
const settingsRegion = clientModules.settings as NonNullable<typeof clientModules.settings>
if (!settingsRegion) throw new Error('missing settings region')
const topbarRuntime = clientModules.topbar as NonNullable<typeof clientModules.topbar>
if (!topbarRuntime) throw new Error('missing topbar region')
const approvalRuntime = clientModules.approval as NonNullable<typeof clientModules.approval>
if (!approvalRuntime) throw new Error('missing approval region')
const composerRuntime = clientModules.composer as NonNullable<typeof clientModules.composer>
if (!composerRuntime) throw new Error('missing composer region')
const conversationRuntime = clientModules.conversation as NonNullable<typeof clientModules.conversation>
if (!conversationRuntime) throw new Error('missing conversation region')
const renderer = clientModules.transcript as NonNullable<typeof clientModules.transcript>
if (!renderer) throw new Error('missing transcript region')
bindSlotCardContext({ registry: clientModules.registry, claim: claimSlotCard })

// A daemon notice is only an invalidation hint. Every read goes back through the SDK roster
// endpoint, and a failed read leaves the current page/modules intact for the next hint.
function scheduleClientRosterRead(initial = false): void {
  void (initial ? clientModules.reconciler.reconcileNow() : clientModules.reconciler.invalidate()).catch(
    (error) => console.warn('[client-modules] 名册重读失败', error),
  )
}

scheduleClientRosterRead(true)
// A separate same-origin SSE stream carries immutable snapshot rebuild hints. It is intentionally
// independent of the daemon WebSocket, and failures only affect that package's next retry.
const stopPluginHotReload = startPluginHotReload({
  reconciler: clientModules.reconciler,
  onError: (error) => console.warn('[client-modules] SSE 热替换失败', error),
})
addEventListener('pagehide', () => stopPluginHotReload(), { once: true })
let connected = false
let configured = false
let current: Session | undefined
let projection: UITimeline | undefined
let selection = 0
let listGeneration = 0
let live: LiveProjection | undefined
// The window's first node is the session's first, so its first user message titles the task.
let windowAtStart = true
let approvalSearch: 'idle' | 'searching' | 'not-found' = 'idle'
let approvalSearchTicket: string | undefined
let streamFrame: number | undefined
let stopEvents: (() => Promise<void>) | undefined
let offPermission: (() => void) | undefined
let sending = false
let awaitingPromptStart = false
let stopping = false
let sessionPending = false
let newSessionCreating = false
let workspacePickerReady: boolean | undefined
let workspacePickerBusy = false
let stopAfterSeq = 0
let approvalBusy = false
let runtimeModels: Array<{ route: string; id: string; label?: string }> = []
let accountLabels = new Map<string, string>()
let accountProvider: { route?: string; id?: string; model?: string } | null = null
let knownSessionModel: KnownSessionModel | undefined
let initialModelPending: KnownSessionModel | undefined
let modelChangePending = false
let permissionMode: PermissionMode = 'workspace'
let permissionChangePending = false
let sessionYoloEnabled = false
let submissionGeneration = 0
// daemon 自己报出的 profile（config.get() 后才知道）；皮肤清单与客户端模块名册都必须把它传回去。
let profileName = ''
const receipts = new Map<string, RunReceipt>()
const sessionLabels = new Map<string, string>()
const sessionTitles = new Map<string, string>()
const titleRefresh = createTitleRefresh(async (id) => {
  const version = listGeneration
  const page = await client.session.list({ q: { prefix: id }, limit: 100 })
  if (version !== listGeneration) return false
  const row = page.items.find((item) => item.sessionId === id)
  if (!row?.title) return false
  sessionTitles.set(id, row.title)
  const index = sessionRows.findIndex((item) => item.sessionId === id)
  if (index >= 0) sessionRows[index] = row
  updateTitle(id, row.title)
  return true
})
function updateTitle(id: string, title: string): void {
  sessionLabels.set(id, title)
  if (current?.id === id) topbarRuntime.setTaskTitle(title)
  updateSidebar()
}
let sessionRows: PageSessionMeta['items'] = []
let workspaceRows: WorkspaceEntry[] = []
let sessionNext: string | undefined
let selectedWorkspace: WorkspaceEntry | undefined
let draftingNew = false
let pendingSessionKey: string | undefined
let liveApproval:
  | { request: PermissionRequest; afterSeq: number; finish(value: PermissionOutcome): void }
  | undefined

function updateSidebar(): void {
  clientModules.sidebar?.update({
    sessions: sessionRows,
    workspaces: workspaceRows,
    labels: sessionLabels,
    ...(current ? { currentId: current.id } : {}),
    ...(sessionNext ? { next: sessionNext } : {}),
    sessionPending,
    newDisabled: !connected || sending || sessionPending || newSessionCreating,
  })
}

const SESSION_WATCH_STOP_TIMEOUT_MS = 3000
async function stopWithTimeout(stop: (() => Promise<void>) | undefined): Promise<boolean> {
  if (!stop) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      stop(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('旧会话事件流关闭超时')), SESSION_WATCH_STOP_TIMEOUT_MS)
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const settings = createSettingsController({ client, onSaved: savedConfiguration, onError: showError })
const sessionActions = createSessionActions({
  client,
  changed: () => list(),
  fork: forkSidebar,
  error: (error) => {
    if (document.body.classList.contains('sidebar-open')) clientModules.sidebar?.dismiss()
    showError(error)
  },
})
let sessionRecovery: { id: string; message: string } | undefined
function errorMessage(error: unknown): string {
  // Provider values are redacted by settings before leaving that controller.
  const message = error instanceof Error ? error.message : '操作失败，请重试。'
  const diagnostic =
    error instanceof Error && 'data' in error && error.data && typeof error.data === 'object'
      ? (error.data as {
          code?: unknown
          reason?: unknown
          diagnosticId?: unknown
          diagnosticUnavailable?: unknown
          error?: { code?: unknown }
        })
      : undefined
  return errorNotice(
    message,
    diagnostic?.diagnosticId,
    diagnostic?.diagnosticUnavailable,
    diagnostic?.code === 'TURN_ERROR' ? diagnostic.error?.code : undefined,
    diagnostic?.reason,
  )
}
function showError(error: unknown): void {
  const message = errorMessage(error)
  if (sessionRecovery) {
    renderSessionRecovery(message)
    notice.dataset.kind = 'error'
  } else {
    notice.textContent = message
    notice.dataset.kind = 'error'
  }
  if (newSessionDialog.open) element('new-session-error', 'p').textContent = message
}
function run(op: () => Promise<void>): void {
  element('new-session-error', 'p').textContent = ''
  if (sessionRecovery) renderSessionRecovery()
  else {
    notice.textContent = ''
    notice.dataset.kind = ''
  }
  void op().catch(showError)
}
function showSessionRecovery(error: unknown, id: string): void {
  const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
  sessionRecovery = {
    id,
    message:
      data && typeof data === 'object' && 'code' in data && data.code === 'SESSION_PROFILE_MISSING'
        ? '这个历史任务的旧配置文件已缺失，暂时无法打开。记录仍保留，未切换为当前配置。'
        : data && typeof data === 'object' && 'reason' in data && data.reason === 'legacy-ledger-format'
          ? errorMessage(error)
          : `历史任务打开失败。${errorMessage(error)}`,
  }
  renderSessionRecovery()
}
function recoveryDisabled(): boolean {
  return !connected || sending || sessionPending || newSessionCreating
}
function renderSessionRecovery(message = ''): void {
  if (!sessionRecovery) return
  // Keep the controls mounted across refresh errors, so keyboard focus is not discarded.
  if (!notice.querySelector('[data-recovery-message]')) {
    notice.textContent = ''
    const description = document.createElement('span')
    description.dataset.recoveryMessage = ''
    const retry = document.createElement('button')
    retry.dataset.recoveryAction = 'retry'
    retry.type = 'button'
    retry.textContent = '重试打开'
    retry.addEventListener('click', () => {
      if (recoveryDisabled() || !sessionRecovery) return
      const id = sessionRecovery.id
      run(() => open(id))
    })
    const create = document.createElement('button')
    create.dataset.recoveryAction = 'create'
    create.type = 'button'
    create.textContent = '新建任务'
    create.addEventListener('click', () => {
      if (recoveryDisabled()) return
      run(() => beginNewDraft())
    })
    const secondary = document.createElement('span')
    secondary.dataset.recoveryError = ''
    notice.append(description, retry, document.createTextNode(' '), create, secondary)
  }
  notice.dataset.kind = 'session-recovery'
  const description = notice.querySelector<HTMLElement>('[data-recovery-message]')
  const secondary = notice.querySelector<HTMLElement>('[data-recovery-error]')
  if (description)
    description.textContent = `${sessionRecovery.message} 可以重试、选择侧栏其他任务，或新建任务。 `
  if (secondary) secondary.textContent = message ? ` ${message}` : ''
  for (const control of notice.querySelectorAll<HTMLButtonElement>('[data-recovery-action]'))
    control.disabled = recoveryDisabled()
}
function clearSessionRecovery(): void {
  if (!sessionRecovery) return
  sessionRecovery = undefined
  notice.textContent = ''
  notice.dataset.kind = ''
}
function setConnection(value: 'connecting' | 'connected' | 'reconnecting' | 'closed'): void {
  connected = value === 'connected'
  topbarRuntime.setConnectionState(value)
  settings.setConnected(connected)
  renderControls()
}
function renderControls(): void {
  // 切换会话加载期间的视觉态：旧画面降不透明度提示「正在准备」，新投影就绪后
  // 由 sessionPending = false 的那次 renderControls 平滑恢复。
  document.body.classList.toggle('session-switching', sessionPending)
  const available = connected
  const busy = projection ? webView(projection).busy : false
  const hasInput = composerRuntime.getDraft().trim().length > 0
  const initialSubmissionPending = sending && pendingSessionKey !== undefined
  const action = composerActionPresentation({ busy, loading: sessionPending, sending })
  for (const control of notice.querySelectorAll<HTMLButtonElement>('[data-recovery-action]'))
    control.disabled = recoveryDisabled()
  const canStartDraft = draftingNew && selectedWorkspace?.available === true
  const composerView: ComposerView = {
    cancel: {
      disabled: !connected || !busy || stopping || sessionPending,
      hidden: !busy && !stopping,
      label: stopping ? '正在请求停止…' : '停止',
    },
    connected,
    configured,
    hasSession: current !== undefined || draftingNew,
    hint:
      knownSessionModel && !selectedModelAvailable()
        ? { kind: 'state', text: '当前模型已不可用，请重新选择模型' }
        : composerHintPresentation({
            connected,
            configured,
            hasSession: current !== undefined || draftingNew,
            busy,
            stopping,
            loading: sessionPending,
          }),
    input: {
      disabled:
        !available || (!current && !draftingNew) || stopping || sessionPending || initialSubmissionPending,
      placeholder: busy ? '补充下一轮要做的事…' : '描述你想完成的事…',
    },
    loading: sessionPending,
    model: {
      accessibleName: modelSelectAccessibleName(knownSessionModel),
      disabled:
        !available ||
        (!current && !draftingNew) ||
        busy ||
        sessionPending ||
        initialSubmissionPending ||
        !runtimeModels.length,
      label: modelSelectLabel(knownSessionModel),
      options: runtimeModels,
      pending: modelChangePending,
      ...(knownSessionModel ? { selected: knownSessionModel } : {}),
    },
    permission: {
      disabled:
        !available || (!current && !draftingNew) || busy || sessionPending || initialSubmissionPending,
      pending: permissionChangePending,
      selected: permissionMode,
    },
    sending,
    send: {
      disabled:
        !available ||
        !configured ||
        !selectedModelAvailable() ||
        (!current && !canStartDraft) ||
        !hasInput ||
        sending ||
        stopping ||
        sessionPending,
      label: action.label,
      mode: action.mode,
      title: action.title,
    },
    stopping,
    usage: projection?.usage,
    workspace: {
      disabled: !available || sending || sessionPending,
      label: selectedWorkspace?.name ?? (current ? '当前工作区' : '选择工作区'),
      title: selectedWorkspace?.path ?? (current ? '当前会话工作区' : '选择工作区'),
    },
  }
  composerRuntime.render(composerView)
  updateSidebar()
  if (sessionPending) {
    topbarRuntime.setStatus('正在准备会话', 'loading')
  }
  conversationRuntime.setEmptyStateVisible(shouldShowEmptyState(projection))
  renderNewSessionControls()
}
// 流式期间每个事件都会让轨迹面板全量走查一遍节点，长会话里比时间线本身还贵。
// busy 时把面板喂食节流到 500ms（尾沿补一帧，喂的是最新视图）；终态与空闲路径
// 立即刷，保证收尾状态不迟到。节流在 app 调用侧，region 挂载本身保持同步语义。
const TRACE_THROTTLE_MS = 500
let tracePaintedAt = 0
let traceTrailing: ReturnType<typeof setTimeout> | undefined
let tracePending:
  | {
      sessionId: string
      view: WebView
      turns: readonly UITurn[] | undefined
      meta: ReturnType<typeof transcriptMeta>
    }
  | undefined
function paintTrace(): void {
  const pending = tracePending
  tracePending = undefined
  if (!pending || !current || pending.sessionId !== current.id) return
  tracePaintedAt = Date.now()
  tracePanel.render(pending.view.nodes, pending.turns, pending.meta)
}
function renderTrace(
  view: WebView,
  turns: readonly UITurn[] | undefined,
  meta: ReturnType<typeof transcriptMeta>,
): void {
  if (!current) return
  tracePending = { sessionId: current.id, view, turns, meta }
  const immediate = !view.busy || Date.now() - tracePaintedAt >= TRACE_THROTTLE_MS
  if (immediate) {
    if (traceTrailing !== undefined) clearTimeout(traceTrailing)
    traceTrailing = undefined
    paintTrace()
    return
  }
  if (traceTrailing === undefined)
    traceTrailing = setTimeout(() => {
      traceTrailing = undefined
      paintTrace()
    }, TRACE_THROTTLE_MS)
}
function render(): void {
  if (!projection) {
    topbarRuntime.setStatus('新任务')
    tracePanel.render([], [])
    renderControls()
    return
  }
  // 会话切换的尾流（旧审批收尾、事件竞态）可能在这时触发渲染，而投影仍属于
  // 上一会话：此时屏幕上保留的正是上一会话画面，任何重绘都会把旧投影的
  // 模型、标题、审批卡写进新会话的控件。等投影换代后再渲染。
  if (!current || projection.sessionId !== current.id) return
  if (projection.usage?.model && !knownSessionModel && !modelChangePending && !initialModelPending) {
    knownSessionModel = { route: projection.usage.model.route, id: projection.usage.model.id }
    rememberWebComposer({ model: knownSessionModel })
  }
  const receipt = current ? receipts.get(current.id) : undefined
  const view = webView(projection, receipt)
  if (!view.busy && receipt?.reason && liveApproval && receipt.endSeq > liveApproval.afterSeq) {
    // A real later terminal invalidates this live request; no cancelled task keeps an approval card.
    liveApproval.finish({ verdict: 'rejected' })
    return
  }
  const firstInput = windowAtStart ? view.nodes.find((node) => node.kind === 'user') : undefined
  const selectedId = current?.id
  const title = sessionTitle(
    selectedId
      ? (sessionTitles.get(selectedId) ?? sessionRows.find((row) => row.sessionId === selectedId)?.title)
      : undefined,
    firstInput ? nodeText(firstInput) : undefined,
  )
  topbarRuntime.setTaskTitle(title)
  if (firstInput && current) {
    updateTitle(current.id, title)
  }
  if (awaitingPromptStart && view.busy) {
    awaitingPromptStart = false
    sending = false
  }
  if (!view.busy && receipt?.reason && receipt.endSeq > stopAfterSeq) stopping = false
  topbarRuntime.setStatus(
    stopping ? '正在请求停止，等待后台确认' : liveApproval ? '等待审批' : view.status,
    view.busy ? 'running' : (receipt?.reason ?? 'idle'),
  )
  const meta = transcriptMeta()
  renderer.render(view.nodes, projection.turns, meta)
  renderTrace(view, projection.turns, meta)
  if (approvalOutsideWindow(projection)) {
    const ticket = projection.opState?.parked?.ticket
    // A different parked approval is looked for afresh.
    if (ticket !== approvalSearchTicket && approvalSearch !== 'searching') approvalSearch = 'idle'
    approvalSearchTicket = ticket
    searchApproval(APPROVAL_SEARCH_PAGES)
  } else approvalSearch = 'idle'
  renderApproval()
  renderControls()
}
function renderApproval(): void {
  const durable = projection ? webView(projection).approval : undefined
  const parked = !liveApproval && !durable && projection ? projection.opState?.parked : undefined
  if (parked && approvalSearch !== 'idle') {
    const stick = conversationRuntime.isTranscriptNearBottom()
    const searching = approvalSearch === 'searching'
    // The approval's own node, with the options it really offers, is before the loaded window; a
    // verdict can only be given there, so this card only leads to it.
    approvalRuntime.render({
      key: `parked:${parked.ticket}`,
      title: searching ? '正在查找待处理的审批…' : '有一项审批等待处理',
      summary: `这项审批在较早的记录里，过期时间 ${parked.expiresAt}。`,
      impact: searching ? '正在加载更早的记录。' : '定位后可以看到它的完整内容和可选操作。',
      actions: searching ? [] : [{ id: 'locate', label: '定位审批', onSelect: () => searchApproval() }],
      disabled: !connected,
    })
    if (stick) renderer.pinToBottom()
    return
  }
  const key = liveApproval ? `live:${liveApproval.request.toolCall.toolCallId}` : (durable?.ticket ?? '')
  // 审批卡是会话区外的流内兄弟：显示/收回都会改变 #transcript 的视口高度。
  // 原本贴底的会话要保持贴底，否则最新过程被压出可视区、贴底跟随也会被破坏。
  const stick = conversationRuntime.isTranscriptNearBottom()
  if (!key) {
    approvalRuntime.render(undefined)
    if (stick) renderer.pinToBottom()
    return
  }

  const liveTitle = liveApproval?.request.toolCall.title
  const summary = typeof liveTitle === 'string' ? liveTitle : (durable?.summary ?? '允许执行此操作？')
  const kind = liveApproval?.request.toolCall.kind
  const risks = {
    destructive: '可能修改或删除内容',
    always: '此操作需要明确确认',
    budget: '涉及预算使用',
    unknown: '影响范围需要确认',
  }
  const impact = durable
    ? risks[durable.risk]
    : kind === 'execute'
      ? '将在此任务的工作目录执行命令。请核对命令后决定。'
      : '请核对工具及参数后决定是否继续。'
  const input = liveApproval?.request.toolCall.rawInput
  const serializedInput = input === undefined ? undefined : JSON.stringify(input, null, 2)
  const actions: ApprovalAction[] = []
  const decide = (id: string, label: string, action: () => Promise<void>): void => {
    actions.push({
      id,
      label,
      onSelect: () =>
        run(async () => {
          if (approvalBusy || stopping) return
          approvalBusy = true
          renderApproval()
          try {
            await action()
          } finally {
            approvalBusy = false
            live?.refresh()
            renderApproval()
          }
        }),
    })
  }
  if (liveApproval) {
    const request = liveApproval
    const labels: Record<string, string> = {
      allow_once: '仅允许这次',
      allow_always: '本会话允许',
      reject_once: '拒绝',
      reject_always: '始终拒绝',
    }
    for (const option of request.request.options)
      decide(`live:${option.name}`, labels[option.name] ?? option.name, async () =>
        request.finish({ optionId: option.optionId }),
      )
  } else if (durable?.ticket) {
    const ticket = durable.ticket
    for (const { label, verdict } of durableApprovalActions(durable))
      decide(
        `durable:${verdict}`,
        label,
        async () => void (await client.approval.decide(ticket, verdict, { kind: 'local' })),
      )
  }
  approvalRuntime.render({
    key,
    title: '需要你的确认',
    summary,
    impact,
    ...(serializedInput === undefined ? {} : { preview: serializedInput.slice(0, 2048) }),
    actions,
    disabled: approvalBusy || stopping || !connected,
  })
  if (stick) renderer.pinToBottom()
}
function transcriptMeta(): { hasEarlier: boolean; loadEarlier?: () => Promise<unknown> } {
  const session = live
  if (!session?.hasEarlier()) return { hasEarlier: false }
  return { hasEarlier: true, loadEarlier: () => session.loadEarlier().catch(showError) }
}
/** Loads earlier pages, `limit` at most, until the parked approval's node is loaded. */
function searchApproval(limit?: number): void {
  const session = live
  if (!session || approvalSearch === 'searching' || (limit !== undefined && approvalSearch !== 'idle')) return
  approvalSearch = 'searching'
  renderApproval()
  void findApproval(session, () => projection, limit)
    .then((found) => {
      if (live !== session) return
      approvalSearch = found ? 'idle' : 'not-found'
      renderApproval()
    })
    .catch(showError)
}
/** What watching the event stream used to do per event: titles, the list, the run receipt. */
async function followEvent(session: Session, event: LedgerEvent): Promise<void> {
  const title = readSessionTitle(event)
  if (title?.status === 'generated') {
    // The list owns user overrides; a late automatic event cannot overwrite one.
    await list().catch(showError)
    titleRefresh.stop(session.id)
  } else if (title?.status === 'failed') titleRefresh.stop(session.id)
  // A new message makes this the most recently chatted session; the daemon now lists it first.
  if (event.type === 'user/message') void list().catch(showError)
  if (
    event.type === 'turn/end' &&
    (event.data as { reason?: string }).reason === 'completed' &&
    !sessionTitles.has(session.id)
  )
    titleRefresh.start(session.id)
  receipts.set(session.id, recordRunEvent(receipts.get(session.id), event))
}
async function list(cursor?: string): Promise<PageSessionMeta> {
  const epoch = ++listGeneration
  const page = await client.session.list({ limit: 100, ...(cursor ? { cursor } : {}) })
  if (epoch !== listGeneration) return page
  const rows = new Map((cursor ? sessionRows : []).map((row) => [row.sessionId, row]))
  for (const row of page.items) {
    if (row.title) sessionTitles.set(row.sessionId, row.title)
    rows.set(row.sessionId, {
      ...row,
      ...(sessionTitles.has(row.sessionId) ? { title: sessionTitles.get(row.sessionId) as string } : {}),
    })
  }
  if (current && !rows.has(current.id)) {
    const selected = await client.session.list({ q: { prefix: current.id }, limit: 100 })
    if (epoch !== listGeneration) return page
    const match = selected.items.find((row) => row.sessionId === current?.id)
    if (match) {
      if (match.title) sessionTitles.set(match.sessionId, match.title)
      rows.set(match.sessionId, match)
    }
  }
  sessionRows = [...rows.values()]
  sessionNext = page.next
  updateSidebar()
  const selectedRow = sessionRows.find((row) => row.sessionId === current?.id)
  if (selectedRow?.title || (selectedRow && !projection?.nodes.some((node) => node.kind === 'user')))
    topbarRuntime.setTaskTitle(selectedRow.title ?? '新任务')
  return page
}
async function open(
  id: string,
  options: {
    created?: Session
    preserveSending?: boolean
    workspace?: WorkspaceEntry
    initialModel?: KnownSessionModel
  } = {},
): Promise<void> {
  const epoch = ++selection
  if (!options.preserveSending) submissionGeneration++
  let selectionReady = false
  sessionPending = true
  draftingNew = false
  renderControls()
  const previous = current
  // 投影与转录区都保留到新投影就绪：加载期间旧画面继续显示（body.session-switching
  // 半透明提示，状态栏「正在准备会话」），不经历「清空 → 空白 → 填充」的闪屏，
  // 也避免 `body:has(#transcript:empty)` 把布局跳进空态模式。
  current = undefined
  clientModules.session.setSession(undefined)
  sessionYoloEnabled = false
  stopping = false
  if (!options.preserveSending) {
    sending = false
    awaitingPromptStart = false
  }
  knownSessionModel = undefined
  initialModelPending = options.initialModel
  selectedWorkspace = undefined
  modelChangePending = false
  renderControls()
  offPermission?.()
  offPermission = undefined
  liveApproval?.finish({ verdict: 'rejected' })
  liveApproval = undefined
  try {
    const stopped = await stopWithTimeout(stopEvents)
    stopEvents = undefined
    live = undefined
    if (!stopped) {
      notice.textContent = '旧会话仍在关闭，新会话已继续准备。'
      notice.dataset.kind = 'warning'
    }
    await previous?.detach()
    if (epoch !== selection) return
    const permission: Parameters<Session['onPermissionRequest']>[0] = (request, context) =>
      new Promise<PermissionOutcome>((resolve) => {
        const pending = {
          request,
          afterSeq: Math.max(projection?.upto ?? 0, receipts.get(id)?.endSeq ?? 0),
          finish: (answer: PermissionOutcome) => {
            context.signal.removeEventListener('abort', reject)
            if (liveApproval === pending) liveApproval = undefined
            render()
            resolve(context.signal.aborted ? { verdict: 'rejected' } : answer)
          },
        }
        const reject = () => pending.finish({ verdict: 'rejected' })
        if (context.signal.aborted || epoch !== selection || permissionMode === 'view') {
          resolve({ verdict: 'rejected' })
          return
        }
        liveApproval = pending
        context.signal.addEventListener('abort', reject, { once: true })
        render()
      })
    const binding = options.created
      ? bindWebSession(options.created, permission)
      : await loadWebSession((sessionId, options) => client.session.load(sessionId, options), id, permission)
    if (epoch !== selection) {
      binding.offPermission?.()
      return
    }
    const loaded = binding.session
    current = loaded
    clientModules.session.setSession(loaded.id)
    if (!options.created) permissionMode = 'workspace'
    const metadata = sessionRows.find((row) => row.sessionId === id) as
      | (PageSessionMeta['items'][number] & { cwd?: string })
      | undefined
    const workspacePath = metadata?.cwd ?? options.workspace?.path
    if (workspacePath)
      selectedWorkspace =
        workspaceRows.find((entry) => entry.path === workspacePath) ??
        (options.workspace?.path === workspacePath ? options.workspace : undefined)
    const url = new URL(location.href)
    url.searchParams.set('session', id)
    history.replaceState(null, '', `${url.pathname}${url.search}`)
    offPermission = binding.offPermission
    let opened = false
    const selected = () => current === loaded && epoch === selection
    const liveProjection = createLiveProjection(loaded, client, {
      timeline(value, window) {
        if (!selected()) return
        windowAtStart = window.startIndex === 0
        // A reopened window may reach further back; look for a parked approval again.
        if (window.reason === 'opening' && approvalSearch !== 'searching') approvalSearch = 'idle'
        if (!opened) {
          opened = true
          // 首投影就绪后才换代：清空转录区、写入新会话内容、同步审批卡与控件，
          // 都发生在同一次同步序列里，旧→新之间没有空白帧。
          renderer.reset()
          approvalSearch = 'idle'
          // Nothing replays the history any more, so the last loaded turn stands for it.
          const seeded = receiptFromTurns(value.turns)
          if (seeded) {
            receipts.set(loaded.id, seeded)
            if (seeded.reason === 'completed' && !sessionTitles.has(loaded.id)) titleRefresh.start(loaded.id)
          }
        }
        projection = value
        render()
      },
      stream(value) {
        if (!selected()) return
        projection = value
        // Streamed text only changes the transcript; everything else waits for the next patch.
        if (streamFrame !== undefined) return
        streamFrame = requestAnimationFrame(() => {
          streamFrame = undefined
          if (projection && selected())
            renderer.render(webView(projection).nodes, projection.turns, transcriptMeta())
        })
      },
      event(event) {
        if (selected()) void followEvent(loaded, event).catch(showError)
      },
      error(error) {
        if (selected()) showError(error)
      },
    })
    live = liveProjection
    stopEvents = () => liveProjection.stop()
    await liveProjection.start()
    if (epoch !== selection) return
    selectionReady = true
    sessionPending = false
    clearSessionRecovery()
    render()
    await list()
  } catch (error) {
    if (epoch !== selection) return
    if (!selectionReady) {
      const failed = current
      current = undefined
      clientModules.session.setSession(undefined)
      projection = undefined
      knownSessionModel = undefined
      modelChangePending = false
      offPermission?.()
      offPermission = undefined
      try {
        await stopWithTimeout(stopEvents)
      } catch {
        // The original loading failure is the useful error for this selection.
      }
      stopEvents = undefined
      live = undefined
      try {
        await failed?.detach()
      } catch {
        // The failed binding is already unavailable to the composer.
      }
      // 加载失败没有可保留的画面：清空转录区回到空态，错误走 #notice。
      renderer.reset()
      if (options.preserveSending) {
        draftingNew = true
        selectedWorkspace = options.workspace
        knownSessionModel = options.initialModel
        initialModelPending = undefined
      }
      sessionPending = false
      render()
      if (!options.created && !options.preserveSending) {
        showSessionRecovery(error, id)
        return
      }
    }
    throw error
  }
}
async function forkSidebar(id: string, title: string): Promise<void> {
  const epoch = selection
  const row = sessionRows.find((item) => item.sessionId === id)
  const source = await client.session.load(id, row?.cwd ? { cwd: row.cwd } : {})
  const timeline = await source.projectUI(undefined, { surface: 'web' })
  if (timeline.opState !== null) throw new Error('请等待会话运行结束后再分叉。')
  const turn = timeline.turns.findLast((item) => item.forkable && item.endSeq !== undefined)
  if (turn?.endSeq === undefined) throw new Error('此会话还没有可分叉的已完成回合。')
  const child = await client.session.fork(id, turn.endSeq)
  let namingError: unknown
  try {
    await client.session.rename(child.id, forkTitle(title))
  } catch (error) {
    namingError = error
  }
  let refreshError: unknown
  try {
    await list()
  } catch (error) {
    refreshError = error
  }
  try {
    if (epoch === selection) await open(child.id, { created: child })
  } catch (error) {
    refreshError = error
  }
  if (refreshError) throw new Error(`新会话已创建，但页面刷新失败。请刷新页面查找会话：${child.id}`)
  if (namingError) throw new Error('新会话已创建，但名称保存失败；请在新会话菜单中重命名。')
}
async function forkTurn(turn: UITurn): Promise<void> {
  const parent = current
  if (!parent || !turn.forkable || turn.endSeq === undefined || projection?.opState !== null)
    throw new Error('只有已完成且当前空闲的回合可以分支。')
  const forked = await client.session.fork(parent.id, turn.endSeq)
  await open(forked.id, { created: forked })
  notice.textContent = '已从所选回合创建新聊天。原聊天保持不变。'
  notice.dataset.kind = ''
  composerRuntime.focus()
}
function renderNewSessionControls(): void {
  newSessionCreate.disabled =
    !connected || sessionPending || newSessionCreating || workspacePickerBusy || !newSessionCwd.value.trim()
  setButtonLabel(newSessionCreate, newSessionCreating ? '正在验证…' : '使用此工作区')
  workspacePick.disabled =
    !connected || sessionPending || newSessionCreating || workspacePickerBusy || !workspacePickerReady
  workspacePick.hidden = workspacePickerReady === false
  setButtonLabel(workspacePick, workspacePickerBusy ? '正在打开…' : '选择文件夹…')
  workspacePickerState.textContent = workspacePickerBusy
    ? '请在系统窗口中选择工作区。'
    : workspacePickerReady === undefined
      ? '正在检查系统目录选择器…'
      : workspacePickerReady
        ? '从这台机器选择一个目录。'
        : '当前环境无法打开目录选择器，请手动输入路径。'
  if (workspacePickerReady === false) workspaceManual.open = true
  newSessionCwd.disabled = workspacePickerBusy
  newSessionCancel.disabled = newSessionCreating || workspacePickerBusy
  for (const control of newSessionDialog.querySelectorAll<HTMLButtonElement>('[data-new-session-cancel]'))
    control.disabled = newSessionCreating || workspacePickerBusy
}
function openNewSessionDialog(): void {
  if (!connected || sessionPending || newSessionCreating) return
  if (!newSessionDialog.open) {
    try {
      newSessionDialog.showModal()
    } catch {
      newSessionDialog.setAttribute('open', '')
    }
  }
  if (workspacePickerReady) workspacePick.focus()
  else newSessionCwd.focus()
}
function closeNewSessionDialog(): void {
  if (!newSessionDialog.open) return
  try {
    newSessionDialog.close()
  } catch {
    newSessionDialog.removeAttribute('open')
  }
}
function updateWorkspaceOptions(): void {
  renderWorkspaceOptions(element('workspace-option-items', 'div'), workspaceRows, (workspace) => {
    selectedWorkspace = workspace
    closeNewSessionDialog()
    renderControls()
    composerRuntime.focus()
  })
}
async function registerWorkspace(cwd: string): Promise<void> {
  if (!connected || sessionPending || newSessionCreating) return
  if (!cwd) return
  newSessionCreating = true
  renderControls()
  try {
    const result = await client.workspace.add(cwd)
    selectedWorkspace = result.workspace
    workspaceRows = [result.workspace, ...workspaceRows.filter((row) => row.path !== result.workspace.path)]
    updateWorkspaceOptions()
    await list()
    closeNewSessionDialog()
    composerRuntime.focus()
  } catch (error) {
    const failure = new Error(workspaceErrorNotice(error), { cause: error })
    element('new-session-error', 'p').textContent = failure.message
    throw failure
  } finally {
    newSessionCreating = false
    renderControls()
  }
}
async function chooseWorkspace(): Promise<void> {
  await registerWorkspace(newSessionCwd.value.trim())
}
async function pickWorkspace(): Promise<void> {
  if (!workspacePickerReady || workspacePickerBusy || newSessionCreating) return
  workspacePickerBusy = true
  renderNewSessionControls()
  try {
    const result = await requestWorkspacePicker().catch(() => undefined)
    if (!result) {
      workspacePickerReady = false
      workspaceManual.open = true
      element('new-session-error', 'p').textContent = '无法打开系统目录选择器，请手动输入工作区路径。'
      return
    }
    if (result.status === 'cancelled') return
    if (result.status === 'unavailable') {
      workspacePickerReady = false
      workspaceManual.open = true
      return
    }
    newSessionCwd.value = result.path
    await registerWorkspace(result.path)
  } finally {
    workspacePickerBusy = false
    renderNewSessionControls()
  }
}
async function beginNewDraft(showWorkspacePicker = true): Promise<void> {
  if (sessionPending || sending) return
  clearSessionRecovery()
  const epoch = ++selection
  const previous = current
  if (previous && knownSessionModel) rememberWebComposer({ model: knownSessionModel })
  const inherited = selectionFromMemory(runtimeModels, accountProvider)
  const stop = stopEvents
  current = undefined
  clientModules.session.setSession(undefined)
  projection = undefined
  draftingNew = true
  pendingSessionKey = crypto.randomUUID()
  knownSessionModel = inherited.model
  permissionMode = inherited.permission
  initialModelPending = undefined
  submissionGeneration++
  offPermission?.()
  offPermission = undefined
  liveApproval?.finish({ verdict: 'rejected' })
  liveApproval = undefined
  stopEvents = undefined
  live = undefined
  renderer.reset()
  const url = new URL(location.href)
  url.searchParams.delete('session')
  history.replaceState(null, '', `${url.pathname}${url.search}`)
  topbarRuntime.setTaskTitle('新会话')
  render()
  if (!selectedWorkspace?.available && showWorkspacePicker) openNewSessionDialog()
  else composerRuntime.focus()
  sessionPending = true
  renderControls()
  let cleanupError: unknown
  try {
    const stopped = await stopWithTimeout(stop)
    if (!stopped) {
      notice.textContent = '旧会话仍在关闭，新会话已继续准备。'
      notice.dataset.kind = 'warning'
    }
  } catch (error) {
    cleanupError = error
  }
  try {
    await previous?.detach()
  } catch (error) {
    cleanupError ??= error
  } finally {
    if (selection === epoch) {
      sessionPending = false
      render()
    }
  }
  if (cleanupError) throw cleanupError
}
async function refreshWorkspaces(): Promise<void> {
  const page = await client.workspace.list()
  workspaceRows = page.items
  if (selectedWorkspace) selectedWorkspace = workspaceRows.find((row) => row.path === selectedWorkspace?.path)
  updateWorkspaceOptions()
}
async function refreshWorkspacePicker(): Promise<void> {
  workspacePickerReady = await workspacePickerAvailable()
  renderNewSessionControls()
}
let modelReadGeneration = 0
let modelAppliedGeneration = 0
function selectedModelAvailable(): boolean {
  const selected = knownSessionModel
  return (
    !selected || runtimeModels.some((model) => model.route === selected.route && model.id === selected.id)
  )
}
async function refreshModels(): Promise<ModelPickerOption[]> {
  const generation = ++modelReadGeneration
  const apis = await client.apis()
  const models = (apis.profile.models ?? []).map(({ route, id }) => ({
    route,
    id,
    ...(accountLabels.has(route) ? { label: accountLabels.get(route) as string } : {}),
  }))
  if (generation > modelAppliedGeneration) {
    modelAppliedGeneration = generation
    runtimeModels = models
    configured = runtimeModels.length > 0
    if (draftingNew && !modelChangePending && !permissionChangePending) {
      const next = selectionFromMemory(runtimeModels, accountProvider)
      knownSessionModel = next.model
      permissionMode = next.permission
    }
    renderControls()
  }
  return models
}
async function selectPermission(mode: PermissionMode): Promise<boolean> {
  if (sessionPending || permissionChangePending) return false
  if (!current && draftingNew) {
    permissionMode = mode
    rememberWebComposer({ permission: mode })
    notice.textContent = `新会话将使用「${permissionLabel(mode)}」。`
    notice.dataset.kind = ''
    renderControls()
    return true
  }
  if (!current) return false
  const session = current
  const epoch = selection
  const requestedYolo = yoloEnabled(mode)
  permissionChangePending = true
  renderControls()
  try {
    if (requestedYolo !== sessionYoloEnabled) await session.setYolo(requestedYolo)
    if (current !== session || selection !== epoch || sessionPending) return false
    sessionYoloEnabled = requestedYolo
    permissionMode = mode
    rememberWebComposer({ permission: mode })
    notice.textContent =
      mode === 'full' ? '本会话已跳过其余审批。' : `本会话权限已设为「${permissionLabel(mode)}」。`
    notice.dataset.kind = ''
    return true
  } catch (error) {
    if (current === session && selection === epoch && !sessionPending) showError(error)
    return false
  } finally {
    if (current === session && selection === epoch && !sessionPending) {
      permissionChangePending = false
      renderControls()
    }
  }
}
async function selectModel(option: ModelPickerOption): Promise<boolean> {
  const session = current
  if (sessionPending || modelChangePending) return false
  if (!session && draftingNew) {
    knownSessionModel = { route: option.route, id: option.id }
    rememberWebComposer({ model: knownSessionModel })
    notice.textContent = '新会话将使用所选模型。'
    notice.dataset.kind = ''
    renderControls()
    return true
  }
  if (!session) return false
  const epoch = selection
  modelChangePending = true
  renderControls()
  try {
    await session.setModel({ slot: 'primary', route: option.route, model: option.id })
    if (current !== session || selection !== epoch || sessionPending) return false
    knownSessionModel = { route: option.route, id: option.id }
    rememberWebComposer({ model: knownSessionModel })
    initialModelPending = undefined
    notice.textContent = '模型已更新，后续请求将使用所选模型。'
    notice.dataset.kind = ''
    live?.refresh()
    return true
  } catch (error) {
    if (current === session && selection === epoch && !sessionPending) showError(error)
    return false
  } finally {
    if (current === session && selection === epoch && !sessionPending) {
      modelChangePending = false
      renderControls()
    }
  }
}
async function savedConfiguration(saved: ConfigSnapshot): Promise<void> {
  notice.dataset.kind = ''
  accountProvider = saved.provider
  accountLabels = new Map(
    (saved.accounts ?? []).map((row) => [row.route, `${row.label} · ${row.providerId}`]),
  )
  const savedModels = await refreshModels()
  const published = savedModels.some(
    (entry) =>
      entry.route === (saved.provider?.route ?? saved.provider?.id) && entry.id === saved.provider?.model,
  )
  if (!saved.configured && !savedModels.length) {
    notice.textContent = '尚无启用的模型账户。请在设置中添加或启用账户。'
    return
  }
  if (saved.effect === 'restart-required' || !published) {
    notice.textContent = '配置已保存，但尚未生效；当前继续使用已生效的模型。请在设置中重试保存。'
    return
  }
  notice.textContent = '模型配置已更新。新会话沿用上次使用的模型；尚未选过时使用新的默认模型。'
}
newSessionForm.addEventListener('submit', (event) => {
  event.preventDefault()
  run(chooseWorkspace)
})
newSessionCwd.addEventListener('input', renderNewSessionControls)
workspacePick.addEventListener('click', () => run(pickWorkspace))
bindDismissibleDialog({
  dialog: newSessionDialog,
  cancel: newSessionCancel,
  additional: newSessionDialog.querySelectorAll('[data-new-session-cancel]'),
  canClose: () => !newSessionCreating && !workspacePickerBusy,
  close: closeNewSessionDialog,
  restoreFocus: () => clientModules.sidebar?.focusNew(),
})
addEventListener('focus', () => {
  if (connected)
    run(async () => {
      await list()
      if (!element('archived-settings-pane', 'section').hidden) await sessionActions.loadArchived()
    })
})
const appearance = bindAppearance({
  scope: document,
  root: document.documentElement,
  storage: safeThemeStorage(window),
})
/**
 * 皮肤选择。清单来自 `config.get()` 报出的 profile——daemon 只接受它自己那一个 profile，
 * 所以这里必须把 profile 传回去，客户端不能凭参数选目录。
 * （profileName 的声明在上方状态区：客户端模块名册源在 config.get() 之前就引用它。）
 */
/** 最近一次拉到的清单，供选中时取样式表与 token；清单变了会整体替换。 */
let skinRoster: SkinRosterEntry[] = []
const appearanceStorage = safeThemeStorage(window)
/** 回落到 `cssUrl` 时的同源取数器；只接受 `/skins/` 下的路径（见 `fetchSkinCss`）。 */
const skinCssOptions = { fetcher: (input: string) => fetch(input), origin: location.origin }
/** 每次显式选择 +1：让在途的对账不能把用户刚做的选择覆盖回去。 */
let skinSelection = 0

/** 告诉首帧逻辑（以及同源的其他文档）缓存里的皮肤变了。同文档不会收到 storage 事件，故手动派发。 */
function skinChanged(): void {
  window.dispatchEvent(new StorageEvent('storage', { key: SKIN_STORAGE_KEY }))
}

/**
 * 拿到新清单后把缓存拉回一致。
 *
 * 来源被卸载/停用的皮肤必须**停止上色**（设计 §8）；清单只是摘要变化、文本没变时直接换缓存，
 * 不留闪烁。只有必须联网取文本时才先回落内置观感——那是设计明确接受的那一次闪烁（§5.8）。
 */
async function reconcileSkin(entries: readonly SkinRosterEntry[]): Promise<void> {
  const plan = planSkinReconcile(readSkinCache(appearanceStorage), entries)
  if (plan.kind === 'keep') return
  const version = skinSelection
  if (plan.kind === 'clear') {
    clearSkinCache(appearanceStorage)
    skinChanged()
    return
  }
  if (plan.entry.css !== undefined) {
    await cacheSkinEntry(appearanceStorage, plan.entry, skinCssOptions)
    skinChanged()
    return
  }
  clearSkinCache(appearanceStorage)
  skinChanged()
  try {
    const css = await fetchSkinCss(plan.entry.cssUrl, skinCssOptions)
    // 取文本期间用户可能已经换了选择：那就让对账作废，不能把旧皮肤写回去。
    if (version !== skinSelection) return
    await cacheSkinEntry(appearanceStorage, { ...plan.entry, css }, skinCssOptions)
    skinChanged()
  } catch {
    // 取不到就保持内置观感，而不是写一份半截缓存。
  }
}

const skinGroup = bindSkinGroup({
  scope: document,
  storage: appearanceStorage,
  list: async () => {
    if (profileName === '') return []
    const roster = await client.skins.list(profileName)
    skinRoster = roster.skins.map((skin) => ({
      id: skin.id,
      name: skin.name,
      packageName: skin.packageName,
      revision: roster.revision,
      cssUrl: skin.cssUrl,
      ...(skin.css === undefined ? {} : { css: skin.css }),
      tokens: skin.tokens ?? {},
    }))
    // 只有真的拿到清单才能对账：这里的 `[]` 会被读成「皮肤全被卸载」而抹掉用户的选择。
    await reconcileSkin(skinRoster)
    return skinRoster
  },
  select: async (id) => {
    // 先记一次选择：取样式表要 await，在途的对账不能在这个窗口里把旧皮肤写回来。
    skinSelection += 1
    if (id === null) clearSkinCache(appearanceStorage)
    else {
      const chosen = skinRoster.find((skin) => skin.id === id)
      // 清单里找不到就是清单刚变过：抛出，让分组回滚到原选择而不是留下假的选中态。
      if (chosen === undefined) throw new Error(`skin ${id} is not in the current roster`)
      // 宿主没内联时先取到文本再写缓存，否则会缓存成一份空样式表——点了等于没点（设计 §8）。
      await cacheSkinEntry(appearanceStorage, chosen, skinCssOptions)
    }
    skinChanged()
  },
})
window.addEventListener('agnes:packages-changed', () => void skinGroup.refresh())
window.addEventListener('focus', () => void skinGroup.refresh())

type AdminPaneName = 'plugin' | 'resources'
type ResourceTab = 'skills' | 'mcp'
type MountedAdminPane = Readonly<{
  reload(): Promise<void>
  ready?: Promise<void>
  sync?(scope: { tab: ResourceTab; workspaceId?: string }, options?: { refresh?: boolean }): Promise<void>
  setWorkspace?(workspaceId?: string): Promise<void>
  setTab?(tab: ResourceTab): void
}>

const mountedAdminPanes = new Map<AdminPaneName, MountedAdminPane>()
const pendingAdminPanes = createPendingCoordinator<AdminPaneName>()
let resourcePaneRequest = 0

/** The workbench's current workspace, only when it is a canonical 64-hex directory id. */
function paneWorkspaceId(): string | undefined {
  const id = selectedWorkspace?.workspaceId
  return id && /^[a-f0-9]{64}$/.test(id) ? id : undefined
}

/** Opens one admin pane: re-authenticates, mounts on first open, reloads afterwards. */
async function openAdminPane(pane: AdminPaneName, tab: ResourceTab = 'skills'): Promise<void> {
  const request = pane === 'resources' ? ++resourcePaneRequest : undefined
  const isCurrentRequest = () => pane !== 'resources' || request === resourcePaneRequest
  const paneNotice = element(pane === 'plugin' ? 'admin-notice' : 'resource-notice', 'p')
  const entry = button(pane === 'plugin' ? 'plugin-management' : tab === 'skills' ? 'skills-tab' : 'mcp-tab')
  const resourceList = pane === 'resources' ? element('resource-list', 'section') : undefined
  const resourceToolbar = resourceList
    ?.closest('.admin-pane-body')
    ?.querySelector<HTMLElement>('.resource-toolbar')
  const controls = pane === 'resources' ? [button('skills-tab'), button('mcp-tab')] : [entry]
  const selectResourceTab = () => {
    if (pane !== 'resources') return
    for (const control of controls) {
      const selected = control.id === `${tab}-tab`
      control.setAttribute('aria-selected', String(selected))
      control.tabIndex = selected ? 0 : -1
    }
  }
  let resourceReady = false
  // Resource tabs stay available so a later choice can supersede an in-flight load.
  entry.disabled = pane === 'plugin'
  entry.setAttribute('aria-busy', 'true')
  if (resourceList) resourceList.hidden = true
  if (resourceToolbar) resourceToolbar.hidden = true
  selectResourceTab()
  settingsRegion.open(pane)
  try {
    if (pane === 'resources' && pendingAdminPanes.has(pane)) {
      // Join the existing mount before applying the latest tab; never mount the same pane twice.
      await pendingAdminPanes.run(pane, () => {}).catch(() => undefined)
      if (!isCurrentRequest() || settingsRegion.pane(pane)?.hidden !== false) return
    }
    await pendingAdminPanes.run(pane, async () => {
      if (!isCurrentRequest()) return
      paneNotice.textContent = ''
      paneNotice.dataset.kind = ''
      const mounted = mountedAdminPanes.get(pane)
      if (mounted) {
        if (pane === 'resources' && mounted.sync) {
          const scope: { tab: ResourceTab; workspaceId?: string } = { tab }
          const workspaceId = paneWorkspaceId()
          if (workspaceId) scope.workspaceId = workspaceId
          await mounted.sync(scope, { refresh: true })
          resourceReady = true
        } else await mounted.reload()
        return
      }
      if (pane === 'plugin') {
        const { mountPluginAdmin } = await import('./admin/plugins/admin.js')
        mountedAdminPanes.set(pane, {
          ...mountPluginAdmin({
            actualSlots: clientModules.actualSlots,
            runtime: clientModules.reconciler,
          }),
        })
      } else {
        const { mountResourceAdmin } = await import('@agnes/resource-control-web/admin')
        const workspaceId = paneWorkspaceId()
        const mountedResource = mountResourceAdmin({
          ...(workspaceId ? { workspaceId } : {}),
          tab,
          embedded: true,
        })
        mountedAdminPanes.set(pane, mountedResource)
        await mountedResource.ready
        resourceReady = true
      }
    })
  } catch (error) {
    if (!isCurrentRequest()) return
    const message = error instanceof Error ? error.message : '打开管理面板失败，请重试。'
    paneNotice.textContent = errorNotice(message)
    paneNotice.dataset.kind = 'error'
    resourceList?.replaceChildren()
  } finally {
    if (isCurrentRequest()) {
      for (const control of controls) {
        control.disabled = false
        control.removeAttribute('aria-busy')
      }
      selectResourceTab()
      if (resourceList) resourceList.hidden = !resourceReady
      if (resourceToolbar) resourceToolbar.hidden = !resourceReady
      // Loading an old pane must not navigate back after the user has selected another category.
      if (settingsRegion.pane(pane)?.hidden === false) settingsRegion.open(pane)
    }
  }
}

const computerUseStatus = createComputerUseStatusController(client)
addEventListener('pagehide', () => computerUseStatus.dispose(), { once: true })
function handleComposerWorkspace(): void {
  run(async () => {
    if (!draftingNew) await beginNewDraft()
    openNewSessionDialog()
  })
}
function handleComposerCancel(): void {
  run(async () => {
    const session = current
    if (!session || sessionPending || stopping || !projection?.opState) return
    const epoch = selection
    stopping = true
    stopAfterSeq = projection.upto
    render()
    try {
      await session.cancel()
    } catch (error) {
      if (current !== session || selection !== epoch || sessionPending) return
      stopping = false
      render()
      throw error
    }
  })
}
function handleComposerDraftChange(value: string): void {
  sessionStorage.setItem(composerDraftKey, value)
  composerRuntime.resize()
  renderControls()
}
function submitComposer(): void {
  const input = composerRuntime.getDraft().trim()
  let session = current
  if (
    !input ||
    !configured ||
    !selectedModelAvailable() ||
    (!session && (!draftingNew || !selectedWorkspace?.available)) ||
    !canSubmitComposer({ connected, hasSession: true, sending, stopping, loading: sessionPending })
  )
    return
  notice.textContent = ''
  notice.dataset.kind = ''
  const submission = ++submissionGeneration
  let ownedSelection = selection
  const busy = projection?.opState !== null && projection?.opState !== undefined
  sending = true
  awaitingPromptStart = !busy
  composerRuntime.setDraft('')
  sessionStorage.removeItem(composerDraftKey)
  composerRuntime.resize()
  renderer.pinToBottom()
  renderControls()
  // A prompt can remain pending for the entire run. Controls follow daemon state, not this promise.
  const work = (async () => {
    if (!session) {
      const key = pendingSessionKey ?? crypto.randomUUID()
      const draftModel = knownSessionModel
      const workspace = selectedWorkspace
      pendingSessionKey = key
      const created = await client.session.new({ cwd: workspace?.path ?? '', sessionKey: key })
      try {
        await open(created.id, {
          created,
          preserveSending: true,
          ...(workspace ? { workspace } : {}),
          ...(draftModel ? { initialModel: draftModel } : {}),
        })
      } finally {
        ownedSelection = selection
      }
      if (current !== created) throw new Error('会话选择已改变。')
      session = current
    }
    if (!session) throw new Error('会话创建失败。')
    if (initialModelPending) {
      const selectedModel = initialModelPending
      await session.setModel({ slot: 'primary', route: selectedModel.route, model: selectedModel.id })
      if (current !== session || selection !== ownedSelection) throw new Error('会话选择已改变。')
      knownSessionModel = selectedModel
      initialModelPending = undefined
      renderControls()
    }
    if (yoloEnabled(permissionMode) && !sessionYoloEnabled) {
      await session.setYolo(true)
      if (current !== session || selection !== ownedSelection) throw new Error('会话选择已改变。')
      sessionYoloEnabled = true
    }
    const result = await (busy ? session.followUp(input) : session.prompt(input))
    const submittedId = session.id
    if (typeof result === 'object' && result.reason === 'completed' && !sessionTitles.has(submittedId))
      titleRefresh.start(submittedId)
    pendingSessionKey = undefined
  })()
  void work
    .catch((error: unknown) => {
      if (submission === submissionGeneration && ownedSelection === selection) {
        if (!composerRuntime.getDraft()) {
          composerRuntime.setDraft(input)
          sessionStorage.setItem(composerDraftKey, input)
          composerRuntime.resize()
        }
        showError(error)
      }
    })
    .finally(() => {
      if (submission === submissionGeneration && ownedSelection === selection) {
        sending = false
        awaitingPromptStart = false
        renderControls()
        live?.refresh()
      }
    })
}
topbarRuntime.onDisconnect(() =>
  run(async () => {
    intentionalClose = true
    reconnect.cancel()
    await client.close()
  }),
)
const diagnostics = createDiagnosticsDialog({
  call: (method, params) => client.call(method, params),
  context: () => ({
    sessionId: current?.id ?? null,
    sessionTitle: sessionTitles.get(current?.id ?? '') ?? null,
    projection,
  }),
})
const reportProblem = button('report-problem')
reportProblem.addEventListener('click', () => diagnostics.open(reportProblem))
client.on('reconnecting', () => setConnection('reconnecting'))
client.on('reconnected', () => {
  reconnect.reset()
  setConnection('connected')
  run(async () => {
    // The live projection reopens the session on its own once the connection is back.
    await refreshModelConfiguration()
    await list()
    scheduleClientRosterRead()
  })
})
client.on('closed', () => {
  titleRefresh.close()
  setConnection('closed')
  const message = '连接已关闭；任务是否结束请以后台状态为准。重新运行 Web 启动命令并打开其地址即可恢复查看。'
  if (sessionRecovery) renderSessionRecovery(message)
  else {
    notice.textContent = intentionalClose ? message : `${message} 页面将有限次尝试恢复。`
    notice.dataset.kind = 'error'
  }
  if (!intentionalClose) reconnect.start()
})
/** Gap and generation notices name their session; another session's are not this view's concern. */
const forCurrent = (payload: unknown): boolean =>
  current !== undefined && (payload as { sessionId?: unknown } | undefined)?.sessionId === current.id
client.on('gap', (payload) => {
  if (!forCurrent(payload)) return
  const message = '部分历史事件已不可回放，正在读取后台现有投影。'
  if (sessionRecovery) renderSessionRecovery(message)
  else notice.textContent = message
  void live?.resync().catch(showError)
})
client.on('generationChanged', (payload) => {
  if (!forCurrent(payload)) return
  void live?.resync().catch(showError)
})
// 名册失效推送（WC10）：packages_changed 只是失效提示，收到后必须重读名册。
client.on('notice', (payload) => {
  const incoming = payload as { kind?: unknown; detail?: unknown }
  if (incoming.kind !== 'packages_changed' && incoming.kind !== 'tree_changed') return
  const detail =
    typeof incoming.detail === 'object' && incoming.detail !== null
      ? (incoming.detail as { profile?: unknown })
      : undefined
  if (profileName && detail?.profile === profileName) scheduleClientRosterRead()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void list().catch(showError)
    void refreshModelConfiguration().catch(showError)
    scheduleClientRosterRead()
  }
})
for (const [index, tab] of [button('view-chat'), button('view-trace')].entries()) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : event.key === 'ArrowLeft' ? 0 : 1
    const target = next === 0 ? button('view-chat') : button('view-trace')
    target.focus()
    tracePanel.setOpen(next === 1)
  })
  tab.setAttribute('aria-posinset', String(index + 1))
  tab.setAttribute('aria-setsize', '2')
}
addEventListener('popstate', () => {
  const id = new URL(location.href).searchParams.get('session')
  run(async () => {
    if (id) {
      if (current?.id !== id) await open(id)
      return
    }
    if (current || !draftingNew) await beginNewDraft()
  })
})
async function refreshModelConfiguration(): Promise<void> {
  const snapshot = await client.config.get()
  accountProvider = snapshot.provider
  accountLabels = new Map(
    (snapshot.accounts ?? []).map((row) => [row.route, `${row.label} · ${row.providerId}`]),
  )
  await refreshModels()
}
let modelRefreshPending = false
const modelRefreshTimer = setInterval(() => {
  if (!connected || document.visibilityState !== 'visible' || modelRefreshPending) return
  modelRefreshPending = true
  void refreshModelConfiguration()
    .catch(() => undefined)
    .finally(() => {
      modelRefreshPending = false
    })
}, 2000)
window.addEventListener('pagehide', () => {
  clearInterval(modelRefreshTimer)
  intentionalClose = true
  reconnect.cancel()
  titleRefresh.close()
  void (stopEvents?.() ?? Promise.resolve()).finally(() => client.close())
})

composerRuntime.resize()

run(async () => {
  setConnection('connecting')
  if (!wsUrl) throw new Error('WebSocket 连接地址不可用。')
  await client.initialize()
  setConnection('connected')
  reconnect.reset()
  void refreshWorkspacePicker()
  const snapshot = await client.config.get()
  accountProvider = snapshot.provider
  profileName = snapshot.profile
  void skinGroup.refresh()
  // profile 就绪后做首次真实名册对账（此前名册源按空处理）。
  scheduleClientRosterRead(true)
  accountLabels = new Map(
    (snapshot.accounts ?? []).map((row) => [row.route, `${row.label} · ${row.providerId}`]),
  )
  await refreshModels()
  if (!configured) {
    renderControls()
    notice.textContent = '先配置模型，即可开始第一个任务。'
    await settings.open()
  }
  try {
    await refreshWorkspaces()
  } catch (error) {
    showError(new Error('无法读取工作区列表，请稍后重试或直接添加工作目录。', { cause: error }))
  }
  const page = await list()
  const selected = new URL(location.href).searchParams.get('session')
  if (selected) {
    const candidates = page.items.some((item) => item.sessionId === selected)
      ? page
      : await client.session.list({ q: { prefix: selected }, limit: 100 })
    if (candidates.items.some((item) => item.sessionId === selected)) await open(selected)
    else {
      notice.textContent = '当前后台中找不到这个任务。请从侧栏选择，或新建任务。'
      renderControls()
    }
  } else {
    const first = page.items.find((item) => !item.archived)
    if (first) await open(first.sessionId)
    else await beginNewDraft(configured)
  }
})
