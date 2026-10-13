import { defaultLoop, defaultModelAdapter } from '@agnes/protocol'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import { adaptResourceAdmin } from '@agnes/web-admin/admin/resources/admin'
import { createFirstRunController, needsFirstRun } from '@agnes/web-admin/first-run'
import { factChainLinks, workbenchNavigation } from '@agnes/web-client'
import { bindDialogSheets, createCatalogTranslator } from '@agnes/web-ui'
import { settingsRoute, sortSessionsByRecency } from '@agnes/web-units'
import { createAppearanceController } from './app/appearance-controller.js'
import { createCommandController } from './app/command-controller.js'
import { createComposerController } from './app/composer-controller.js'
import { bindConnectionEvents } from './app/connection-events.js'
import {
  onBroadcast,
  onHistoryNavigation,
  onPageHide,
  onPageVisible,
  onSurfaceEvent,
  onWindowFocus,
  pageVisible,
} from './app/global-events.js'
import { createReadOnlyController } from './app/read-only-controller.js'
import { createSessionController } from './app/session-controller.js'
import { createSubmissionController } from './app/submission-controller.js'
import { createTurnController } from './app/turn-controller.js'
import { mountIntelligentUi } from './intelligent-ui/mount.js'
import '@agnes/web-admin/settings/registry'
import type {
  ComputerUseStatusResult,
  ConfigSnapshot,
  ContentBlock,
  ModelSettings,
  PageSessionMeta,
  ReferenceSelection,
  UITimeline,
  UITurn,
  WorkspaceEntry,
} from '@agnes/protocol'
import {
  createClient,
  type LedgerEvent,
  memoryJournal,
  type PermissionOutcome,
  type PermissionRequest,
  type Session,
} from '@agnes/sdk/browser'

import { type PermissionMode, permissionLabel, yoloEnabled } from '@agnes/web-admin/permission-picker'
import { createSettingsController } from '@agnes/web-admin/settings'
import { loadRuntimeCatalog } from '@agnes/web-admin/settings/api'
import { bindJobsSessions } from '@agnes/web-admin/settings/jobs-api'
import { settingsCatalog } from '@agnes/web-admin/settings/locales'
import { effectiveSessionPreset, permissionForSessionPreset } from '@agnes/web-admin/settings/session-choice'
import { mountStatusCheck } from '@agnes/web-admin/settings/status-check'
import { homeEntries, homeNavigation, settingsSections } from '@agnes/web-client'

import { createComputerUsePaneController } from '@agnes/web-conversation/computer-use-pane'

import type { LiveProjection } from '@agnes/web-conversation/live-projection'

import {
  errorNotice,
  type KnownSessionModel,
  type Translate,
  workspaceErrorNotice,
} from '@agnes/web-conversation/presentation'
import { workbenchLocaleCatalog } from '@agnes/web-conversation/workbench'
import { installBrowserLogCapture } from '@agnes/web-foundation/browser-log'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { createAdminPaneController } from './admin-pane-coordinator.js'
import { appNotice, setConnectionNotice, setReconnectNotice } from './app-notices.js'
import { mountAppShell } from './app-shell.js'
import { archivedSessions } from './archived-sessions.js'
import { type ClaimResolver, startClientModules } from './client-modules/boot.js'
import { startPluginHotReload } from './client-modules/hot-reload.js'
import type { RosterSource } from './client-modules/reconcile.js'
import { rememberWebComposer, selectionFromMemory } from './composer-memory.js'
import { composerReferences } from './composer-references.js'
import { createDiagnosticsDialog } from './diagnostics-dialog.js'
import {
  type LoopSelection,
  loadNewSessionCatalog,
  loopIdentity,
  type NewSessionCatalog,
} from './loop-picker.js'
import type { ModelPickerOption } from './model-picker.js'
import { mountNewSessionDialog } from './new-session-dialog.js'
import { registerBuiltinHomeEntries } from './pages/entries.js'
import { activeHomeEntry, bindHomeRouting, mountHomePages } from './pages/host.js'
import { bootstrapProbe, createReconnectController, type ReconnectPhase } from './reconnect.js'
import { createRefreshCoordinator } from './refresh-coordinator.js'
import { createSettingsAdminPaneStore } from './region-slots.js'
import { SESSION_SEARCH_EVENT } from './regions/session-tools.js'
import { sessionViewCommands } from './regions/session-views.js'
import { createSessionActions } from './session-actions.js'
import { mountSessionSearch } from './session-search.js'
import { createTitleRefresh } from './session-title.js'
import {
  movedSettingsTarget,
  openMovedSettings,
  openMovedSettingsLink,
  rewriteMovedSettingsLink,
} from './settings-redirects.js'
import type { RunReceipt, WebView } from './view.js'
import { unmountWorkbench } from './workbench/dock.js'

import { requestWorkspacePicker, workspacePickerAvailable } from './workspace-picker.js'

installBrowserLogCapture()
const { hosts, config: shellConfig, dispose: unmountAppShell } = mountAppShell()

const unbindDialogSheets = bindDialogSheets(document)
// An old link to a page that left settings opens that page's new home.
rewriteMovedSettingsLink()

