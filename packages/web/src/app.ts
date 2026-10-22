import { defaultLoop, defaultModelAdapter } from '@agnes/protocol'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import { createFirstRunController, needsFirstRun } from '@agnes/web-admin/first-run'
import { factChainLinks, workbenchNavigation } from '@agnes/web-client'
import {
  appServerErrorMessage,
  bindDialogSheets,
  createCatalogTranslator,
  preserveRouteParams,
  reportSuccess,
  searchParamRoute,
} from '@agnes/web-ui'
import { settingsRoute, sortSessionsByRecency, untitledSessionLabel } from '@agnes/web-units/shell'
import { createAppearanceController } from './app/appearance-controller.js'
import { type ApplySessionControls, createCommandController } from './app/command-controller.js'
import { createComposerController } from './app/composer-controller.js'
import { bindConnectionEvents } from './app/connection-events.js'
import {
  broadcast,
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
import { SessionBindingOwner } from './app/session-owner.js'
import { createSubmissionController } from './app/submission-controller.js'
import { SubmissionOwner } from './app/submission-owner.js'
import { createTurnController } from './app/turn-controller.js'
import { openApplicationHome, projectApplication, requestNewSession } from './application.js'
import { readyRosterModules } from './client-modules/reconcile/roster.js'
import { ComposerDrafts } from './composer-drafts.js'
import '@agnes/web-admin/settings/registry'
import type {
  ConfigSnapshot,
  ModelSettings,
  PageSessionMeta,
  UITimeline,
  UITurn,
  WorkspaceEntry,
} from '@agnes/protocol'
import {
  createClient,
  JsonRpcError,
  localStorageJournal,
  type PermissionOutcome,
  type PermissionRequest,
  type Session,
} from '@agnes/sdk/browser'

import { type PermissionMode, permissionLabel, yoloEnabled } from '@agnes/web-admin/permission-picker'
import { createSettingsController } from '@agnes/web-admin/settings'
import { loadAuxiliaryModelDefaults, loadRuntimeCatalog } from '@agnes/web-admin/settings/api'
import { settingsCatalog } from '@agnes/web-admin/settings/locales'
import { mountStatusCheck } from '@agnes/web-admin/settings/status-check'
import { homeEntries, homeNavigation, settingsSections } from '@agnes/web-client'
import type { LiveProjection } from '@agnes/web-conversation/live-projection'
import { errorNotice, type KnownSessionModel, type Translate } from '@agnes/web-conversation/presentation'
import { workbenchLocaleCatalog } from '@agnes/web-conversation/workbench'
import { installBrowserLogCapture } from '@agnes/web-foundation/browser-log'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { attachmentErrorMessage } from '@agnes/web-units/shell'
import { createWorkspaceController } from './app/workspace-controller.js'
import { appNotice, setConnectionNotice, setReconnectNotice } from './app-notices.js'
import { mountAppShell } from './app-shell.js'
import { type ClaimResolver, startClientModules } from './client-modules/boot.js'
import { startPluginHotReload } from './client-modules/hot-reload.js'
import { bindJobsClient } from './client-modules/jobs.js'
import type { RosterSource } from './client-modules/reconcile.js'
import { readWebComposerMemory, rememberWebComposer, selectionFromMemory } from './composer-memory.js'
import { composerReferences } from './composer-references.js'
import { createDiagnosticsDialog } from './diagnostics-dialog.js'
import {
  type LoopSelection,
  loadNewSessionCatalog,
  loadNewSessionComposition,
  loopIdentity,
  type NewSessionCatalog,
} from './loop-picker.js'
import type { ModelPickerOption } from './model-picker.js'
import { businessAgentSuggestions } from './pages/business-agents.js'
import { registerBuiltinHomeEntries } from './pages/entries.js'
import { activeHomeEntry, bindHomeRouting, mountHomePages } from './pages/host.js'
import { bootstrapProbe, createReconnectController, type ReconnectPhase } from './reconnect.js'
import { coalesceBurst, createRefreshCoordinator } from './refresh-coordinator.js'
import { SESSION_SEARCH_EVENT } from './regions/session-tools.js'
import { sessionViewCommands } from './regions/session-views.js'
import { createSessionActions } from './session-actions.js'
import { sessionInventory } from './session-inventory.js'
import {
  allowedPermissionLevels,
  draftPermissionMode,
  isPermissionLevel,
  newSessionRequest,
  openSessionMode,
  permissionLevel,
  permissionModeOf,
  sessionPermissionLevel,
} from './session-permission.js'
import { mountSessionSearch } from './session-search.js'
import { createTitleRefresh } from './session-title.js'
import {
  clearSettingsLink,
  consumeSettingsLink,
  movedSettingsTarget,
  needsModelNotice,
  openMovedSettings,
  openMovedSettingsLink,
  rewriteMovedSettingsLink,
} from './settings-redirects.js'
import { createSidebarPagination } from './sidebar-pagination.js'
import { readTraceFactChain } from './trace-facts.js'
import type { RunReceipt, WebView } from './view.js'
import { unmountWorkbench } from './workbench/dock.js'
import { requestWorkspacePicker } from './workspace-picker.js'

installBrowserLogCapture()
const { hosts, config: shellConfig, dispose: unmountAppShell } = mountAppShell()

const unbindDialogSheets = bindDialogSheets(document)
// An old link to a page that left settings opens that page's new home.
rewriteMovedSettingsLink()

/** Controllers consume the selected binding through its owner. */
export interface AppSessionContext {
  SESSION_WATCH_STOP_TIMEOUT_MS: typeof SESSION_WATCH_STOP_TIMEOUT_MS
  TRACE_THROTTLE_MS: typeof TRACE_THROTTLE_MS
  approvalBusy: typeof approvalBusy
  approvalRuntime: typeof approvalRuntime
  approvalSearch: typeof approvalSearch
  approvalSearchTicket: typeof approvalSearchTicket
  beginNewDraft: typeof beginNewDraft
  clearSessionRecovery: typeof clearSessionRecovery
  client: typeof client
  clientModules: typeof clientModules
  composerDraftKey: string
  selectComposerDraft: typeof selectComposerDraft
  invalidateSessionRuntime(id: string): void
  composerRuntime: typeof composerRuntime
  configured: typeof configured
  connected: typeof connected
  controlsHistory: typeof controlsHistory
  conversationRuntime: typeof conversationRuntime
  readonly submissions: SubmissionOwner
  readonly sessionBinding: Pick<SessionBindingOwner, 'capture' | 'isCurrent' | 'targetId'>
  readonly current: Session | undefined
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
  readonly live: LiveProjection | undefined
  liveApproval: typeof liveApproval
  loopCatalogError: typeof loopCatalogError
  loopCatalogPending: typeof loopCatalogPending
  modelChangePending: typeof modelChangePending
  modelDefaults: typeof modelDefaults
  modelSelectionSeq: typeof modelSelectionSeq
  moduleSessionId: typeof moduleSessionId
  newSessionCatalog: typeof newSessionCatalog
  notice: typeof notice
  open: typeof open
  openNewSessionDialog(transitioning?: boolean): void
  pendingSessionKey: typeof pendingSessionKey
  permissionChangePending: typeof permissionChangePending
  permissionConnectionEpoch: typeof permissionConnectionEpoch
  permissionMode: typeof permissionMode
  permissionRefreshPending: typeof permissionRefreshPending
  permissionSelectionSeq: typeof permissionSelectionSeq
  projection: typeof projection
  receipts: typeof receipts
  recoveredReturns: typeof recoveredReturns
  recoveryDisabled: typeof recoveryDisabled
  references: typeof references
  refreshSessionControls: typeof refreshSessionControls
  readSessionControls: typeof readSessionControls
  render: typeof render
  renderControls: typeof renderControls
  renderNewSessionControls(): void
  renderer: typeof renderer
  run: typeof run
  sessionIsolation: typeof sessionIsolation
  runtimeCatalog: typeof runtimeCatalog
  runtimeModels: typeof runtimeModels
  draftSessionRequest: typeof draftSessionRequest
  selectedModelAvailable: typeof selectedModelAvailable
  selectedWorkspace: typeof selectedWorkspace
  sessionControls: typeof sessionControls
  sessionPending: typeof sessionPending
  sessionRows: typeof sessionRows
  sessionTitles: typeof sessionTitles
  sessionYoloEnabled: typeof sessionYoloEnabled
  settingsText: typeof settingsText
  showError: typeof showError
  showSessionRecovery: typeof showSessionRecovery
  stopAfterSeq: typeof stopAfterSeq
  stopping: typeof stopping
  streamFrame: typeof streamFrame
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
const sessionBinding = new SessionBindingOwner()
const submissions = new SubmissionOwner(sessionBinding)
const appSessionContext: AppSessionContext = {
  invalidateSessionRuntime: (id) => sessionActions.invalidateRuntime(id),
  sessionBinding,
  submissions,
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
  get beginNewDraft() {
    return beginExplicitNewDraft
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
    return composerDrafts.key
  },
  get selectComposerDraft() {
    return selectComposerDraft
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
  get controlsHistory() {
    return controlsHistory
  },
  get conversationRuntime() {
    return conversationRuntime
  },
  get current() {
    return sessionBinding.session
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
    return sessionBinding.live
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
  get open() {
    return open
  },
  get openNewSessionDialog() {
    return workspaceController.open
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
  get receipts() {
    return receipts
  },
  get recoveredReturns() {
    return recoveredReturns
  },
  get recoveryDisabled() {
    return recoveryDisabled
  },
  get references() {
    return references
  },
  get refreshSessionControls() {
    return refreshSessionControls
  },
  get readSessionControls() {
    return readSessionControls
  },
  get render() {
    return render
  },
  get renderControls() {
    return renderControls
  },
  get renderNewSessionControls() {
    return workspaceController.renderControls
  },
  get renderer() {
    return renderer
  },
  get run() {
    return run
  },
  get sessionIsolation() {
    return sessionIsolation
  },
  set sessionIsolation(value: typeof sessionIsolation) {
    sessionIsolation = value
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
  get draftSessionRequest() {
    return draftSessionRequest
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
const sessionController = createSessionController(appSessionContext, sessionBinding)
const turnController = createTurnController(appSessionContext)
const readOnlyController = createReadOnlyController(appSessionContext, {
  open: (id) => open(id),
  beginNewDraft: () => beginExplicitNewDraft(),
})

const composerDrafts = new ComposerDrafts(sessionStorage, location.origin)
// Keep image submissions below the daemon's WebSocket frame cap, including their JSON-RPC envelope.
const savedComposerDraft = composerDrafts.read()
const notice = appNotice
const conversation = hosts.conversation
const goalHost = hosts.goal
const wsUrl = shellConfig.wsUrl
const client = createClient({
  sessionRestoreHistory: 'none',
  transport: { kind: 'ws', url: wsUrl ?? '', protocols: ['agnes-v1'] },
  auth: { kind: 'local' },
  journal: localStorageJournal(sessionStorage, `agnes-web-commands:${wsUrl ?? location.origin}`),
})
onPageHide(
  bindJobsClient({
    client,
    current: () => sessionBinding.session?.id,
    untitled: (id, createdAt) =>
      sessionLabels.get(id) ||
      untitledSessionLabel(t('nav.sessionFallback'), createdAt, document.documentElement.lang || 'en'),
  }),
)
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
let profileName = ''
let moduleSessionId: string | undefined
const rosterSource: RosterSource = {
  identity: () => JSON.stringify([profileName, moduleSessionId, sessionBinding.generation]),
  commit(roster) {
    projectApplication(roster.application)
    moduleExtIds.clear()
    for (const mod of roster.modules) moduleExtIds.set(mod.rowId ?? mod.packageId, mod.extIds)
    for (const listener of customModuleListeners) listener()
  },
  async list() {
    if (!profileName) return { revision: '', modules: [], statuses: [] }
    // These reads can cross an upgrade: the role registry admits only the roster binding
    // matching the full consent identity, synchronously before every mount.
    const [roster, application] = await Promise.all([
      client.clientModules.list(profileName, moduleSessionId),
      client.request('_agnes/v1/applications.get', { profile: profileName }).catch(() => undefined),
    ])
    // `rows` is the authoritative browser lifecycle surface.  The legacy
    // `modules` compatibility projection deliberately cannot carry every
    // immutable declaration, including the per-module service allow-list.
    const modules = readyRosterModules(roster.rows ?? [])
    return {
      ...(application ? { application } : {}),
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
const references = composerReferences(prepareComposerSession, renderControls)

// Reserve host entries before installed modules can register their reviewed declarations.
const removeHomeEntries = registerBuiltinHomeEntries()
homeEntries.subscribe(openApplicationHome)
const clientModules = await startClientModules({
  agnes: client,
  presentation: {
    revealConversation: () => tracePanel.setOpen(false),
    focusApproval: () => {
      searchApproval()
      approvalRuntime.focus()
    },
    async listComponents(sessionId) {
      if (!profileName) return []
      return (await client.clientModules.list(profileName, sessionId)).rows ?? []
    },
    subscribeComponents(listener) {
      customModuleListeners.add(listener)
      return () => {
        customModuleListeners.delete(listener)
      }
    },
  },
  claim: claimSlotCard,
  clientProfileCaller: async (module, service, input, options) => {
    const response = await fetch('/api/client-modules/profile', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        rowId: module.rowId ?? module.packageId,
        service,
        ...(input === undefined ? {} : { input }),
        ...options,
      }),
    })
    if (!response.ok) throw new Error(t('app.plugin.serviceUnavailable'))
    return response.json()
  },
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
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const failure = (body as { error?: { code?: unknown; data?: { code?: unknown } } } | null)?.error
      if (typeof failure?.code === 'number' && typeof failure.data?.code === 'string')
        throw new JsonRpcError({
          code: failure.code,
          message: t('app.plugin.effectUnavailable'),
          data: { code: failure.data.code },
        })
      throw new Error(t('app.plugin.effectUnavailable'))
    }
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
        requestNewSession()
        run(() => beginNewDraft(workspace === undefined, workspace))
      },
      addWorkspace: () =>
        run(async () => {
          requestNewSession()
          if (!draftingNew) await beginNewDraft()
          workspaceController.open()
        }),
      openSettings: () => {
        settingsRegion.open('model')
        run(() => settings.open())
      },
      openSession: (id) =>
        run(async () => {
          homeNavigation.close()
          // The session already showing behind a page needs no second open.
          if (id !== sessionBinding.session?.id || draftingNew) await open(id)
          clientModules.sidebar?.close()
        }),
      workspaceAction: async (action, workspace) => {
        if (action === 'reveal') {
          await client.call(
            '_agnes/v1/workspace.reveal',
            workspace.workspaceId ? { workspaceId: workspace.workspaceId } : { path: workspace.path },
          )
          return
        }
        await workspaceController.remove(workspace)
      },
      sessionAction: (action, id, title, trigger) => {
        // Restoring is the inventory's own channel: it owns the request, the row and the notice.
        if (action === 'unarchive') {
          void sessionInventory.restore(id)
          return
        }
        void sessionActions.act(action, id, title, trigger)
      },
      loadMore: () =>
        run(async () => {
          await list()
        }),
      groupAction: (id, action) => {
        void sidebarPages.action(id, action)
      },
      refreshGroups: () => {
        void list(undefined, true).catch(showError)
      },
    },
  },
  transcript: {
    onFork: forkTurn,
    turnErrorActions: { onRetry: retryTurn, onOpenSettings: openErrorSettings },
  },
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
    onPromoteQueued: (itemId) => handleQueuedAction(itemId, 'promote'),
    onRemoveQueued: (itemId) => handleQueuedAction(itemId, 'removeQueued'),
    onWorkspace: handleComposerWorkspace,
    onWorkspaceSelect: (workspace) => workspaceController.select(workspace),
    onWorkspaceRemove: (workspace) => run(() => workspaceController.remove(workspace)),
  },
  traceContainer: hosts.trace,
  trace: {
    toggle: hosts.viewTrace,
    chatToggle: hosts.viewChat,
    conversation,
    clearModelRequest: async (params) => {
      if (!sessionBinding.session || sessionBinding.session.id !== params.sessionId)
        throw new Error(t('app.trace.sessionSwitched'))
      return client.requestTrace.clear(params)
    },
    readFactChain: (params, signal) =>
      readTraceFactChain(
        sessionBinding.session,
        params,
        () => new Error(t('app.trace.sessionSwitched')),
        signal,
      ),
    loadArtifact: (input) => clientModules.resources.files.load(input),
    readModelRequest: async (params, signal) => {
      if (!sessionBinding.session || sessionBinding.session.id !== params.sessionId)
        throw new Error(t('app.trace.sessionSwitched'))
      if (signal?.aborted) throw new Error(t('app.trace.sessionSwitched'))
      return client.requestTrace.get(params)
    },
    readToolDetail: async (sessionId, callSeq, resultSeq, signal) => {
      const session = sessionBinding.session
      if (!session) throw new Error(t('app.trace.noSession'))
      if (session.id !== sessionId) throw new Error(t('app.trace.sessionSwitched'))
      return session.readToolDetail(callSeq, resultSeq, signal ? { signal } : undefined)
    },
  },
  rightbarContainer: hosts.rightbar,
  settingsPaneContainer: hosts.settings,
  settings: {
    sections: settingsSections,
    // A page that left settings was asked for by name: close the dialog and open its new home.
    onMoved: (target) => {
      settings.close()
      openMovedSettings(target, {
        openPage: (page, tab) => homeNavigation.open(page, tab ? { tab } : undefined),
        searchSessions: () => sessionSearch.open(),
        showArchived: () => sessionInventory.setMode('archived'),
      })
    },
    onChange: ({ pane }) => {
      if (pane === 'model') void settings.open()
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
// Every «在轨迹中查看» link (requests, tools, changes, deliverables, feedback) opens the trace.
factChainLinks.register((target) => tracePanel.focusFact?.(target) ?? false)
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
// The sidebar's application switch asks for the settings page in place; its href stays the fallback.
const stopSurfaceSettings = onSurfaceEvent('agnes:open-settings', (event) => {
  const section = (event as CustomEvent<{ section?: string }>).detail?.section
  if (!section) return
  event.preventDefault()
  settingsRegion.open('model')
  run(async () => {
    await settings.open()
    settingsRegion.route(section)
  })
})
// Home entries open full pages in the main area; the built-in three register like any plugin's.
const homePages = mountHomePages(hosts.homePage, {
  locale: clientModules.locale,
  data: {
    call: (method, params) => client.call(method, params),
    sessionId: () => sessionBinding.session?.id,
    openSettings: (section) =>
      run(async () => {
        settingsRegion.open('model')
        await settings.open()
        settingsRegion.route(section)
      }),
    startDraft: (prompt) =>
      run(async () => {
        requestNewSession()
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
topbarRuntime.setStopAction(handleComposerCancel)
const approvalRuntime = clientModules.approval as NonNullable<typeof clientModules.approval>
if (!approvalRuntime) throw new Error('missing approval region')
const composerRuntime = clientModules.composer as NonNullable<typeof clientModules.composer>
if (!composerRuntime) throw new Error('missing composer region')
const conversationRuntime = clientModules.conversation as NonNullable<typeof clientModules.conversation>
if (!conversationRuntime) throw new Error('missing conversation region')
const renderer = clientModules.transcript as NonNullable<typeof clientModules.transcript>
if (!renderer) throw new Error('missing transcript region')

// 渲染时取词：t 只在渲染/组装瞬间调用；语言切换后由订阅重跑渲染函数，命令式区域整体重建。
const t: Translate = (key, vars) => clientModules.locale.t(key, vars)
const workspaceController = createWorkspaceController(appSessionContext, hosts.newSession)
setLocaleTranslator(t)
clientModules.locale.register('@agnes/web-workbench', workbenchLocaleCatalog)

// A daemon notice is only an invalidation hint. Every read goes back through the SDK roster
// endpoint, and a failed read leaves the sessionBinding.session page/modules intact for the next hint.
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
let sessionControls: { sessionId: string; value: SessionControlStateResult } | undefined
const recoveredReturns = new Set<string>()
const controlsHistory = new Map<
  string,
  { through: number; facts: NonNullable<SessionControlStateResult['facts']> }
>()
const childControlRefreshTimer = setInterval(() => {
  const session = sessionBinding.session
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
let listGeneration = 0
// The window's first node is the session's first, so its first user message titles the task.
let windowAtStart = true
// A session that cannot continue on this build, shown from its record alone.
let readOnly: { id: string; maxNodes: number; hasEarlier: boolean } | undefined
let approvalSearch: 'idle' | 'searching' | 'not-found' = 'idle'
let approvalSearchTicket: string | undefined
let streamFrame: number | undefined
let stopping = false
let sessionPending = new URLSearchParams(location.search).get('new') === '1'
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
// The level chosen in this draft's permission control; the recipe in `draftPreset` is independent.
let draftPermission: PermissionMode | undefined
let draftBundles: string[] = []
let sessionIsolation: { sessionId: string; disabled: boolean } | undefined
let runtimeCatalog: import('@agnes/protocol').RuntimeAdminSnapshot | undefined
const startupRequest = new URLSearchParams(location.search)
// Settings and nested pages keep their address across reload and history traversal.
const startupSettingsLink = consumeSettingsLink()
const startupSettingsAnchor = startupSettingsLink.anchor
let startupSettingsDismissed = false
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
function draftPermissionInput() {
  return {
    explicit: draftPermission,
    remembered: readWebComposerMemory()?.permission,
    preset: draftPreset,
    defaults: newSessionCatalog?.defaults,
    runtime: runtimeCatalog,
  }
}
function draftSessionRequest() {
  return newSessionRequest(draftPermissionInput())
}
function syncDraftPermission(): void {
  permissionMode = draftPermissionMode(draftPermissionInput())
}
async function refreshSessionCatalog(): Promise<void> {
  // Only the new-session composer consumes these admin catalogs.
  if (!draftingNew || homeNavigation.getSnapshot() || !pageVisible()) return
  const generation = ++sessionCatalogGeneration
  loopCatalogPending = !newSessionCatalog
  renderControls()
  try {
    const [catalog, runtime] = await Promise.all([
      loadNewSessionCatalog(fetch, false),
      loadRuntimeCatalog().catch(() => undefined),
    ])
    if (generation !== sessionCatalogGeneration) return
    newSessionCatalog = catalog
    runtimeCatalog = runtime
    loopCatalogError = false
    if (draftingNew && !draftLoopEdited) draftLoop = defaultLoop(newSessionCatalog.defaults)
    if (draftingNew) syncDraftPermission()
    void loadNewSessionComposition()
      .then((composition) => {
        if (generation !== sessionCatalogGeneration || !newSessionCatalog) return
        newSessionCatalog = { ...newSessionCatalog, ...(composition ? { composition } : {}) }
        renderControls()
      })
      .catch(() => undefined)
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
// daemon 自己报出的 profile（config.get() 后才知道）；皮肤清单与客户端模块名册都必须把它传回去。
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
  sidebarPages.patch(row)
  sessionInventory.patch(row)
  updateTitle(id, row.title)
  return true
})
function updateTitle(id: string, title: string): void {
  sessionLabels.set(id, title)
  if (sessionBinding.session?.id === id) topbarRuntime.setTaskTitle(title)
  updateSidebar()
}
let runtimePlatform: string | undefined
let sessionRows: PageSessionMeta['items'] = []
let workspaceRows: WorkspaceEntry[] = []
const sidebarPages = createSidebarPagination(
  client.session,
  () => {
    const selected = sessionRows.find((row) => row.sessionId === (sessionBinding.session?.id ?? readOnly?.id))
    sessionRows = sidebarPages.rows()
    if (selected && !sessionRows.some((row) => row.sessionId === selected.sessionId))
      sessionRows.push(selected)
    updateSidebar()
  },
  (error) => {
    const failure = error as { code?: number; data?: { code?: string }; message?: string }
    return failure.code === -32601 ||
      failure.data?.code === 'SESSION_SIDEBAR_UNAVAILABLE' ||
      failure.message === 'SESSION_SIDEBAR_UNAVAILABLE'
      ? t('nav.upgrade')
      : errorNotice(
          error instanceof Error ? error.message : String(error),
          undefined,
          undefined,
          undefined,
          undefined,
          t,
        )
  },
)
let selectedWorkspace: WorkspaceEntry | undefined
let draftingNew = false
let pendingSessionKey: string | undefined
let liveApproval:
  | { request: PermissionRequest; afterSeq: number; finish(value: PermissionOutcome): void }
  | undefined

function updateSidebar(): void {
  clientModules.sidebar?.update({
    sessions: sidebarPages.rows(),
    paging: sidebarPages.snapshot(),
    ...(runtimePlatform ? { runtimePlatform } : {}),
    workspaces: workspaceRows,
    labels: sessionLabels,
    locale: clientModules.locale.getSnapshot(),
    // While a home page shows, the page's entry is the selected item, not the session behind it.
    ...(activeHomeEntry()
      ? {}
      : sessionBinding.session
        ? { currentId: sessionBinding.session.id }
        : readOnly
          ? { currentId: readOnly.id }
          : {}),
    sessionPending,
    newDisabled: !connected || submissions.sending || sessionPending || workspaceController.creating,
  })
}

// Opening or leaving a home page, or losing its entry, moves the sidebar's selection.
const stopHomeSelection = [homeNavigation.subscribe(updateSidebar), homeEntries.subscribe(updateSidebar)]

const SESSION_WATCH_STOP_TIMEOUT_MS: number = 3000
function stopWithTimeout(stop: (() => Promise<void>) | undefined): Promise<boolean> {
  return sessionController.stopWithTimeout(stop)
}
const settings = createSettingsController({
  client,
  onSaved: savedConfiguration,
  onError: showError,
  onOpen: () => {
    const address = searchParamRoute('settings')
    if (!address.read().length)
      history.pushState(null, '', address.href([settingsRegion.form()?.dataset.settingsSection ?? 'model']))
  },
  onClose: () => {
    startupSettingsDismissed = true
    clearSettingsLink()
  },
})
const restoreSettingsLocation = () => {
  const moved = rewriteMovedSettingsLink()
  if (moved?.kind === 'page') {
    settings.close()
    homeNavigation.open(moved.page, moved.tab ? { tab: moved.tab } : undefined)
    return
  }
  const id = consumeSettingsLink().id
  if (!id) {
    if (settings.isOpen()) settings.close()
    return
  }
  if (movedSettingsTarget(id)) {
    openMovedSettingsLink(id, {
      searchSessions: () => sessionSearch.open(),
      showArchived: () => sessionInventory.setMode('archived'),
    })
    return
  }
  settingsRegion.route(id)
  if (!settings.isOpen()) run(() => settings.open())
}
const stopSettingsRouting = onHistoryNavigation(restoreSettingsLocation)
clientModules.locale.subscribe(() => settings.refreshLocale())
const firstRun = createFirstRunController({
  host: hosts.firstRun,
  banner: hosts.doctorNotice,
  client,
  storage: safeThemeStorage(),
  attachAccount: (host) => settings.attachInline(host),
  connectAccount: () => settings.submitInline(),
  selectDemo: async () => {
    await modelRefresh.request()
    const demo = runtimeModels.find((model) => model.route === 'demo' && model.id === 'demo-model')
    if (!demo) throw new Error(t('composer.hint.modelUnavailable'))
    rememberWebComposer({ model: demo })
  },
  chooseWorkspace: async (path, signal) => {
    if (!path) {
      const result = await requestWorkspacePicker(fetch, signal)
      if (result.status === 'cancelled') return undefined
      if (result.status === 'unavailable') throw new Error(t('app.newSession.pickerFailed'))
      path = result.path
    }
    await workspaceController.register(path.trim())
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
    requestNewSession()
    await beginNewDraft(true)
  },
  saved: savedConfiguration,
})
clientModules.locale.subscribe(() => firstRun.refreshLocale())
const sessionActions = createSessionActions({
  client,
  loopLabel: (id) => newSessionCatalog?.loops.find((loop) => loop.id === id)?.label,
  permissionOf: (id) => sessionRows.find((row) => row.sessionId === id)?.permission,
  changed: () => list(),
  renamed: (id, title) => {
    const row = sessionRows.find((item) => item.sessionId === id)
    if (row) {
      sidebarPages.patch({ ...row, title, titleSource: 'user' })
      sessionInventory.patch({ ...row, title, titleSource: 'user' })
    }
    updateTitle(id, title)
  },
  fork: (id, title) => {
    // The fork adds a row to whichever list is showing.
    sessionInventory.invalidate()
    return forkSidebar(id, title)
  },
  error: (error) => {
    clientModules.sidebar?.dismiss()
    showError(error)
  },
  archived: (id) => {
    // The cached full list still holds the row; a visible view reads again on invalidation.
    sessionInventory.invalidate()
    notice.setText(() => t('home.archived.notice'))
    const undo = {
      label: t('home.archived.undo'),
      run: () => {
        notice.setText('')
        void sessionInventory.restore(id)
      },
    }
    // While the row is hidden, the notice also offers the filter that shows it again.
    if (sessionInventory.getSnapshot().mode === 'active')
      notice.offerMany([
        undo,
        {
          label: t('home.archived.noticeAction'),
          run: () => {
            notice.setText('')
            sessionInventory.setMode('archived')
          },
        },
      ])
    else notice.offer(undo)
  },
  translate: t,
})
sessionInventory.bind({
  list: (params) => client.session.list(params),
  restore: (id) => client.session.archive(id, false),
  changed: () => list(),
  error: showError,
})
// Search finds a session by what was said in it; opening one leaves any home page.
const sessionSearch = mountSessionSearch({
  translate: t,
  recent: async () =>
    sortSessionsByRecency((await client.session.list({ limit: 100 })).items.filter((row) => !row.archived))
      .slice(0, 8)
      .map((row) => ({
        sessionId: row.sessionId,
        title: row.title || sessionLabels.get(row.sessionId) || '',
        workspace: row.cwd ?? '',
      })),
  titleOf: (id) => sessionRows.find((row) => row.sessionId === id)?.title || sessionLabels.get(id),
  open: (id) =>
    run(async () => {
      homeNavigation.close()
      // A live session opened from search has to be visible in the list behind it.
      const row = sessionRows.find((item) => item.sessionId === id)
      if (row && !row.archived && sessionInventory.getSnapshot().mode === 'archived')
        sessionInventory.setMode('active')
      if (id !== sessionBinding.session?.id || draftingNew) await open(id)
    }),
})
onSurfaceEvent(SESSION_SEARCH_EVENT, (event) =>
  sessionSearch.open(event.target instanceof HTMLElement ? event.target : undefined),
)
clientModules.locale.subscribe(() => sessionSearch.refreshLocale())
// Top bar entries for the selected session: its title renames it, the info button shows its runtime.
for (const action of ['rename', 'runtime'] as const)
  onSurfaceEvent(`agnes:${action}-current-session`, (event) => {
    if (!sessionBinding.session || draftingNew || sessionPending) return
    const trigger = event.target
    if (!(trigger instanceof HTMLElement)) return
    if (action === 'rename') {
      const title = trigger.textContent ?? ''
      topbarRuntime.editTitle({
        sessionId: sessionBinding.session.id,
        title,
        save: sessionActions.renameInline(sessionBinding.session.id, title),
      })
    } else void sessionActions.act(action, sessionBinding.session.id, trigger.textContent ?? '', trigger)
  })
onSurfaceEvent('agnes:compose-suggestion', (event) => {
  if ((sessionBinding.session && !draftingNew) || sessionPending || !(event instanceof CustomEvent)) return
  if (typeof event.detail !== 'string') return
  composerRuntime.setDraft(event.detail)
  composerRuntime.focus()
})
let sessionRecovery: { id: string; error: unknown } | undefined
function errorMessage(error: unknown): string {
  const attachment = attachmentErrorMessage(error, t)
  if (attachment) return attachment
  const publicMessage = appServerErrorMessage(error, clientModules.locale.getSnapshot())
  if (publicMessage) return publicMessage
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
        : diagnostic?.code,
    diagnostic?.reason,
    t,
  )
}
function showError(error: unknown): void {
  const message = () => errorMessage(error)
  const persistent =
    error &&
    typeof error === 'object' &&
    'data' in error &&
    (error.data as { code?: unknown } | undefined)?.code === 'CONFIG_CREDENTIAL_REJECTED'
  if (sessionRecovery) {
    renderSessionRecovery(message)
    notice.setKind('error')
  } else if (persistent) {
    notice.setText(message)
    notice.setKind('error')
  } else notice.error(message)
  if (workspaceController.dialog.open) workspaceController.dialog.update({ error: message() })
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
  workspaceController.dialog.update({ error: '' })
  if (sessionRecovery) renderSessionRecovery()
  else {
    notice.setText('')
    notice.setKind('')
  }
  void op().catch(showError)
}
function showSessionRecovery(error: unknown, id: string): void {
  sessionRecovery = { id, error }
  renderSessionRecovery()
}
function sessionRecoveryMessage(error: unknown): string {
  const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
  return data && typeof data === 'object' && 'code' in data && data.code === 'SESSION_PROFILE_MISSING'
    ? t('app.recovery.profileMissing')
    : data && typeof data === 'object' && 'reason' in data && data.reason === 'legacy-ledger-format'
      ? errorMessage(error)
      : t('app.recovery.openFailed', { detail: errorMessage(error) })
}
function recoveryDisabled(): boolean {
  return !connected || submissions.sending || sessionPending || workspaceController.creating
}
function renderSessionRecovery(message: string | (() => string) = ''): void {
  if (!sessionRecovery) return
  notice.recover({
    message: () => (sessionRecovery ? sessionRecoveryMessage(sessionRecovery.error) : ''),
    error: message,
    disabled: recoveryDisabled(),
    retry() {
      if (recoveryDisabled() || !sessionRecovery) return
      const id = sessionRecovery.id
      run(() => open(id))
    },
    create() {
      if (!recoveryDisabled()) run(() => beginExplicitNewDraft())
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
  const currentSessionId = clientModules.session.sessionId
  if (currentSessionId && clientModules.session.readiness.getSnapshot().status !== 'history-only')
    clientModules.session.setReadiness(
      connected
        ? sessionPending || !sessionBinding.session?.attached
          ? 'connecting'
          : 'ready'
        : value === 'closed'
          ? 'failed'
          : 'connecting',
      currentSessionId,
    )
  if (!connected) {
    sidebarPages.reset()
    permissionConnectionEpoch++
    if (sessionBinding.session) {
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
function render(): void {
  turnController.render()
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
async function list(
  change?: { sessionId: string; cwd?: string; created?: boolean },
  metadata = false,
): Promise<PageSessionMeta> {
  const epoch = ++listGeneration
  if (change) sidebarPages.invalidateSession(change.sessionId, change.cwd, workspaceRows)
  // A session that has just started is not in the cached full list yet.
  if (change?.created) sessionInventory.invalidate()
  if (change?.created) {
    const groupId = workspaceRows.find((row) => row.path === change.cwd)?.workspaceId ?? 'unassigned'
    await sidebarPages.created(groupId)
  } else await sidebarPages.refresh(metadata)
  const page = { items: sidebarPages.rows() }
  if (epoch !== listGeneration) return page
  const rows = new Map(page.items.map((row) => [row.sessionId, row]))
  if (sessionBinding.session) {
    const selected = await client.session.list({ q: { prefix: sessionBinding.session.id }, limit: 100 })
    if (epoch !== listGeneration) return page
    const match = selected.items.find((row) => row.sessionId === sessionBinding.session?.id)
    if (match) {
      if (match.title) sessionTitles.set(match.sessionId, match.title)
      rows.set(match.sessionId, match)
    }
  }
  sessionRows = [...rows.values()]
  if (sessionBinding.session && projection) render()
  updateSidebar()
  const selectedRow = sessionRows.find((row) => row.sessionId === sessionBinding.session?.id)
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
function prepareAttachmentSession(): Promise<string> {
  return submissionController.prepareAttachmentSession()
}

function forkTurn(turn: UITurn): Promise<void> {
  return sessionController.forkTurn(turn)
}
/** A failed turn's retry enters the same submission path as the composer. */
function retryTurn(turn: UITurn): Promise<void> | undefined {
  return submissionController.retryTurn(turn)
}
/** A failure that needs configuration opens the settings page that fixes it. */
function openErrorSettings(target: 'account' | 'model'): void {
  settingsRegion.open('model')
  if (target === 'model') run(() => settings.open())
  else run(() => settings.openAccount())
}
function beginExplicitNewDraft(showWorkspacePicker = true, workspace?: WorkspaceEntry): Promise<void> {
  requestNewSession()
  return beginNewDraft(showWorkspacePicker, workspace)
}
async function beginNewDraft(showWorkspacePicker = true, workspace?: WorkspaceEntry): Promise<void> {
  if (sessionPending || submissions.sending) return
  // A new draft the current filter would hide reads as a lost session: show the live list first.
  if (sessionInventory.getSnapshot().mode === 'archived') sessionInventory.setMode('active')
  sessionInventory.invalidate()
  void businessAgentSuggestions.refresh()
  selectComposerDraft()
  sessionPending = true
  workspaceController.resolveDraft(workspace)
  clearSessionRecovery()
  const { binding: epoch, previous } = sessionBinding.begin()
  references.clear()
  if (previous.session && knownSessionModel) rememberWebComposer({ model: knownSessionModel })
  const inherited = selectionFromMemory(runtimeModels, accountProvider)
  const stop = previous.stop
  moduleSessionId = undefined
  clientModules.session.setSession(undefined)
  projection = undefined
  draftingNew = true
  draftModelSettingsEdited = false
  draftModelExplicit = false
  draftLoopEdited = false
  draftLoop = newSessionCatalog && defaultLoop(newSessionCatalog.defaults)
  draftPreset = undefined
  draftPermission = undefined
  draftBundles = []
  pendingSessionKey = crypto.randomUUID()
  knownSessionModel = inherited.model ? modelDefaults(inherited.model) : undefined
  syncDraftPermission()
  permissionRefreshPending = false
  initialPermissionPending = undefined
  initialModelPending = undefined
  liveApproval?.finish({ unanswered: 'detached' })
  liveApproval = undefined
  renderer.reset()
  const url = new URL(location.href)
  url.searchParams.delete('session')
  const settingsHash =
    url.searchParams.has('settings') && url.hash.startsWith('#settings-subsection-') ? url.hash : ''
  url.hash = settingsHash
  history.replaceState(null, '', preserveRouteParams(url))
  topbarRuntime.setTaskTitle(t('app.newSession.defaultTitle'))
  render()
  if (!selectedWorkspace?.available && showWorkspacePicker) workspaceController.open(true)
  else composerRuntime.focus()
  sessionPending = true
  renderControls()
  let cleanupError: unknown
  // Catalog reads do not depend on detaching the old view. Start them together, but
  // keep submission disabled until both the catalog and client roster are ready.
  const catalogReady = (async () => {
    await refreshSessionCatalog()
    if (sessionBinding.isCurrent(epoch) && draftingNew && !draftModelExplicit && !draftModelSettingsEdited) {
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
  })().catch((error: unknown) => {
    cleanupError = error
  })
  // The binding and module identity already belong to the draft. Its roster can share
  // in-flight catalog checks while the old subscription is being closed.
  const rosterReady = clientModules.reconciler.reconcileNow().catch((error: unknown) => {
    cleanupError ??= error
  })
  try {
    const stopped = await stopWithTimeout(stop)
    if (!stopped) {
      notice.setText(() => t('app.notice.oldSessionClosing'))
      notice.setKind('warning')
    }
  } catch (error) {
    cleanupError = error
  }
  try {
    await previous.session?.detach()
  } catch (error) {
    cleanupError ??= error
  } finally {
    await Promise.all([catalogReady, rosterReady])
    if (sessionBinding.isCurrent(epoch)) {
      sessionPending = false
      render()
    }
  }
  if (cleanupError) throw cleanupError
}
function selectComposerDraft(id?: string, preserve = false): void {
  composerRuntime.setDraft(composerDrafts.select(profileName, id, composerRuntime.getDraft(), preserve))
  if (!preserve) composerRuntime.clearImageBlocks()
}
let modelReadGeneration = 0
let modelAppliedGeneration = 0
function selectedModelAvailable(): boolean {
  const selected = knownSessionModel
  return (
    !selected || runtimeModels.some((model) => model.route === selected.route && model.id === selected.id)
  )
}
async function refreshModels(catalogReady?: Promise<void>): Promise<ModelPickerOption[]> {
  const generation = ++modelReadGeneration
  const apis = await client.apis()
  // Start the model read immediately; defaults and labels must settle before selection is applied.
  await catalogReady
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
      syncDraftPermission()
    }
    renderControls()
  }
  return models
}
async function selectPermission(mode: PermissionMode): Promise<boolean> {
  if (!connected || sessionPending || permissionChangePending || permissionRefreshPending) return false
  if (!sessionBinding.session && draftingNew) {
    if (!allowedPermissionLevels(runtimeCatalog).includes(permissionLevel(mode)))
      throw new Error(settingsText('notAllowed'))
    draftPermission = mode
    syncDraftPermission()
    rememberWebComposer({ permission: mode })
    notice.setText(() => t('app.permission.draftNotice', { mode: permissionLabel(mode) }))
    notice.setKind('')
    renderControls()
    return true
  }
  if (!sessionBinding.session) return false
  const session = sessionBinding.session
  const epoch = sessionBinding.capture()
  const connectionEpoch = permissionConnectionEpoch
  // An open session keeps the level it was created with; only the approval (yolo) switch changes.
  const level =
    sessionPermissionLevel(
      sessionRows.find((row) => row.sessionId === session.id),
      runtimeCatalog,
    ) ?? (permissionMode === 'view' ? 'read-only' : 'workspace-write')
  // Skipping approvals never widens a read-only session.
  const requestedYolo = yoloEnabled(mode) && level !== 'read-only'
  permissionChangePending = true
  renderControls()
  try {
    const applied = await session.setYolo(requestedYolo)
    const actual = await session.projectUI(undefined, { surface: 'web' })
    if (
      !sessionBinding.isCurrent(epoch, session) ||
      sessionPending ||
      connectionEpoch !== permissionConnectionEpoch
    )
      return false
    permissionSelectionSeq = applied.effectiveFromSeq
    initialPermissionPending = undefined
    sessionYoloEnabled = actual.yolo ?? (requestedYolo || level === 'full-access')
    permissionMode = openSessionMode(level, sessionYoloEnabled, permissionMode)
    if (permissionMode !== mode) {
      // A different level needs a new session. Say so, and offer the path that works.
      const label = permissionLabel(mode)
      notice.setText(() =>
        t('app.permission.newSessionsOnly', { mode: label, current: permissionLabel(permissionMode) }),
      )
      notice.setKind('')
      notice.offer({
        label: t('app.permission.useInNew', { mode: label }),
        run: () =>
          run(async () => {
            await beginExplicitNewDraft(false)
            await selectPermission(mode)
          }),
      })
      return false
    }
    rememberWebComposer({ permission: mode })
    reportSuccess(
      'session-permission',
      mode === 'full'
        ? t('app.permission.notice.full')
        : t('app.permission.notice.mode', { mode: permissionLabel(mode) }),
    )
    notice.setKind('')
    return true
  } catch (error) {
    if (sessionBinding.isCurrent(epoch, session) && !sessionPending) showError(error)
    return false
  } finally {
    if (sessionBinding.isCurrent(epoch, session) && !sessionPending) {
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
async function readAuxiliaryModels(): Promise<import('@agnes/web-ui').SessionAuxiliarySnapshot> {
  const session = sessionBinding.session
  if (!session) throw new Error('Session unavailable')
  const binding = sessionBinding.capture()
  const [capabilities, defaults] = await Promise.all([session.capabilities(), loadAuxiliaryModelDefaults()])
  if (!sessionBinding.isCurrent(binding, session) || !capabilities?.modelRoutes.value)
    throw new Error('Session unavailable')
  const routes = capabilities.modelRoutes.value
  return { fast: routes.fast ?? null, verifier: routes.verifier ?? null, defaults }
}
async function selectAuxiliaryModel(slot: 'fast' | 'verifier', option: ModelPickerOption): Promise<boolean> {
  const session = sessionBinding.session
  const epoch = sessionBinding.capture()
  if (
    !session ||
    !connected ||
    submissions.sending ||
    sessionPending ||
    modelChangePending ||
    auxiliaryModelPending
  )
    return false
  auxiliaryModelPending = true
  try {
    await session.setModel({ slot, route: option.route, model: option.id })
    if (!sessionBinding.isCurrent(epoch, session) || sessionPending) return false
    return true
  } catch (error) {
    if (sessionBinding.isCurrent(epoch, session)) showError(error)
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
  const session = sessionBinding.session
  if (sessionPending || modelChangePending || auxiliaryModelPending) return false
  if (!session && draftingNew) {
    draftModelExplicit = true
    if (settings !== undefined) draftModelSettingsEdited = true
    else if (!sameModel) draftModelSettingsEdited = false
    knownSessionModel = selected
    rememberWebComposer({ model: knownSessionModel })
    notice.setText(() => t('app.notice.newSessionModel'))
    notice.setKind('')
    renderControls()
    return true
  }
  if (!session) return false
  const epoch = sessionBinding.capture()
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
    if (!sessionBinding.isCurrent(epoch, session) || sessionPending) return false
    modelSelectionSeq = applied.effectiveFromSeq
    knownSessionModel = selected
    rememberWebComposer({ model: knownSessionModel })
    initialModelPending = undefined
    reportSuccess('session-primary-model', t('app.notice.modelSaved'))
    notice.setKind('')
    sessionBinding.live?.refresh()
    return true
  } catch (error) {
    if (sessionBinding.isCurrent(epoch, session) && !sessionPending) showError(error)
    return false
  } finally {
    if (sessionBinding.isCurrent(epoch, session) && !sessionPending) {
      modelChangePending = false
      renderControls()
    }
  }
}
async function savedConfiguration(saved: ConfigSnapshot): Promise<void> {
  firstRun.updated(saved)
  notice.setKind('')
  accountProvider = saved.provider
  accountLabels = new Map((saved.accounts ?? []).map((row) => [row.route, row.label]))
  await modelRefresh.request()
  const savedModels = runtimeModels
  const published = savedModels.some(
    (entry) =>
      entry.route === (saved.provider?.route ?? saved.provider?.id) && entry.id === saved.provider?.model,
  )
  if (!saved.configured && !savedModels.length) {
    notice.setText(() => t('app.model.noAccounts'))
    return
  }
  if (saved.effect === 'restart-required' || !published) {
    // The account owner reports the authoritative restart consequence.
    if (!published && saved.effect !== 'restart-required')
      notice.setText(() => t('app.model.savedNotEffective'))
    return
  }
}
onWindowFocus(() => {
  if (connected)
    run(async () => {
      await list(undefined, true)
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
  appearance.sync()
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

function handleComposerWorkspace(): void {
  composerController.handleComposerWorkspace()
}
function handleComposerCancel(): void {
  commandController.handleComposerCancel()
}
function handleQueuedAction(itemId: string, kind: 'sendNow' | 'removeQueued' | 'promote'): void {
  commandController.handleQueuedAction(itemId, kind)
}

function refreshSessionControls(session: Session): Promise<void> {
  return commandController.refreshSessionControls(session)
}
function readSessionControls(session: Session): Promise<ApplySessionControls> {
  return commandController.readSessionControls(session)
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
function prepareComposerSession(): Promise<Session> {
  return submissionController.prepareComposerSession()
}

function submitComposer(options?: { steer?: boolean }): void {
  submissionController.submitComposer(options)
}
const diagnostics = createDiagnosticsDialog({
  call: (method, params) => client.call(method, params),
  context: () => ({
    sessionId: sessionBinding.session?.id ?? null,
    sessionTitle: sessionTitles.get(sessionBinding.session?.id ?? '') ?? null,
    projection,
    projectionHasEarlier: sessionBinding.live?.hasEarlier() ?? false,
  }),
})
sessionViewCommands.reportProblem = (trigger) => diagnostics.open(trigger)
const stopConnectionEvents = bindConnectionEvents(appSessionContext, {
  reconnect,
  setConnection,
  async refresh() {
    await modelRefresh.request()
    await list(undefined, true)
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
  sessionBinding.session !== undefined &&
  (payload as { sessionId?: unknown } | undefined)?.sessionId === sessionBinding.session.id
client.on('gap', (payload) => {
  if (!forCurrent(payload)) return
  const message = () => t('app.gap.partial')
  if (sessionRecovery) renderSessionRecovery(message)
  else notice.setText(message)
  void sessionBinding.live?.resync().catch(showError)
})
client.on('generationChanged', (payload) => {
  if (!forCurrent(payload)) return
  void sessionBinding.live?.resync().catch(showError)
})
// A cold daemon reports its tree and packages in quick succession; notices that close share one read.
const packageNotices = coalesceBurst(() => {
  scheduleClientRosterRead()
  broadcast('agnes:plugins-invalidated')
  void modelRefresh.request().catch(showError)
}, 100)
// 名册失效推送（WC10）：packages_changed 只是失效提示，收到后必须重读名册。
client.on('notice', (payload) => {
  const incoming = payload as { kind?: unknown; detail?: unknown }
  if (incoming.kind === 'automation_attention') {
    notice.setKind('warning')
    notice.setText(() => t('app.automation.needsAttention'))
    return
  }
  if (incoming.kind !== 'packages_changed' && incoming.kind !== 'tree_changed') return
  const detail =
    typeof incoming.detail === 'object' && incoming.detail !== null
      ? (incoming.detail as { profile?: unknown })
      : undefined
  if (profileName && detail?.profile === profileName) packageNotices.request()
})
onPageVisible(() => {
  reconnect.resume()
  void list(undefined, true).catch(showError)
  void modelRefresh.request().catch(showError)
  scheduleClientRosterRead()
})
onHistoryNavigation(() => {
  const params = new URL(location.href).searchParams
  const id = params.get('session')
  if (!id && params.has('settings')) return
  run(async () => {
    if (id) {
      if (sessionBinding.session?.id !== id) await open(id)
      return
    }
    if (sessionBinding.session || !draftingNew) await beginNewDraft(!homeNavigation.getSnapshot())
  })
})
async function refreshModelConfiguration(): Promise<void> {
  const snapshot = await client.config.get()
  accountProvider = snapshot.provider
  accountLabels = new Map((snapshot.accounts ?? []).map((row) => [row.route, row.label]))
  const catalogReady = refreshSessionCatalog()
  await Promise.all([catalogReady, refreshModels(catalogReady)])
}
const modelRefresh = createRefreshCoordinator({
  refresh: refreshModelConfiguration,
  canRefresh: () => connected && pageVisible(),
})
const sessionConfigurationChanged = () => void modelRefresh.request().catch(showError)
const stopSessionConfiguration = onBroadcast(
  'agnes:session-configuration-changed',
  sessionConfigurationChanged,
)
onPageHide(() => {
  notice.clearErrors()
  sidebarPages.reset()
  intentionalClose = true
  stopConnectionEvents()
  stopSettingsTerminal()
  stopSurfaceSettings()
  stopSettingsRouting()
  statusCheck.dispose()
  stopHomeRouting()
  for (const stop of stopHomeSelection) stop()
  sessionSearch.dispose()
  homePages.dispose()
  removeHomeEntries()
  workspaceController.dialog.dispose()
  unbindDialogSheets()
  firstRun.dispose()
  const dockHost = dockControlsHost
  if (dockHost) unmountWorkbench(dockHost)
  unmountAppShell()
  modelRefresh.stop()
  packageNotices.stop()
  stopSessionConfiguration()
  reconnect.cancel()
  titleRefresh.close()
  const { previous } = sessionBinding.begin()
  void (previous.stop?.() ?? Promise.resolve()).finally(() => client.close())
})

run(async () => {
  const startupSelection = sessionBinding.capture()
  setConnection('connecting')
  if (!wsUrl) throw new Error(t('app.ws.unavailable'))
  // A first connection that fails never reports `closed`; the page may hold a stale daemon address.
  try {
    runtimePlatform = (await client.initialize()).platform
  } catch (error) {
    if (!intentionalClose) reconnect.start()
    throw error
  }
  setConnection('connected')
  reconnect.reset()
  void workspaceController.refreshPicker()
  const snapshot = await client.config.get()
  accountProvider = snapshot.provider
  profileName = snapshot.profile
  void skinGroup.refresh()
  // A session selection reads its own roster. Defer the profile-only read until we know there
  // is no session to open, so startup never verifies and imports the same modules twice.
  accountLabels = new Map((snapshot.accounts ?? []).map((row) => [row.route, row.label]))
  // Existing conversations do not need a model catalog to open. Keep its read in flight while
  // the session and workspace lists resolve; only new-draft defaults depend on its result.
  const models = refreshModels().then(
    () => ({ status: 'fulfilled' as const }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
  const [workspaces, sessions] = await Promise.allSettled([client.workspace.list(), list()])
  if (workspaces.status === 'fulfilled') {
    workspaceController.apply(workspaces.value)
    // A link that names a workspace selects it, unless the reader has already chosen one.
    const requested = workspaceRows.find((row) => row.workspaceId === requestedWorkspaceId)
    if (requested && !selectedWorkspace && sessionBinding.isCurrent(startupSelection))
      selectedWorkspace = requested
  } else showError(new Error(t('app.workspaceList.unreadable'), { cause: workspaces.reason }))
  if (sessions.status === 'rejected') throw sessions.reason
  const page = sessions.value
  const sidebar = sidebarPages.snapshot()
  const sidebarReady = sidebar.ready && !sidebar.loading && !sidebar.error
  // Unloaded/failed pages are not evidence of an empty account. Summary counts own emptiness.
  const empty =
    sidebarReady &&
    sidebar.groups.every(
      (group) => group.ready && !group.loading && !group.error && !group.stale && group.total === 0,
    )
  const first = sidebarReady
    ? sidebar.groups
        .filter(
          (group) =>
            group.opened && group.ready && group.loaded && !group.loading && !group.error && !group.stale,
        )
        .flatMap((group) => group.items)
        .find((item) => !item.archived)
    : undefined
  // A user choice also owns whether the account setup dialog may open.
  if (!sessionBinding.isCurrent(startupSelection)) return
  // Accounts without a usable model get a notice that leads to settings; a load never opens the dialog.
  let modelNotice = false
  let modelsHandled = false
  const awaitModels = async () => {
    const result = await models
    if (modelsHandled) return
    modelsHandled = true
    if (result.status === 'rejected') showError(result.reason)
    modelNotice = needsModelNotice({
      modelsRead: result.status === 'fulfilled',
      models: runtimeModels.length,
      accounts: snapshot.accounts?.length ?? 0,
    })
    if (modelNotice) renderControls()
  }
  let missingSession = false
  const showModelNotice = () => {
    // A link to a session that is gone keeps its own notice.
    if (!modelNotice || configured || missingSession) return
    notice.setText(() => t('app.model.noneUsable'))
    notice.offer({
      label: t('app.model.openSettings'),
      run: () =>
        run(async () => {
          settingsRegion.open('model')
          await settings.open()
        }),
    })
  }
  const guided =
    empty &&
    !startupRequest.get('settings') &&
    !homeNavigation.getSnapshot() &&
    !startupRequest.get('session') &&
    needsFirstRun(snapshot)
  // A user selection made while startup was loading owns the current view.
  if (!sessionBinding.isCurrent(startupSelection)) return
  const selected = new URL(location.href).searchParams.get('session')
  if (startupRequest.get('new') === '1') {
    await awaitModels()
    if (!sessionBinding.isCurrent(startupSelection)) return
    requestNewSession()
    sessionPending = false
    await beginNewDraft(configured)
    if (requestedLoop) {
      const match = newSessionCatalog?.loops.find((entry) => `${entry.id}@${entry.version}` === requestedLoop)
      if (!match) throw new Error(settingsText('notAllowed'))
      draftLoop = { id: match.id, version: match.version }
      draftLoopEdited = true
    }
    if (requestedPreset) {
      // A legacy link names a permission level as its preset; a Host that lists levels takes it as one.
      const level =
        runtimeCatalog?.permissions && isPermissionLevel(requestedPreset) ? requestedPreset : undefined
      if (
        level
          ? !allowedPermissionLevels(runtimeCatalog).includes(level)
          : !runtimeCatalog?.presets.some((entry) => entry.id === requestedPreset)
      )
        throw new Error(settingsText('notAllowed'))
      if (level) draftPermission = permissionModeOf(level)
      else draftPreset = requestedPreset
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
    showModelNotice()
    return
  }
  const startupSettings = startupSettingsLink.id
  // A link to the old history or archive page opens the sidebar's search or archived list instead.
  const startupTerminal = settingsRoute(startupSettings).terminal === true
  const startupMoved = movedSettingsTarget(startupSettings)
  const startupSection = startupMoved ? undefined : settingsSections.get(settingsRoute(startupSettings).id)
  if (selected) {
    const candidates = page.items.some((item) => item.sessionId === selected)
      ? page
      : await client.session.list({ q: { prefix: selected }, limit: 100 })
    if (candidates.items.some((item) => item.sessionId === selected)) {
      await open(selected)
      if (requestedPrompt) composerRuntime.setDraft(requestedPrompt)
    } else {
      missingSession = true
      scheduleClientRosterRead(true)
      notice.setText(() => t('app.session.notFound'))
      renderControls()
    }
  } else if (first) await open(first.sessionId)
  else if (empty) {
    await awaitModels()
    if (!sessionBinding.isCurrent(startupSelection)) return
    await beginNewDraft(
      configured &&
        !startupSection &&
        !startupTerminal &&
        !startupMoved &&
        !homeNavigation.getSnapshot() &&
        !guided,
    )
  } else {
    scheduleClientRosterRead(true)
    sessionPending = false
    renderControls()
  }
  const modelSelection = sessionBinding.capture()
  await awaitModels()
  if (!sessionBinding.isCurrent(modelSelection)) return
  const factCandidate = startupRequest.get('factCandidate')
  if (
    selected &&
    sessionBinding.session?.id === selected &&
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
  const shown = await firstRun.initialize(
    snapshot,
    !empty || Boolean(startupSection || startupTerminal || startupMoved || homeNavigation.getSnapshot()),
  )
  if (guided && !shown) await beginNewDraft(true)
  if (startupMoved)
    openMovedSettingsLink(startupSettings, {
      searchSessions: () => sessionSearch.open(),
      showArchived: () => sessionInventory.setMode('archived'),
    })
  showModelNotice()
  const settingsSelection = sessionBinding.capture()
  if ((startupSection || startupTerminal) && !startupSettingsDismissed) {
    settingsRegion.open('model')
    await settings.open()
    // A choice made while the dialog was loading owns the view.
    if (!sessionBinding.isCurrent(settingsSelection)) return
    const anchoredSettings = startupSettingsAnchor.replace(/^settings-subsection-/, '')
    const anchoredRoute = settingsRoute(anchoredSettings)
    const target =
      anchoredRoute.id === startupSettings && anchoredRoute.anchor === startupSettingsAnchor
        ? anchoredSettings
        : startupSettings
    settingsRegion.route(target)
  }
})