/** Live bindings keep selection guards and asynchronous cleanup on the app's shared state. */
export interface AppSessionContext {
  SESSION_WATCH_STOP_TIMEOUT_MS: typeof SESSION_WATCH_STOP_TIMEOUT_MS
  TRACE_THROTTLE_MS: typeof TRACE_THROTTLE_MS
  approvalBusy: typeof approvalBusy
  approvalRuntime: typeof approvalRuntime
  approvalSearch: typeof approvalSearch
  approvalSearchTicket: typeof approvalSearchTicket
  attachmentSessionOpening: typeof attachmentSessionOpening
  awaitingPromptStart: typeof awaitingPromptStart
  beginNewDraft: typeof beginNewDraft
  clearSessionRecovery: typeof clearSessionRecovery
  client: typeof client
  clientModules: typeof clientModules
  composerDraftKey: typeof composerDraftKey
  composerRuntime: typeof composerRuntime
  configured: typeof configured
  connected: typeof connected
  controlPending: typeof controlPending
  controlsHistory: typeof controlsHistory
  controlsRefresh: typeof controlsRefresh
  conversationRuntime: typeof conversationRuntime
  current: typeof current
  dockControlsHost: typeof dockControlsHost
  draftBundles: typeof draftBundles
  draftLoop: typeof draftLoop
  draftLoopAvailable: typeof draftLoopAvailable
  draftLoopEdited: typeof draftLoopEdited
  draftPreset: typeof draftPreset
  draftingNew: typeof draftingNew
  goalHost: typeof goalHost
  initialModelPending: typeof initialModelPending
  initialPermissionPending: typeof initialPermissionPending
  intentionalClose: typeof intentionalClose
  knownSessionModel: typeof knownSessionModel
  list: typeof list
  live: typeof live
  liveApproval: typeof liveApproval
  loopCatalogError: typeof loopCatalogError
  loopCatalogPending: typeof loopCatalogPending
  modelChangePending: typeof modelChangePending
  modelDefaults: typeof modelDefaults
  modelSelectionSeq: typeof modelSelectionSeq
  moduleSessionId: typeof moduleSessionId
  newSessionCatalog: typeof newSessionCatalog
  notice: typeof notice
  offPermission: typeof offPermission
  open: typeof open
  openNewSessionDialog: typeof openNewSessionDialog
  pendingSessionKey: typeof pendingSessionKey
  permissionChangePending: typeof permissionChangePending
  permissionConnectionEpoch: typeof permissionConnectionEpoch
  permissionMode: typeof permissionMode
  permissionRefreshPending: typeof permissionRefreshPending
  permissionSelectionSeq: typeof permissionSelectionSeq
  projection: typeof projection
  queueAction: typeof queueAction
  receipts: typeof receipts
  recoveredReturns: typeof recoveredReturns
  recoveryDisabled: typeof recoveryDisabled
  referenceSessionPending: typeof referenceSessionPending
  references: typeof references
  refreshSessionControls: typeof refreshSessionControls
  render: typeof render
  renderControls: typeof renderControls
  renderNewSessionControls: typeof renderNewSessionControls
  renderer: typeof renderer
  run: typeof run
  runtimeCatalog: typeof runtimeCatalog
  runtimeModels: typeof runtimeModels
  selectedDraftPreset: typeof selectedDraftPreset
  selectedModelAvailable: typeof selectedModelAvailable
  selectedWorkspace: typeof selectedWorkspace
  selection: typeof selection
  sending: typeof sending
  sessionControls: typeof sessionControls
  sessionPending: typeof sessionPending
  sessionRows: typeof sessionRows
  sessionTitles: typeof sessionTitles
  sessionYoloEnabled: typeof sessionYoloEnabled
  settingsText: typeof settingsText
  showError: typeof showError
  showSessionRecovery: typeof showSessionRecovery
  stopAfterSeq: typeof stopAfterSeq
  stopEvents: typeof stopEvents
  stopping: typeof stopping
  streamFrame: typeof streamFrame
  submissionGeneration: typeof submissionGeneration
  submitComposer: typeof submitComposer
  syncDraftPermission: typeof syncDraftPermission
  t: typeof t
  titleRefresh: typeof titleRefresh
  topbarRuntime: typeof topbarRuntime
  tracePaintedAt: typeof tracePaintedAt
  tracePanel: typeof tracePanel
  tracePending: typeof tracePending
  traceTrailing: typeof traceTrailing
  transcriptMeta: typeof transcriptMeta
  updateSidebar: typeof updateSidebar
  updateTitle: typeof updateTitle
  windowAtStart: typeof windowAtStart
  workspaceRows: typeof workspaceRows
  readOnly: typeof readOnly
  readOnlyController: typeof readOnlyController
}
const appSessionContext: AppSessionContext = {
  get SESSION_WATCH_STOP_TIMEOUT_MS() {
    return SESSION_WATCH_STOP_TIMEOUT_MS
  },
  get TRACE_THROTTLE_MS() {
    return TRACE_THROTTLE_MS
  },
  get approvalBusy() {
    return approvalBusy
  },
  set approvalBusy(value: typeof approvalBusy) {
    approvalBusy = value
  },
  get approvalRuntime() {
    return approvalRuntime
  },
  get approvalSearch() {
    return approvalSearch
  },
  set approvalSearch(value: typeof approvalSearch) {
    approvalSearch = value
  },
  get approvalSearchTicket() {
    return approvalSearchTicket
  },
  set approvalSearchTicket(value: typeof approvalSearchTicket) {
    approvalSearchTicket = value
  },
  get attachmentSessionOpening() {
    return attachmentSessionOpening
  },
  set attachmentSessionOpening(value: typeof attachmentSessionOpening) {
    attachmentSessionOpening = value
  },
  get awaitingPromptStart() {
    return awaitingPromptStart
  },
  set awaitingPromptStart(value: typeof awaitingPromptStart) {
    awaitingPromptStart = value
  },
  get beginNewDraft() {
    return beginNewDraft
  },
  get clearSessionRecovery() {
    return clearSessionRecovery
  },
  get client() {
    return client
  },
  get clientModules() {
    return clientModules
  },
  get composerDraftKey() {
    return composerDraftKey
  },
  get composerRuntime() {
    return composerRuntime
  },
  get configured() {
    return configured
  },
  set configured(value: typeof configured) {
    configured = value
  },
  get connected() {
    return connected
  },
  set connected(value: typeof connected) {
    connected = value
  },
  get controlPending() {
    return controlPending
  },
  set controlPending(value: typeof controlPending) {
    controlPending = value
  },
  get controlsHistory() {
    return controlsHistory
  },
  get controlsRefresh() {
    return controlsRefresh
  },
  set controlsRefresh(value: typeof controlsRefresh) {
    controlsRefresh = value
  },
  get conversationRuntime() {
    return conversationRuntime
  },
  get current() {
    return current
  },
  set current(value: typeof current) {
    current = value
  },
  get dockControlsHost() {
    return dockControlsHost
  },
  get draftBundles() {
    return draftBundles
  },
  set draftBundles(value: typeof draftBundles) {
    draftBundles = value
  },
  get draftLoop() {
    return draftLoop
  },
  set draftLoop(value: typeof draftLoop) {
    draftLoop = value
  },
  get draftLoopAvailable() {
    return draftLoopAvailable
  },
  get draftLoopEdited() {
    return draftLoopEdited
  },
  set draftLoopEdited(value: typeof draftLoopEdited) {
    draftLoopEdited = value
  },
  get draftPreset() {
    return draftPreset
  },
  set draftPreset(value: typeof draftPreset) {
    draftPreset = value
  },
  get draftingNew() {
    return draftingNew
  },
  set draftingNew(value: typeof draftingNew) {
    draftingNew = value
  },
  get goalHost() {
    return goalHost
  },
  get initialModelPending() {
    return initialModelPending
  },
  set initialModelPending(value: typeof initialModelPending) {
    initialModelPending = value
  },
  get initialPermissionPending() {
    return initialPermissionPending
  },
  set initialPermissionPending(value: typeof initialPermissionPending) {
    initialPermissionPending = value
  },
  get intentionalClose() {
    return intentionalClose
  },
  set intentionalClose(value: typeof intentionalClose) {
    intentionalClose = value
  },
  get knownSessionModel() {
    return knownSessionModel
  },
  set knownSessionModel(value: typeof knownSessionModel) {
    knownSessionModel = value
  },
  get list() {
    return list
  },
  get live() {
    return live
  },
  set live(value: typeof live) {
    live = value
  },
  get liveApproval() {
    return liveApproval
  },
  set liveApproval(value: typeof liveApproval) {
    liveApproval = value
  },
  get loopCatalogError() {
    return loopCatalogError
  },
  set loopCatalogError(value: typeof loopCatalogError) {
    loopCatalogError = value
  },
  get loopCatalogPending() {
    return loopCatalogPending
  },
  set loopCatalogPending(value: typeof loopCatalogPending) {
    loopCatalogPending = value
  },
  get modelChangePending() {
    return modelChangePending
  },
  set modelChangePending(value: typeof modelChangePending) {
    modelChangePending = value
  },
  get modelDefaults() {
    return modelDefaults
  },
  get modelSelectionSeq() {
    return modelSelectionSeq
  },
  set modelSelectionSeq(value: typeof modelSelectionSeq) {
    modelSelectionSeq = value
  },
  get moduleSessionId() {
    return moduleSessionId
  },
  set moduleSessionId(value: typeof moduleSessionId) {
    moduleSessionId = value
  },
  get newSessionCatalog() {
    return newSessionCatalog
  },
  set newSessionCatalog(value: typeof newSessionCatalog) {
    newSessionCatalog = value
  },
  get notice() {
    return notice
  },
  get offPermission() {
    return offPermission
  },
  set offPermission(value: typeof offPermission) {
    offPermission = value
  },
  get open() {
    return open
  },
  get openNewSessionDialog() {
    return openNewSessionDialog
  },
  get pendingSessionKey() {
    return pendingSessionKey
  },
  set pendingSessionKey(value: typeof pendingSessionKey) {
    pendingSessionKey = value
  },
  get permissionChangePending() {
    return permissionChangePending
  },
  set permissionChangePending(value: typeof permissionChangePending) {
    permissionChangePending = value
  },
  get permissionConnectionEpoch() {
    return permissionConnectionEpoch
  },
  set permissionConnectionEpoch(value: typeof permissionConnectionEpoch) {
    permissionConnectionEpoch = value
  },
  get permissionMode() {
    return permissionMode
  },
  set permissionMode(value: typeof permissionMode) {
    permissionMode = value
  },
  get permissionRefreshPending() {
    return permissionRefreshPending
  },
  set permissionRefreshPending(value: typeof permissionRefreshPending) {
    permissionRefreshPending = value
  },
  get permissionSelectionSeq() {
    return permissionSelectionSeq
  },
  set permissionSelectionSeq(value: typeof permissionSelectionSeq) {
    permissionSelectionSeq = value
  },
  get projection() {
    return projection
  },
  set projection(value: typeof projection) {
    projection = value
  },
  get queueAction() {
    return queueAction
  },
  set queueAction(value: typeof queueAction) {
    queueAction = value
  },
  get receipts() {
    return receipts
  },
  get recoveredReturns() {
    return recoveredReturns
  },
  get recoveryDisabled() {
    return recoveryDisabled
  },
  get referenceSessionPending() {
    return referenceSessionPending
  },
  set referenceSessionPending(value: typeof referenceSessionPending) {
    referenceSessionPending = value
  },
  get references() {
    return references
  },
  get refreshSessionControls() {
    return refreshSessionControls
  },
  get render() {
    return render
  },
  get renderControls() {
    return renderControls
  },
  get renderNewSessionControls() {
    return renderNewSessionControls
  },
  get renderer() {
    return renderer
  },
  get run() {
    return run
  },
  get runtimeCatalog() {
    return runtimeCatalog
  },
  set runtimeCatalog(value: typeof runtimeCatalog) {
    runtimeCatalog = value
  },
  get runtimeModels() {
    return runtimeModels
  },
  set runtimeModels(value: typeof runtimeModels) {
    runtimeModels = value
  },
  get selectedDraftPreset() {
    return selectedDraftPreset
  },
  get selectedModelAvailable() {
    return selectedModelAvailable
  },
  get selectedWorkspace() {
    return selectedWorkspace
  },
  set selectedWorkspace(value: typeof selectedWorkspace) {
    selectedWorkspace = value
  },
  get selection() {
    return selection
  },
  set selection(value: typeof selection) {
    selection = value
  },
  get sending() {
    return sending
  },
  set sending(value: typeof sending) {
    sending = value
  },
  get sessionControls() {
    return sessionControls
  },
  set sessionControls(value: typeof sessionControls) {
    sessionControls = value
  },
  get sessionPending() {
    return sessionPending
  },
  set sessionPending(value: typeof sessionPending) {
    sessionPending = value
  },
  get sessionRows() {
    return sessionRows
  },
  set sessionRows(value: typeof sessionRows) {
    sessionRows = value
  },
  get sessionTitles() {
    return sessionTitles
  },
  get sessionYoloEnabled() {
    return sessionYoloEnabled
  },
  set sessionYoloEnabled(value: typeof sessionYoloEnabled) {
    sessionYoloEnabled = value
  },
  get settingsText() {
    return settingsText
  },
  get showError() {
    return showError
  },
  get showSessionRecovery() {
    return showSessionRecovery
  },
  get stopAfterSeq() {
    return stopAfterSeq
  },
  set stopAfterSeq(value: typeof stopAfterSeq) {
    stopAfterSeq = value
  },
  get stopEvents() {
    return stopEvents
  },
  set stopEvents(value: typeof stopEvents) {
    stopEvents = value
  },
  get stopping() {
    return stopping
  },
  set stopping(value: typeof stopping) {
    stopping = value
  },
  get streamFrame() {
    return streamFrame
  },
  set streamFrame(value: typeof streamFrame) {
    streamFrame = value
  },
  get submissionGeneration() {
    return submissionGeneration
  },
  set submissionGeneration(value: typeof submissionGeneration) {
    submissionGeneration = value
  },
  get submitComposer() {
    return submitComposer
  },
  get syncDraftPermission() {
    return syncDraftPermission
  },
  get t() {
    return t
  },
  get titleRefresh() {
    return titleRefresh
  },
  get topbarRuntime() {
    return topbarRuntime
  },
  get tracePaintedAt() {
    return tracePaintedAt
  },
  set tracePaintedAt(value: typeof tracePaintedAt) {
    tracePaintedAt = value
  },
  get tracePanel() {
    return tracePanel
  },
  get tracePending() {
    return tracePending
  },
  set tracePending(value: typeof tracePending) {
    tracePending = value
  },
  get traceTrailing() {
    return traceTrailing
  },
  set traceTrailing(value: typeof traceTrailing) {
    traceTrailing = value
  },
  get transcriptMeta() {
    return transcriptMeta
  },
  get updateSidebar() {
    return updateSidebar
  },
  get updateTitle() {
    return updateTitle
  },
  get readOnly() {
    return readOnly
  },
  set readOnly(value: typeof readOnly) {
    readOnly = value
  },
  get readOnlyController() {
    return readOnlyController
  },
  get windowAtStart() {
    return windowAtStart
  },
  set windowAtStart(value: typeof windowAtStart) {
    windowAtStart = value
  },
  get workspaceRows() {
    return workspaceRows
  },
  set workspaceRows(value: typeof workspaceRows) {
    workspaceRows = value
  },
}
const commandController = createCommandController(appSessionContext)
const composerController = createComposerController(appSessionContext)
const submissionController = createSubmissionController(appSessionContext)
const sessionController = createSessionController(appSessionContext)
const turnController = createTurnController(appSessionContext)
const readOnlyController = createReadOnlyController(appSessionContext, {
  open: (id) => open(id),
  beginNewDraft: () => beginNewDraft(),
})

const composerDraftKey: string = 'agnes-web-composer-draft'
// Keep image submissions below the daemon's WebSocket frame cap, including their JSON-RPC envelope.
const savedComposerDraft = sessionStorage.getItem(composerDraftKey)
const notice = appNotice
const conversation = hosts.conversation
const goalHost = hosts.goal
const wsUrl = shellConfig.wsUrl
const client = createClient({
  transport: { kind: 'ws', url: wsUrl ?? '', protocols: ['agnes-v1'] },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
const stopJobsSessions = bindJobsSessions({
  current: () => current?.id,
  async list() {
    const rows: PageSessionMeta['items'] = []
    let cursor: string | undefined
    do {
      const page = await client.session.list({ limit: 500, ...(cursor ? { cursor } : {}) })
      rows.push(...page.items)
      cursor = page.next
    } while (cursor)
    return rows.map((row) => ({
      id: row.sessionId,
      title: row.title || t('app.status.newTask'),
      workspace: row.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
      createdAt: row.createdAt,
    }))
  },
})
onPageHide(stopJobsSessions)
let intentionalClose = false
// Recovery state lives beside the notice, not in it: later errors rewrite the notice, and the
// retry control must survive them.
const reconnect = createReconnectController({
  probe: bootstrapProbe((input, init) => fetch(input, init), wsUrl ?? ''),
  reload: () => location.reload(),
  onPhase: renderReconnect,
})
function renderReconnect(phase: ReconnectPhase): void {
  setReconnectNotice(phase, () => reconnect.retry())
  if (phase !== 'idle') setConnection(phase === 'stalled' ? 'closed' : 'reconnecting')
}
// 客户端模块底座（WC8）：Cordis 根 + 五个宿主服务 + workbench.panel 挂载点。
// 名册真源是 `_agnes/v1/clientModules.list`（P1a）；profile 要等 config.get() 才报出，
// 之前名册按空处理（fail-closed，不加载任何模块）。
const customModuleListeners = new Set<() => void>()
const moduleExtIds = new Map<string, string[]>()
let moduleSessionId: string | undefined
const rosterSource: RosterSource = {
  async list() {
    if (!profileName) return { revision: '', modules: [], statuses: [] }
    const roster = await client.clientModules.list(profileName, moduleSessionId)
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
          ...(row.intelligentComponents ? { intelligentComponents: row.intelligentComponents } : {}),
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
    for (const listener of customModuleListeners) listener()
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
const computerUseStatus = createComputerUsePaneController(client)
onPageHide(() => computerUseStatus.dispose())
const references = composerReferences(prepareComposerSession, renderControls)
let referenceSessionPending: Promise<Session> | undefined

const adminPanes = createSettingsAdminPaneStore()
const clientModules = await startClientModules({
  agnes: client,
  claim: claimSlotCard,
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
    if (!response.ok) throw new Error(t('app.plugin.serviceUnavailable'))
    const body: unknown = await response.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || !('output' in body))
      throw new Error(t('app.plugin.serviceInvalid'))
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
    if (!response.ok) throw new Error(t('app.plugin.effectUnavailable'))
    const body: unknown = await response.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || !('output' in body))
      throw new Error(t('app.plugin.effectInvalid'))
    return (body as { output: unknown }).output
  },
  authorizeCommand: ({ owner, command }) =>
    window.confirm(
      t('app.plugin.authorize', {
        owner,
        command: command.title ?? command.id,
        service: command.effectService
          ? t('app.plugin.authorizeService', { service: command.effectService })
          : '',
      }),
    ),
  panelContainer: hosts.panels,
  sidebarContainer: hosts.sidebar,
  sidebar: {
    actions: {
      newSession: (workspace) => {
        homeNavigation.close()
        run(() => beginNewDraft(workspace === undefined, workspace))
      },
      addWorkspace: () =>
        run(async () => {
          homeNavigation.close()
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
          homeNavigation.close()
          // The session already showing behind a page needs no second open.
          if (id !== current?.id || draftingNew) await open(id)
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
  topbarContainer: hosts.topbar,
  approvalContainer: hosts.approval,
  composerContainer: hosts.composer,
  composer: {
    references,
    initialDraft: savedComposerDraft ?? '',
    onAttachmentsChange: renderControls,
    prepareUploadSession: prepareAttachmentSession,
    onCancel: handleComposerCancel,
    onChildControl: handleChildControl,
    onPauseResume: handlePauseResume,
    onEditQueued: handleEditQueued,
    onDraftChange: handleComposerDraftChange,
    onError: showError,
    onModelSelect: selectModel,
    onAuxiliaryRead: readAuxiliaryModels,
    onAuxiliarySelect: selectAuxiliaryModel,
    onModelSettingsChange: selectModelSettings,
    onPermissionSelect: selectPermission,
    onSubmit: submitComposer,
    onSendNow: (itemId) => handleQueuedAction(itemId, 'sendNow'),
    onRemoveQueued: (itemId) => handleQueuedAction(itemId, 'removeQueued'),
    onWorkspace: handleComposerWorkspace,
  },
  traceContainer: hosts.trace,
  trace: {
    toggle: hosts.viewTrace,
    chatToggle: hosts.viewChat,
    conversation,
    clearModelRequest: async (params) => {
      if (!current || current.id !== params.sessionId) throw new Error(t('app.trace.sessionSwitched'))
      return client.requestTrace.clear(params)
    },
    openFactChain: (input) => factChainLinks.open(input),
    readModelRequest: async (params, signal) => {
      if (!current || current.id !== params.sessionId) throw new Error(t('app.trace.sessionSwitched'))
      if (signal?.aborted) throw new Error(t('app.trace.sessionSwitched'))
      return client.requestTrace.get(params)
    },
    readToolDetail: async (sessionId, callSeq, resultSeq, signal) => {
      const session = current
      if (!session) throw new Error(t('app.trace.noSession'))
      if (session.id !== sessionId) throw new Error(t('app.trace.sessionSwitched'))
      return session.readToolDetail(callSeq, resultSeq, signal ? { signal } : undefined)
    },
  },
  rightbarContainer: hosts.rightbar,
  settingsPaneContainer: hosts.settings,
  settings: {
    sections: settingsSections,
    adminPanes,
    computerUseSupported: async () => {
      const report = await client.call<ComputerUseStatusResult>('_agnes/v1/computerUse.status', {})
      return report.status !== 'blocked' || !report.blockers.includes('platform-unsupported')
    },
    computerUse: computerUseStatus.render(),
    // A page that left settings was asked for by name: close the dialog and open its new home.
    onMoved: (target) => {
      settings.close()
      openMovedSettings(target, {
        openPage: (page, tab) => homeNavigation.open(page, tab ? { tab } : undefined),
        searchSessions: () => sessionSearch.open(),
        showArchived: () => archivedSessions.show('archived'),
      })
    },
    onChange: ({ pane, tab }) => {
      if (pane === 'model') void settings.open()
      else if (pane === 'plugin') void adminPaneController.open('plugin')
      else if (pane === 'resources') void adminPaneController.open('resources', tab ?? 'skills')
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
const openSettingsTerminal = (event: Event) => {
  settings.close()
  if (workbenchNavigation.open('terminal')) event.preventDefault()
}
const stopSettingsTerminal = onSurfaceEvent('agnes:settings-terminal', openSettingsTerminal)
const statusCheck = mountStatusCheck({
  details: () =>
    run(async () => {
      settingsRegion.open('model')
      await settings.open()
      settingsRegion.route('diagnostics')
    }),
})
const settingsRegion = clientModules.settings as NonNullable<typeof clientModules.settings>
if (!settingsRegion) throw new Error('missing settings region')
// Home entries open full pages in the main area; the built-in three register like any plugin's.
const removeHomeEntries = registerBuiltinHomeEntries()
const homePages = mountHomePages(hosts.homePage, {
  locale: clientModules.locale,
  data: {
    call: (method, params) => client.call(method, params),
    sessionId: () => current?.id,
    openSettings: (section) =>
      run(async () => {
        settingsRegion.open('model')
        await settings.open()
        settingsRegion.route(section)
      }),
    startDraft: (prompt) =>
      run(async () => {
        homeNavigation.close()
        if (!draftingNew) await beginNewDraft(false)
        if (prompt) composerRuntime.setDraft(prompt)
        composerRuntime.focus()
      }),
    plugins: {
      actualSlots: clientModules.actualSlots,
      runtime: clientModules.reconciler,
      workspaceId: () => paneWorkspaceId(),
    },
  },
})
const stopHomeRouting = bindHomeRouting()
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
const unmountIntelligentUi = mountIntelligentUi({
  resources: clientModules.resources,
  customModules: {
    theme: clientModules.theme,
    async list(sessionId) {
      if (!profileName) return []
      return (await client.clientModules.list(profileName, sessionId)).rows
    },
    subscribe(listener) {
      customModuleListeners.add(listener)
      return () => {
        customModuleListeners.delete(listener)
      }
    },
  },
  client,
  registry: clientModules.registry,
  session: clientModules.session,
  locale: clientModules.locale,
  revealInline: () => tracePanel.setOpen(false),
  approval: () => {
    searchApproval()
    approvalRuntime.focus()
  },
})

// 渲染时取词：t 只在渲染/组装瞬间调用；语言切换后由订阅重跑渲染函数，命令式区域整体重建。
const t: Translate = (key, vars) => clientModules.locale.t(key, vars)
const newSessionDialog = mountNewSessionDialog(hosts.newSession, {
  translate: t,
  submit: () => run(chooseWorkspace),
  pick: () => run(pickWorkspace),
  select: (workspace) => {
    selectedWorkspace = workspace
    closeNewSessionDialog()
    renderControls()
    composerRuntime.focus()
  },
  restoreFocus: () => clientModules.sidebar?.focusNew(),
})
setLocaleTranslator(t)
clientModules.locale.register('@agnes/web-workbench', workbenchLocaleCatalog)

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
onPageHide(() => stopPluginHotReload())
let connected = false
let configured = false
let current: Session | undefined
let sessionControls: { sessionId: string; value: SessionControlStateResult } | undefined
let controlsRefresh = 0
let controlPending = false
const recoveredReturns = new Set<string>()
const controlsHistory = new Map<
  string,
  { through: number; facts: NonNullable<SessionControlStateResult['facts']> }
>()
const childControlRefreshTimer = setInterval(() => {
  const session = current
  if (
    connected &&
    session &&
    !sessionPending &&
    sessionControls?.value.children?.some((child) =>
      ['starting', 'running', 'interrupted'].includes(child.status),
    )
  )
    void refreshSessionControls(session).catch(showError)
}, 1500)
onPageHide(() => clearInterval(childControlRefreshTimer))
let projection: UITimeline | undefined
let selection = 0
let listGeneration = 0
let live: LiveProjection | undefined
// The window's first node is the session's first, so its first user message titles the task.
let windowAtStart = true
// A session that cannot continue on this build, shown from its record alone.
let readOnly: { id: string; maxNodes: number; hasEarlier: boolean } | undefined
let approvalSearch: 'idle' | 'searching' | 'not-found' = 'idle'
let approvalSearchTicket: string | undefined
let streamFrame: number | undefined
let stopEvents: (() => Promise<void>) | undefined
let offPermission: (() => void) | undefined
let sending = false
let awaitingPromptStart = false
let stopping = false
let queueAction:
  | {
      sessionId: string
      selection: number
      itemId: string
      kind: 'sendNow' | 'removeQueued'
      pending: boolean
      error?: string
    }
  | undefined
let sessionPending = false
let newSessionCreating = false
let workspacePickerReady: boolean | undefined
let workspacePickerBusy = false
let stopAfterSeq = 0
let approvalBusy = false
let runtimeModels: ModelPickerOption[] = []
let accountLabels = new Map<string, string>()
let accountProvider: { route?: string; id?: string; model?: string } | null = null
let knownSessionModel: KnownSessionModel | undefined
let initialModelPending: KnownSessionModel | undefined
let modelChangePending = false
let auxiliaryModelPending = false
let modelSelectionSeq = 0
let draftModelSettingsEdited = false
let draftModelExplicit = false
let draftLoop: LoopSelection | undefined
let draftLoopEdited = false
let draftPreset: string | undefined
let draftBundles: string[] = []
let runtimeCatalog: import('@agnes/protocol').RuntimeAdminSnapshot | undefined
const startupRequest = new URLSearchParams(location.search)
const startupSettingsAnchor = location.hash.slice(1)
const requestedLoop = startupRequest.get('loop') ?? undefined
const requestedPreset = startupRequest.get('preset') ?? undefined
const requestedBundles = startupRequest.getAll('bundle')
const requestedPrompt = startupRequest.get('prompt') ?? undefined
// `/admin/resources?workspaceId=…` forwards here: the link names the workspace its resources are for.
const requestedWorkspaceId = (() => {
  const id = startupRequest.get('workspaceId')
  return id && /^[a-f0-9]{64}$/.test(id) ? id : undefined
})()
const settingsText = (key: string): string =>
  createCatalogTranslator(
    settingsCatalog,
    clientModules.locale.getSnapshot() === 'zh-CN' ? 'zh-CN' : 'en',
  )(key)
let newSessionCatalog: NewSessionCatalog | undefined
let loopCatalogError = false
let loopCatalogPending = false
let sessionCatalogGeneration = 0
function selectedDraftPreset(): string | undefined {
  return effectiveSessionPreset(draftPreset, newSessionCatalog?.defaults, runtimeCatalog)
}
function syncDraftPermission(): void {
  permissionMode = permissionForSessionPreset(selectedDraftPreset(), runtimeCatalog) ?? permissionMode
}
async function refreshSessionCatalog(): Promise<void> {
  const generation = ++sessionCatalogGeneration
  loopCatalogPending = !newSessionCatalog
  renderControls()
  try {
    const catalog = await loadNewSessionCatalog()
    let runtime: typeof runtimeCatalog
    try {
      runtime = await loadRuntimeCatalog()
    } catch {
      runtime = undefined
    }
    if (generation !== sessionCatalogGeneration) return
    newSessionCatalog = catalog
    runtimeCatalog = runtime
    loopCatalogError = false
    if (draftingNew && !draftLoopEdited) draftLoop = defaultLoop(newSessionCatalog.defaults)
    if (draftingNew) syncDraftPermission()
  } catch {
    if (generation === sessionCatalogGeneration) loopCatalogError = true
  } finally {
    if (generation === sessionCatalogGeneration) {
      loopCatalogPending = false
      renderControls()
    }
  }
}
function draftLoopAvailable(): boolean {
  return (
    !draftLoop ||
    !!newSessionCatalog?.loops.some(
      (entry) => loopIdentity(entry) === loopIdentity(draftLoop as LoopSelection),
    )
  )
}
let permissionMode: PermissionMode = 'workspace'
let initialPermissionPending: PermissionMode | undefined
let permissionChangePending = false
let permissionRefreshPending = false
let permissionConnectionEpoch = 0
let sessionYoloEnabled: boolean | undefined
let permissionSelectionSeq = 0
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
    locale: clientModules.locale.getSnapshot(),
    // While a home page shows, the page's entry is the selected item, not the session behind it.
    ...(activeHomeEntry()
      ? {}
      : current
        ? { currentId: current.id }
        : readOnly
          ? { currentId: readOnly.id }
          : {}),
    ...(sessionNext ? { next: sessionNext } : {}),
    sessionPending,
    newDisabled: !connected || sending || sessionPending || newSessionCreating,
  })
}

// Opening or leaving a home page, or losing its entry, moves the sidebar's selection.
const stopHomeSelection = [homeNavigation.subscribe(updateSidebar), homeEntries.subscribe(updateSidebar)]

const SESSION_WATCH_STOP_TIMEOUT_MS: number = 3000
function stopWithTimeout(stop: (() => Promise<void>) | undefined): Promise<boolean> {
  return sessionController.stopWithTimeout(stop)
}
const settings = createSettingsController({ client, onSaved: savedConfiguration, onError: showError })
onSurfaceEvent('agnes:permission-settings', () =>
  run(async () => {
    settingsRegion.open('model')
    await settings.open()
    settingsRegion.route('security')
  }),
)
clientModules.locale.subscribe(() => settings.refreshLocale())
const firstRun = createFirstRunController({
  host: hosts.firstRun,
  banner: hosts.doctorNotice,
  client,
  storage: safeThemeStorage(),
  attachAccount: (host) => settings.attachInline(host),
  connectAccount: () => settings.submitInline(),
  chooseWorkspace: async (path) => {
    if (!path) {
      const result = await requestWorkspacePicker()
      if (result.status === 'cancelled') return undefined
      if (result.status === 'unavailable') throw new Error(t('app.newSession.pickerFailed'))
      path = result.path
    }
    await registerWorkspace(path.trim())
    return selectedWorkspace?.name
  },
  closeSettings: () => settings.close(),
  examples: async () => {
    settings.close()
    homeNavigation.open('agents')
  },
  // A run notice opens the status check on its own; the full page is one step further.
  details: async () => statusCheck.open(),
  start: async () => {
    settings.close()
    homeNavigation.close()
    await beginNewDraft(true)
  },
  saved: savedConfiguration,
})
clientModules.locale.subscribe(() => firstRun.refreshLocale())
const sessionActions = createSessionActions({
  client,
  loopLabel: (id) => newSessionCatalog?.loops.find((loop) => loop.id === id)?.label,
  changed: () => list(),
  fork: forkSidebar,
  error: (error) => {
    clientModules.sidebar?.dismiss()
    showError(error)
  },
  archived: (id) => {
    if (archivedSessions.getSnapshot().filter === 'archived') void archivedSessions.reload()
    notice.setText(t('home.archived.notice'))
    notice.offer({
      label: t('home.archived.undo'),
      run: () => {
        notice.setText('')
        void archivedSessions.restore(id)
      },
    })
  },
  translate: t,
})
archivedSessions.bind({
  list: (params) => client.session.list(params),
  restore: (id) => client.session.archive(id, false),
  changed: () => list(),
})
// Search finds a session by what was said in it; opening one leaves any home page.
const sessionSearch = mountSessionSearch({
  translate: t,
  recent: () =>
    sortSessionsByRecency(sessionRows.filter((row) => !row.archived))
      .slice(0, 8)
      .map((row) => ({
        sessionId: row.sessionId,
        title: row.title || sessionLabels.get(row.sessionId) || '',
        workspace: row.cwd ?? '',
      })),
  titleOf: (id) => sessionRows.find((row) => row.sessionId === id)?.title || sessionLabels.get(id),
  open: (id) =>
    run(async () => {
      if (sessionPending) return
      homeNavigation.close()
      if (id !== current?.id || draftingNew) await open(id)
    }),
})
onSurfaceEvent(SESSION_SEARCH_EVENT, (event) =>
  sessionSearch.open(event.target instanceof HTMLElement ? event.target : undefined),
)
clientModules.locale.subscribe(() => sessionSearch.refreshLocale())
// Top bar entries for the selected session: its title renames it, the info button shows its runtime.
for (const action of ['rename', 'runtime'] as const)
  onSurfaceEvent(`agnes:${action}-current-session`, (event) => {
    if (!current || draftingNew || sessionPending) return
    const trigger = event.target
    if (trigger instanceof HTMLElement)
      void sessionActions.act(action, current.id, trigger.textContent ?? '', trigger)
  })
onSurfaceEvent('agnes:compose-suggestion', (event) => {
  if ((current && !draftingNew) || sessionPending || !(event instanceof CustomEvent)) return
  if (typeof event.detail !== 'string') return
  composerRuntime.setDraft(event.detail)
  composerRuntime.focus()
})
let sessionRecovery: { id: string; message: string } | undefined
function errorMessage(error: unknown): string {
  // Provider values are redacted by settings before leaving that controller.
  const message = error instanceof Error ? error.message : t('app.error.fallback')
  const diagnostic =
    error instanceof Error && 'data' in error && error.data && typeof error.data === 'object'
      ? (error.data as {
          code?: unknown
          reason?: unknown
          diagnosticId?: unknown
          diagnosticUnavailable?: unknown
          modelRoute?: unknown
          error?: { code?: unknown }
        })
      : undefined
  return errorNotice(
    message,
    diagnostic?.diagnosticId,
    diagnostic?.diagnosticUnavailable,
    diagnostic?.code === 'CONFIG_CREDENTIAL_REJECTED'
      ? 'AUTH'
      : diagnostic?.code === 'TURN_ERROR'
        ? diagnostic.error?.code
        : undefined,
    diagnostic?.reason,
    t,
  )
}
function showError(error: unknown): void {
  const message = errorMessage(error)
  if (sessionRecovery) {
    renderSessionRecovery(message)
    notice.setKind('error')
  } else {
    notice.setText(message)
    notice.setKind('error')
  }
  if (newSessionDialog.open) newSessionDialog.update({ error: message })
  const data =
    error && typeof error === 'object' && 'data' in error
      ? (error.data as { code?: unknown; modelRoute?: unknown })
      : undefined
  if (data?.code === 'CONFIG_CREDENTIAL_REJECTED') {
    notice.repair(() => {
      settingsRegion.open('model')
      run(() => settings.openAccount(typeof data.modelRoute === 'string' ? data.modelRoute : undefined))
    })
  }
}
function run(op: () => Promise<void>): void {
  newSessionDialog.update({ error: '' })
  if (sessionRecovery) renderSessionRecovery()
  else {
    notice.setText('')
    notice.setKind('')
  }
  void op().catch(showError)
}
function showSessionRecovery(error: unknown, id: string): void {
  const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
  sessionRecovery = {
    id,
    message:
      data && typeof data === 'object' && 'code' in data && data.code === 'SESSION_PROFILE_MISSING'
        ? t('app.recovery.profileMissing')
        : data && typeof data === 'object' && 'reason' in data && data.reason === 'legacy-ledger-format'
          ? errorMessage(error)
          : t('app.recovery.openFailed', { detail: errorMessage(error) }),
  }
  renderSessionRecovery()
}
function recoveryDisabled(): boolean {
  return !connected || sending || sessionPending || newSessionCreating
}
function renderSessionRecovery(message = ''): void {
  if (!sessionRecovery) return
  notice.recover({
    message: sessionRecovery.message,
    error: message,
    disabled: recoveryDisabled(),
    retry() {
      if (recoveryDisabled() || !sessionRecovery) return
      const id = sessionRecovery.id
      run(() => open(id))
    },
    create() {
      if (!recoveryDisabled()) run(() => beginNewDraft())
    },
  })
}
function clearSessionRecovery(): void {
  readOnlyController.clear()
  if (!sessionRecovery) return
  sessionRecovery = undefined
  notice.setText('')
  notice.setKind('')
}
function setConnection(value: 'connecting' | 'connected' | 'reconnecting' | 'closed'): void {
  connected = value === 'connected'
  if (!connected) {
    permissionConnectionEpoch++
    if (current) {
      permissionRefreshPending = true
      sessionYoloEnabled = undefined
      // An interrupted first submission must not replay its permission choice after reconnecting.
      initialPermissionPending = undefined
    }
  }
  topbarRuntime.setConnectionState(value)
  setConnectionNotice(value)
  settings.setConnected(connected)
  renderControls()
}
const dockControlsHost = hosts.dockControls
function renderControls(): void {
  composerController.renderControls()
}
// 流式期间每个事件都会让轨迹面板全量走查一遍节点，长会话里比时间线本身还贵。
// busy 时把面板喂食节流到 500ms（尾沿补一帧，喂的是最新视图）；终态与空闲路径
// 立即刷，保证收尾状态不迟到。节流在 app 调用侧，region 挂载本身保持同步语义。
const TRACE_THROTTLE_MS: number = 500
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
  turnController.paintTrace()
}
function renderTrace(
  view: WebView,
  turns: readonly UITurn[] | undefined,
  meta: ReturnType<typeof transcriptMeta>,
): void {
  turnController.renderTrace(view, turns, meta)
}
function render(): void {
  turnController.render()
}
function renderApproval(): void {
  turnController.renderApproval()
}
function transcriptMeta(): {
  hasEarlier: boolean
  loadEarlier?: () => void
  sessionId?: string
  loop?: { id: string; version: string }
  controlFacts?: NonNullable<SessionControlStateResult['facts']>
} {
  return turnController.transcriptMeta()
}
/** Loads earlier pages, `limit` at most, until the parked approval's node is loaded. */
function searchApproval(limit?: number): void {
  turnController.searchApproval(limit)
}
/** What watching the event stream used to do per event: titles, the list, the run receipt. */
function followEvent(session: Session, event: LedgerEvent): Promise<void> {
  return sessionController.followEvent(session, event)
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
  if (current && projection) render()
  sessionNext = page.next
  updateSidebar()
  const selectedRow = sessionRows.find((row) => row.sessionId === current?.id)
  if (selectedRow?.title || (selectedRow && !projection?.nodes.some((node) => node.kind === 'user')))
    topbarRuntime.setTaskTitle(selectedRow.title ?? t('app.status.newTask'))
  return page
}
function open(
  id: string,
  options: {
    created?: Session
    preserveSending?: boolean
    workspace?: WorkspaceEntry
    initialModel?: KnownSessionModel
  } = {},
): Promise<void> {
  return sessionController.open(id, options)
}
function forkSidebar(id: string, title: string): Promise<void> {
  homeNavigation.close()
  return sessionController.forkSidebar(id, title)
}
let attachmentSessionOpening: Promise<string> | undefined
function prepareAttachmentSession(): Promise<string> {
  return submissionController.prepareAttachmentSession()
}

function forkTurn(turn: UITurn): Promise<void> {
  return sessionController.forkTurn(turn)
}
function renderNewSessionControls(): void {
  newSessionDialog.update({
    connected,
    pending: sessionPending,
    creating: newSessionCreating,
    pickerBusy: workspacePickerBusy,
    pickerReady: workspacePickerReady,
  })
}
function openNewSessionDialog(transitioning = false): void {
  if (!connected || (sessionPending && !transitioning) || newSessionCreating) return
  newSessionDialog.show()
}
function closeNewSessionDialog(): void {
  newSessionDialog.close()
}
function updateWorkspaceOptions(): void {
  newSessionDialog.update({ workspaces: workspaceRows })
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
    const failure = new Error(workspaceErrorNotice(error, t), { cause: error })
    newSessionDialog.update({ error: failure.message })
    throw failure
  } finally {
    newSessionCreating = false
    renderControls()
  }
}
async function chooseWorkspace(): Promise<void> {
  await registerWorkspace(newSessionDialog.path.trim())
}
async function pickWorkspace(): Promise<void> {
  if (!workspacePickerReady || workspacePickerBusy || newSessionCreating) return
  workspacePickerBusy = true
  renderNewSessionControls()
  try {
    const result = await requestWorkspacePicker().catch(() => undefined)
    if (!result) {
      workspacePickerReady = false
      newSessionDialog.update({ manual: true })
      newSessionDialog.update({ error: t('app.newSession.pickerFailed') })
      return
    }
    if (result.status === 'cancelled') return
    if (result.status === 'unavailable') {
      workspacePickerReady = false
      newSessionDialog.update({ manual: true })
      return
    }
    newSessionDialog.update({ path: result.path })
    await registerWorkspace(result.path)
  } finally {
    workspacePickerBusy = false
    renderNewSessionControls()
  }
}
async function beginNewDraft(showWorkspacePicker = true, workspace?: WorkspaceEntry): Promise<void> {
  if (sessionPending || sending) return
  sessionPending = true
  if (workspace) selectedWorkspace = workspace
  clearSessionRecovery()
  const epoch = ++selection
  references.clear()
  const previous = current
  if (previous && knownSessionModel) rememberWebComposer({ model: knownSessionModel })
  const inherited = selectionFromMemory(runtimeModels, accountProvider)
  const stop = stopEvents
  current = undefined
  moduleSessionId = undefined
  clientModules.session.setSession(undefined)
  projection = undefined
  draftingNew = true
  draftModelSettingsEdited = false
  draftModelExplicit = false
  draftLoopEdited = false
  draftLoop = newSessionCatalog && defaultLoop(newSessionCatalog.defaults)
  draftPreset = undefined
  draftBundles = []
  pendingSessionKey = crypto.randomUUID()
  knownSessionModel = inherited.model ? modelDefaults(inherited.model) : undefined
  permissionMode = inherited.permission
  syncDraftPermission()
  permissionRefreshPending = false
  initialPermissionPending = undefined
  initialModelPending = undefined
  submissionGeneration++
  offPermission?.()
  offPermission = undefined
  liveApproval?.finish({ unanswered: 'detached' })
  liveApproval = undefined
  stopEvents = undefined
  live = undefined
  renderer.reset()
  const url = new URL(location.href)
  url.searchParams.delete('session')
  const settingsHash =
    url.searchParams.has('settings') && url.hash.startsWith('#settings-subsection-') ? url.hash : ''
  history.replaceState(null, '', `${url.pathname}${url.search}${settingsHash}`)
  topbarRuntime.setTaskTitle(t('app.newSession.defaultTitle'))
  render()
  if (!selectedWorkspace?.available && showWorkspacePicker) openNewSessionDialog(true)
  else composerRuntime.focus()
  sessionPending = true
  renderControls()
  let cleanupError: unknown
  try {
    await refreshSessionCatalog()
    if (selection === epoch && draftingNew && !draftModelExplicit && !draftModelSettingsEdited) {
      const adminModel = newSessionCatalog && defaultModelAdapter(newSessionCatalog.defaults)
      const preferred = adminModel
        ? runtimeModels.find(
            (model) =>
              model.id === adminModel.model &&
              newSessionCatalog?.modelAdapters.some(
                (adapter) =>
                  adapter.id === adminModel.id &&
                  adapter.version === adminModel.version &&
                  adapter.models.some((entry) => entry.id === model.id && entry.route === model.route),
              ),
          )
        : undefined
      if (preferred) knownSessionModel = modelDefaults(preferred)
    }
    const stopped = await stopWithTimeout(stop)
    if (!stopped) {
      notice.setText(t('app.notice.oldSessionClosing'))
      notice.setKind('warning')
    }
  } catch (error) {
    cleanupError = error
  }
  try {
    await previous?.detach()
    await clientModules.reconciler.reconcileNow()
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
  applyWorkspaces(await client.workspace.list())
}
function applyWorkspaces(page: { items: WorkspaceEntry[] }): void {
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
  const models = (apis.profile.models ?? []).map((model) => ({
    ...model,
    ...(accountLabels.has(model.route) ? { label: accountLabels.get(model.route) as string } : {}),
  }))
  if (generation > modelAppliedGeneration) {
    modelAppliedGeneration = generation
    runtimeModels = models
    configured = runtimeModels.length > 0
    if (
      draftingNew &&
      !draftModelExplicit &&
      !draftModelSettingsEdited &&
      !modelChangePending &&
      !permissionChangePending
    ) {
      const next = selectionFromMemory(runtimeModels, accountProvider)
      const adminDefault = newSessionCatalog && defaultModelAdapter(newSessionCatalog.defaults)
      const preferred = adminDefault
        ? models.find(
            (model) =>
              model.id === adminDefault.model &&
              newSessionCatalog?.modelAdapters.some(
                (adapter) =>
                  adapter.id === adminDefault.id &&
                  adapter.version === adminDefault.version &&
                  adapter.models.some((entry) => entry.id === model.id && entry.route === model.route),
              ),
          )
        : undefined
      knownSessionModel = preferred
        ? modelDefaults(preferred)
        : next.model
          ? modelDefaults(next.model)
          : undefined
      if (!draftPreset) {
        permissionMode = permissionForSessionPreset(selectedDraftPreset(), runtimeCatalog) ?? next.permission
      }
    }
    renderControls()
  }
  return models
}
async function selectPermission(mode: PermissionMode): Promise<boolean> {
  if (!connected || sessionPending || permissionChangePending || permissionRefreshPending) return false
  const preset = ({ view: 'read-only', workspace: 'workspace-write', full: 'full-access' } as const)[mode]
  const usePreset = runtimeCatalog?.presets.some((entry) => entry.id === preset) === true
  if (mode === 'view' && !usePreset) throw new Error(settingsText('notAllowed'))
  if (!current && draftingNew) {
    draftPreset = usePreset ? preset : undefined
    permissionMode = mode
    rememberWebComposer({ permission: mode })
    notice.setText(t('app.permission.draftNotice', { mode: permissionLabel(mode) }))
    notice.setKind('')
    renderControls()
    return true
  }
  if (!current) return false
  const session = current
  const epoch = selection
  const connectionEpoch = permissionConnectionEpoch
  const requestedYolo = yoloEnabled(mode)
  permissionChangePending = true
  renderControls()
  try {
    if (usePreset) {
      await session.setPreset(preset)
      if (current !== session || selection !== epoch || connectionEpoch !== permissionConnectionEpoch)
        return false
    }
    const applied = await session.setYolo(requestedYolo)
    if (
      current !== session ||
      selection !== epoch ||
      sessionPending ||
      connectionEpoch !== permissionConnectionEpoch
    )
      return false
    permissionSelectionSeq = applied.effectiveFromSeq
    initialPermissionPending = undefined
    sessionYoloEnabled = requestedYolo
    permissionMode = mode
    rememberWebComposer({ permission: mode })
    notice.setText(
      mode === 'full'
        ? t('app.permission.notice.full')
        : t('app.permission.notice.mode', { mode: permissionLabel(mode) }),
    )
    notice.setKind('')
    return true
  } catch (error) {
    if (current !== session || selection !== epoch || sessionPending) return false
    const refused =
      error instanceof Error &&
      'data' in error &&
      (error.data as { code?: unknown } | undefined)?.code === 'PRESET_SWITCH_REJECTED'
    if (!refused) showError(error)
    else {
      // A live session keeps the sandbox it started with. Say so, and offer the path that works.
      const label = permissionLabel(mode)
      notice.setText(t('app.permission.fixed', { mode: label }))
      notice.setKind('')
      notice.offer({
        label: t('app.permission.useInNew', { mode: label }),
        run: () =>
          run(async () => {
            await beginNewDraft(false)
            await selectPermission(mode)
          }),
      })
    }
    return false
  } finally {
    if (current === session && selection === epoch && !sessionPending) {
      permissionChangePending = false
      render()
    }
  }
}
function modelDefaults(option: ModelPickerOption): KnownSessionModel {
  const record = runtimeModels.find((m) => m.route === option.route && m.id === option.id)
  return {
    route: option.route,
    id: option.id,
    settings: {
      ...record?.defaultSettings,
      ...(record?.contextWindow
        ? { contextWindow: record.defaultSettings?.contextWindow ?? record.contextWindow }
        : {}),
    },
  }
}
async function readAuxiliaryModels(): Promise<import('@agnes/protocol').AuxiliaryModelSlots> {
  const session = current
  if (!session) throw new Error('Session unavailable')
  const capabilities = await session.capabilities()
  if (current !== session || !capabilities?.modelRoutes.value) throw new Error('Session unavailable')
  const routes = capabilities.modelRoutes.value
  return { fast: routes.fast ?? null, verifier: routes.verifier ?? null }
}
async function selectAuxiliaryModel(slot: 'fast' | 'verifier', option: ModelPickerOption): Promise<boolean> {
  const session = current
  const epoch = selection
  if (!session || !connected || sending || sessionPending || modelChangePending || auxiliaryModelPending)
    return false
  auxiliaryModelPending = true
  try {
    await session.setModel({ slot, route: option.route, model: option.id })
    if (current !== session || selection !== epoch || sessionPending) return false
    return true
  } catch (error) {
    if (current === session && selection === epoch) showError(error)
    return false
  } finally {
    auxiliaryModelPending = false
  }
}
async function selectModelSettings(settings: ModelSettings): Promise<boolean> {
  if (!knownSessionModel) return false
  return selectModel(knownSessionModel, settings)
}
async function selectModel(option: ModelPickerOption, settings?: ModelSettings): Promise<boolean> {
  const sameModel = knownSessionModel?.route === option.route && knownSessionModel.id === option.id
  const window =
    settings?.contextWindow ??
    runtimeModels.find((m) => m.route === option.route && m.id === option.id)?.contextWindow
  const selected: KnownSessionModel =
    settings === undefined
      ? sameModel && knownSessionModel
        ? knownSessionModel
        : modelDefaults(option)
      : {
          route: option.route,
          id: option.id,
          settings: { ...settings, ...(window === undefined ? {} : { contextWindow: window }) },
        }
  const session = current
  if (sessionPending || modelChangePending || auxiliaryModelPending) return false
  if (!session && draftingNew) {
    draftModelExplicit = true
    if (settings !== undefined) draftModelSettingsEdited = true
    else if (!sameModel) draftModelSettingsEdited = false
    knownSessionModel = selected
    rememberWebComposer({ model: knownSessionModel })
    notice.setText(t('app.notice.newSessionModel'))
    notice.setKind('')
    renderControls()
    return true
  }
  if (!session) return false
  const epoch = selection
  modelChangePending = true
  renderControls()
  try {
    const applied = await session.setModel({
      slot: 'primary',
      route: option.route,
      model: option.id,
      thinking: selected.settings?.thinking ?? null,
      contextWindow: selected.settings?.contextWindow ?? null,
    })
    if (current !== session || selection !== epoch || sessionPending) return false
    modelSelectionSeq = applied.effectiveFromSeq
    knownSessionModel = selected
    rememberWebComposer({ model: knownSessionModel })
    initialModelPending = undefined
    notice.setText(t('app.notice.modelSaved'))
    notice.setKind('')
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
  firstRun.updated(saved)
  notice.setKind('')
  accountProvider = saved.provider
  accountLabels = new Map(
    (saved.accounts ?? []).map((row) => [row.route, `${row.label} · ${row.providerId}`]),
  )
  await modelRefresh.request()
  const savedModels = runtimeModels
  const published = savedModels.some(
    (entry) =>
      entry.route === (saved.provider?.route ?? saved.provider?.id) && entry.id === saved.provider?.model,
  )
  if (!saved.configured && !savedModels.length) {
    notice.setText(t('app.model.noAccounts'))
    return
  }
  if (saved.effect === 'restart-required' || !published) {
    notice.setText(t('app.model.savedNotEffective'))
    return
  }
  notice.setText(firstRun.active ? '' : t('app.model.savedNotice'))
}
onWindowFocus(() => {
  if (connected)
    run(async () => {
      await list()
      if (settingsRegion.active() === 'archived') await sessionActions.loadArchived()
    })
})
const { appearance, skins: skinGroup } = createAppearanceController({
  locale: clientModules.locale,
  // The roster source reads the profile before config.get() has reported it.
  profile: () => profileName,
  listSkins: (profile) => client.skins.list(profile),
})
clientModules.locale.subscribe(() => {
  renderControls()
  updateSidebar()
  skinGroup.sync()
})

/**
 * The workspace the admin panes are scoped to: the workbench's current one, else the one the
 * address named. Only a canonical 64-hex directory id is passed on.
 */
function paneWorkspaceId(): string | undefined {
  const id = selectedWorkspace?.workspaceId
  return id && /^[a-f0-9]{64}$/.test(id) ? id : requestedWorkspaceId
}

const candidateSources = {
  sessionTitle: async (id: string) =>
    sessionTitles.get(id) ??
    (await client.session.list({ q: { prefix: id }, limit: 100 })).items.find((row) => row.sessionId === id)
      ?.title,
  sessionTurnTime: async (id: string, turn: number) =>
    (
      await client.call<UITimeline>('_agnes/v1/session.projectUI', { sessionId: id, surface: 'web' })
    ).turns.find((row) => row.turn === turn)?.startedAt,
}

const adminPaneController = createAdminPaneController({
  store: adminPanes,
  settings: settingsRegion,
  workspaceId: paneWorkspaceId,
  errorText: (error) =>
    errorNotice(
      error instanceof Error ? error.message : t('app.admin.openFailed'),
      undefined,
      undefined,
      undefined,
      undefined,
      t,
    ),
  async mountPlugin() {
    const { mountPluginAdmin } = await import('@agnes/web-admin/admin/plugins/admin')
    return mountPluginAdmin({
      candidateSessionTurnTime: candidateSources.sessionTurnTime,
      candidateSessionTitle: candidateSources.sessionTitle,
      actualSlots: clientModules.actualSlots,
      runtime: clientModules.reconciler,
      schedules: {
        list: (params) => client.call('_agnes/v1/schedules.list', params),
        upsert: (params) => client.call('_agnes/v1/schedules.upsert', params),
        archive: (params) => client.call('_agnes/v1/schedules.archive', params),
        sessionKey: () => current?.id,
      },
    })
  },
  async mountResources(scope) {
    const { mountResourceAdmin } = await import('@agnes/resource-control-web/admin')
    return adaptResourceAdmin(mountResourceAdmin(scope), scope, candidateSources)
  },
})

function handleComposerWorkspace(): void {
  composerController.handleComposerWorkspace()
}
function handleComposerCancel(): void {
  commandController.handleComposerCancel()
}
function handleQueuedAction(itemId: string, kind: 'sendNow' | 'removeQueued'): void {
  commandController.handleQueuedAction(itemId, kind)
}

function refreshSessionControls(session: Session): Promise<void> {
  return commandController.refreshSessionControls(session)
}
function handleChildControl(id: string, action: 'stop' | 'continue', text?: string): Promise<void> {
  return commandController.handleChildControl(id, action, text)
}
function handlePauseResume(): void {
  commandController.handlePauseResume()
}
function handleEditQueued(itemId: string, text: string): Promise<void> {
  return commandController.handleEditQueued(itemId, text)
}

function handleComposerDraftChange(value: string): void {
  composerController.handleComposerDraftChange(value)
}
function imageSubmissionFrameBytes(
  sessionId: string,
  content: ContentBlock[],
  steer: boolean,
  references: readonly ReferenceSelection[] = [],
): number {
  return submissionController.imageSubmissionFrameBytes(sessionId, content, steer, references)
}
function isPlanCommand(input: string): boolean {
  return submissionController.isPlanCommand(input)
}
function prepareComposerSession(): Promise<Session> {
  return submissionController.prepareComposerSession()
}

function submitComposer(): void {
  submissionController.submitComposer()
}
const diagnostics = createDiagnosticsDialog({
  call: (method, params) => client.call(method, params),
  context: () => ({
    sessionId: current?.id ?? null,
    sessionTitle: sessionTitles.get(current?.id ?? '') ?? null,
    projection,
    projectionHasEarlier: live?.hasEarlier() ?? false,
  }),
})
sessionViewCommands.reportProblem = (trigger) => diagnostics.open(trigger)
const stopConnectionEvents = bindConnectionEvents(appSessionContext, {
  reconnect,
  setConnection,
  async refresh() {
    await modelRefresh.request()
    await list()
    scheduleClientRosterRead()
  },
  recover(message) {
    if (!sessionRecovery) return false
    renderSessionRecovery(message)
    return true
  },
})
/** Gap and generation notices name their session; another session's are not this view's concern. */
const forCurrent = (payload: unknown): boolean =>
  current !== undefined && (payload as { sessionId?: unknown } | undefined)?.sessionId === current.id
client.on('gap', (payload) => {
  if (!forCurrent(payload)) return
  const message = t('app.gap.partial')
  if (sessionRecovery) renderSessionRecovery(message)
  else notice.setText(message)
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
onPageVisible(() => {
  reconnect.resume()
  void list().catch(showError)
  void modelRefresh.request().catch(showError)
  scheduleClientRosterRead()
})
onHistoryNavigation(() => {
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
  await refreshSessionCatalog()
  await refreshModels()
}
const refreshInterval = shellConfig.modelRefreshIntervalMs
const modelRefresh = createRefreshCoordinator({
  refresh: refreshModelConfiguration,
  canPoll: () => connected && pageVisible(),
  ...(refreshInterval === undefined ? {} : { intervalMs: refreshInterval }),
})
const sessionConfigurationChanged = () => void modelRefresh.request().catch(showError)
const stopSessionConfiguration = onBroadcast(
  'agnes:session-configuration-changed',
  sessionConfigurationChanged,
)
onPageHide(() => {
  intentionalClose = true
  stopConnectionEvents()
  stopSettingsTerminal()
  statusCheck.dispose()
  stopHomeRouting()
  for (const stop of stopHomeSelection) stop()
  sessionSearch.dispose()
  homePages.dispose()
  removeHomeEntries()
  newSessionDialog.dispose()
  unbindDialogSheets()
  unmountIntelligentUi()
  firstRun.dispose()
  const dockHost = dockControlsHost
  if (dockHost) unmountWorkbench(dockHost)
  unmountAppShell()
  modelRefresh.stop()
  stopSessionConfiguration()
  reconnect.cancel()
  titleRefresh.close()
  void (stopEvents?.() ?? Promise.resolve()).finally(() => client.close())
})

run(async () => {
  const startupSelection = selection
  setConnection('connecting')
  if (!wsUrl) throw new Error(t('app.ws.unavailable'))
  // A first connection that fails never reports `closed`; the page may hold a stale daemon address.
  try {
    await client.initialize()
  } catch (error) {
    if (!intentionalClose) reconnect.start()
    throw error
  }
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
  // The sidebar can show usable sessions while models are slow. Navigation and draft defaults
  // still wait for models, then workspaces; failures are isolated to their own read.
  const [models, workspaces, sessions] = await Promise.allSettled([
    refreshModels(),
    client.workspace.list(),
    list(),
  ])
  if (models.status === 'rejected') showError(models.reason)
  if (workspaces.status === 'fulfilled') {
    applyWorkspaces(workspaces.value)
    // A link that names a workspace selects it, unless the reader has already chosen one.
    const requested = workspaceRows.find((row) => row.workspaceId === requestedWorkspaceId)
    if (requested && !selectedWorkspace && selection === startupSelection) {
      selectedWorkspace = requested
      updateWorkspaceOptions()
    }
  } else showError(new Error(t('app.workspaceList.unreadable'), { cause: workspaces.reason }))
  if (sessions.status === 'rejected') throw sessions.reason
  const page = sessions.value
  // A user choice also owns whether the account setup dialog may open.
  if (selection !== startupSelection) return
  if (models.status === 'fulfilled' && !configured && snapshot.accounts?.length) {
    renderControls()
    notice.setText(t('app.firstRun.configure'))
    await settings.open()
  }
  const guided =
    !startupRequest.get('settings') &&
    !startupRequest.get('session') &&
    needsFirstRun(snapshot) &&
    page.items.length === 0
  // A user selection made while startup was loading owns the current view.
  if (selection !== startupSelection) return
  const selected = new URL(location.href).searchParams.get('session')
  if (startupRequest.get('new') === '1') {
    await beginNewDraft(configured)
    if (requestedLoop) {
      const match = newSessionCatalog?.loops.find((entry) => `${entry.id}@${entry.version}` === requestedLoop)
      if (!match) throw new Error(settingsText('notAllowed'))
      draftLoop = { id: match.id, version: match.version }
      draftLoopEdited = true
    }
    if (requestedPreset) {
      if (!runtimeCatalog?.presets.some((entry) => entry.id === requestedPreset))
        throw new Error(settingsText('notAllowed'))
      draftPreset = requestedPreset
      syncDraftPermission()
    }
    if (requestedBundles.length) {
      if (
        new Set(requestedBundles).size !== requestedBundles.length ||
        requestedBundles.length > 64 ||
        requestedBundles.some((id) => !runtimeCatalog?.bundles?.some((bundle) => bundle.id === id))
      )
        throw new Error(settingsText('bundleUnavailable'))
      draftBundles = requestedBundles
    }
    if (requestedPrompt) composerRuntime.setDraft(requestedPrompt)
    renderControls()
    await firstRun.initialize(snapshot, true)
    return
  }
  const startupSettings = startupRequest.get('settings') ?? ''
  // A link to the old history or archive page opens the sidebar's search or archived list instead.
  const startupMoved = movedSettingsTarget(startupSettings)
  const startupSection = startupMoved ? undefined : settingsSections.get(settingsRoute(startupSettings).id)
  if (selected) {
    const candidates = page.items.some((item) => item.sessionId === selected)
      ? page
      : await client.session.list({ q: { prefix: selected }, limit: 100 })
    if (candidates.items.some((item) => item.sessionId === selected)) await open(selected)
    else {
      notice.setText(t('app.session.notFound'))
      renderControls()
    }
  } else {
    const first = page.items.find((item) => !item.archived)
    if (first) await open(first.sessionId)
    else await beginNewDraft(configured && !startupSection && !guided)
  }
  const factCandidate = startupRequest.get('factCandidate')
  if (
    selected &&
    current?.id === selected &&
    factCandidate &&
    /^candidate-[a-f0-9]{32}$/.test(factCandidate)
  ) {
    requestAnimationFrame(() =>
      factChainLinks.open({
        sessionId: selected,
        laneId: 'main',
        anchor: { kind: 'authoring', candidateId: factCandidate },
      }),
    )
  }
  const shown = await firstRun.initialize(snapshot, page.items.length > 0 || Boolean(startupSection))
  if (guided && !shown) await beginNewDraft(true)
  if (startupMoved)
    openMovedSettingsLink(startupSettings, {
      searchSessions: () => sessionSearch.open(),
      showArchived: () => archivedSessions.show('archived'),
    })
  if (startupSection && new URL(location.href).searchParams.get('settings') === startupSettings) {
    settingsRegion.open('model')
    await settings.open()
    if (new URL(location.href).searchParams.get('settings') !== startupSettings) return
    const anchoredSettings = startupSettingsAnchor.replace(/^settings-subsection-/, '')
    const anchoredRoute = settingsRoute(anchoredSettings)
    const target =
      anchoredRoute.id === startupSettings && anchoredRoute.anchor === startupSettingsAnchor
        ? anchoredSettings
        : startupSettings
    settingsRegion.route(target)
  }
})
