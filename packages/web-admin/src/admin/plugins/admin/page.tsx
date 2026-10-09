import type {
  CompositionCapabilitySnapshot,
  RuntimeAdminSnapshot,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
  PackageSource,
  RuntimePinDescriptor,
  RuntimePinReleaseResult,
} from '@agnes/protocol'
import { settingsSections } from '@agnes/web-client'
import type { PluginRuntimeState } from '@agnes/web-foundation/client-modules/runtime-status'
import {
  ADMIN_CONFIRMATION_LOCALE_NAMESPACE,
  ADMIN_DETAIL_LOCALE_NAMESPACE,
  ADMIN_DIALOGS_LOCALE_NAMESPACE,
  ADMIN_LIST_LOCALE_NAMESPACE,
  ADMIN_LOCALE_NAMESPACE,
  adminConfirmationLocaleCatalog,
  adminDetailLocaleCatalog,
  adminDialogsLocaleCatalog,
  adminListLocaleCatalog,
  adminLocaleCatalog,
  PLUGIN_PRESENTATION_NAMESPACE,
  pluginPresentationCatalog,
  createDocumentLocaleSource,
  createUiTranslator,
  type DetailActionSpec,
  hasPermission,
  PreviewConfirmationFacts,
  RollbackActivationFacts,
  TrustConfirmationFacts,
  terminal,
  type UiLocaleSource,
  UpdateActivationFacts,
  unmountRegion,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import type { SettingsPage } from '../../../settings/hub.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from '../../../settings/locales.js'
import type { SchedulesApi } from '../../../settings/schedules.js'
import { AdminApiError, PluginAdminApi } from '../api.js'
import { CapabilityReview, ProvenanceReview } from '../capability-review.js'
import type { PluginKind } from '../control-panel.js'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from '../locales/admin.js'
import { SOURCE_FORMATS, sourceFromForm, sourceProblem } from '../source-form.js'
import {
  ADMIN_FEATURES,
  type AdminContext,
  type AdminError,
  type AdminPageState,
  type AdminSurfaceLink,
  hasFeature,
  type PluginRuntimeSource,
} from '../types.js'
import { matchesPluginSearch, pluginPresentation } from './presentation.js'
import { button, element, setDialog } from './dom.js'
import { hasClientContribution, isClientOnly, safeMessage, sourceForCatalog } from './model.js'
import {
  type PreviewMode,
  operationRecords as readOperationRecords,
  operationStorageKey as storedOperationKey,
  type TrackedOperation,
} from './operation-storage.js'
import {
  renderConfirmPluginView,
  renderDetailPluginView,
  renderPluginView,
  renderSourcePluginView,
} from './views.js'

const ACTIVE_REFRESH_MS = 1_200
const RECONNECT_REFRESH_MS = 3_000
// Must match PackagePinsReleaseParams.pinIds maxItems in packages/protocol/schema/package-admin.json.
// "Release all" can see far more orphans than one release call accepts, so it batches.
const PIN_RELEASE_BATCH_SIZE = 64

type SourceInlineError = { code: string; message: string }
type PendingConfirm = {
  title: string | (() => string)
  description: string | (() => string)
  label: string | (() => string)
  run: () => Promise<void>
  facts?: ReactNode
}

export type PluginAdminOptions = Readonly<{
  actualSlots?: (packageId: string) => readonly string[]
  locale?: UiLocaleSource
  runtime?: PluginRuntimeSource
  schedules?: SchedulesApi
  candidateSessionTitle?: (key: string) => Promise<string | undefined>
  candidateSessionTurnTime?: (key: string, turn: number) => Promise<string | undefined>
}>

const pluginAdminCatalogs = {
  [PLUGIN_ADMIN_LOCALE_NAMESPACE]: pluginAdminLocaleCatalog,
  [ADMIN_CONFIRMATION_LOCALE_NAMESPACE]: adminConfirmationLocaleCatalog,
  [ADMIN_DETAIL_LOCALE_NAMESPACE]: adminDetailLocaleCatalog,
  [ADMIN_DIALOGS_LOCALE_NAMESPACE]: adminDialogsLocaleCatalog,
  [ADMIN_LIST_LOCALE_NAMESPACE]: adminListLocaleCatalog,
  [ADMIN_LOCALE_NAMESPACE]: adminLocaleCatalog,
  [PLUGIN_PRESENTATION_NAMESPACE]: pluginPresentationCatalog,
} as const

export class PluginAdminPage {
  viewContext() {
    const page = this
    return {
      get adminT() {
        return page.#adminT
      },
      get api() {
        return page.#api
      },
      get candidateSessionTitle() {
        return page.#candidateSessionTitle
      },
      get candidateSessionTurnTime() {
        return page.#candidateSessionTurnTime
      },
      get confirmActionDisabled() {
        return page.#confirmActionDisabled
      },
      set confirmActionDisabled(value) {
        page.#confirmActionDisabled = value
      },
      get confirmDialog() {
        return page.#confirmDialog
      },
      get detail() {
        return page.#detail
      },
      get kind() {
        return page.#kind
      },
      set kind(value) {
        page.#kind = value
      },
      get category() {
        return page.#category
      },
      set category(value: string) {
        page.#category = value
      },
      get purposeText() {
        return createUiTranslator(page.#locale, PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
      },
      get layout() {
        return page.#layout
      },
      get listHost() {
        return page.#listHost
      },
      get locale() {
        return page.#locale
      },
      get notice() {
        return page.#notice
      },
      get noticeState() {
        return page.#noticeState
      },
      get onSettingsPage() {
        return page.#onSettingsPage
      },
      get orphanPinErrors() {
        return page.#orphanPinErrors
      },
      get orphanPinFetchError() {
        return page.#orphanPinFetchError
      },
      get orphanPinList() {
        return page.#orphanPinList
      },
      get orphanPinNotice() {
        return page.#orphanPinNotice
      },
      set orphanPinNotice(value) {
        page.#orphanPinNotice = value
      },
      get orphanPinsHost() {
        return page.#orphanPinsHost
      },
      get pendingConfirm() {
        return page.#pendingConfirm
      },
      get query() {
        return page.#query
      },
      set query(value) {
        page.#query = value
      },
      get queryRaw() {
        return page.#queryRaw
      },
      set queryRaw(value) {
        page.#queryRaw = value
      },
      get recovery() {
        return page.#recovery
      },
      get refreshSettings() {
        return page.#refreshSettings
      },
      get reviewExample() {
        return page.#reviewExample
      },
      get schedules() {
        return page.#schedules
      },
      get sourceBusy() {
        return page.#sourceBusy
      },
      get sourceDialog() {
        return page.#sourceDialog
      },
      get sourceError() {
        return page.#sourceError
      },
      get sourcePlaceholder() {
        return page.#sourcePlaceholder
      },
      get sourceProblem() {
        return page.#sourceProblem
      },
      get sourceRefValue() {
        return page.#sourceRefValue
      },
      set sourceRefValue(value) {
        page.#sourceRefValue = value
      },
      get sourceTypeValue() {
        return page.#sourceTypeValue
      },
      set sourceTypeValue(value) {
        page.#sourceTypeValue = value
      },
      get state() {
        return page.#state
      },
      get t() {
        return page.#t
      },
      get tab() {
        return page.#tab
      },
      set tab(value) {
        page.#tab = value
      },
      get treeStatus() {
        return page.#treeStatus
      },
      get actualSlots() {
        return page.actualSlots
      },
      can: page.can.bind(page),
      canEffect: page.canEffect.bind(page),
      cancelOperation: page.cancelOperation.bind(page),
      closeConfirm: page.closeConfirm.bind(page),
      closeDetail: page.closeDetail.bind(page),
      closeSourceDialog: page.closeSourceDialog.bind(page),
      configureConfirm: page.configureConfirm.bind(page),
      confirmDisable: page.confirmDisable.bind(page),
      confirmEnable: page.confirmEnable.bind(page),
      confirmReleasePins: page.confirmReleasePins.bind(page),
      detailActions: page.detailActions.bind(page),
      detailOperations: page.detailOperations.bind(page),
      errorMessage: page.errorMessage.bind(page),
      filteredInstalled: page.filteredInstalled.bind(page),
      presentationOf: page.presentationOf.bind(page),
      hasDetail: page.hasDetail.bind(page),
      loadCatalog: page.loadCatalog.bind(page),
      noticeText: page.noticeText.bind(page),
      openSourceDialog: page.openSourceDialog.bind(page),
      packageBusy: page.packageBusy.bind(page),
      primaryAction: page.primaryAction.bind(page),
      refresh: page.refresh.bind(page),
      render: page.render.bind(page),
      renderConfirm: page.renderConfirm.bind(page),
      renderDetail: page.renderDetail.bind(page),
      renderSource: page.renderSource.bind(page),
      runtimeState: page.runtimeState.bind(page),
      selectItem: page.selectItem.bind(page),
      settingsText: page.settingsText.bind(page),
      showError: page.showError.bind(page),
      sourceIntro: page.sourceIntro.bind(page),
      sourceTitle: page.sourceTitle.bind(page),
      submitSource: page.submitSource.bind(page),
      surfaceLinks: page.surfaceLinks.bind(page),
      syncSourceHint: page.syncSourceHint.bind(page),
    }
  }

  readonly #runtime: PluginRuntimeSource | undefined
  readonly #schedules: SchedulesApi | undefined
  readonly #candidateSessionTitle: PluginAdminOptions['candidateSessionTitle']
  readonly #candidateSessionTurnTime: PluginAdminOptions['candidateSessionTurnTime']
  #runtimeStop: (() => void) | undefined
  readonly #locale: UiLocaleSource
  readonly #localeStop: () => void
  readonly #localeCleanup: (() => void) | undefined
  readonly #t: ReturnType<typeof createUiTranslator>
  readonly #adminT: ReturnType<typeof createUiTranslator>
  private readonly actualSlots: ((packageId: string) => readonly string[]) | undefined

  constructor(options: PluginAdminOptions = {}) {
    // Keep the scrollable tab panel keyboard reachable during empty/loading states.
    this.#listHost.tabIndex = 0
    this.actualSlots = options.actualSlots
    this.#runtime = options.runtime
    this.#schedules = options.schedules
    this.#candidateSessionTitle = options.candidateSessionTitle
    this.#candidateSessionTurnTime = options.candidateSessionTurnTime
    if (options.locale) {
      this.#locale = options.locale
      this.#localeStop = options.locale.subscribe(() => this.render())
    } else {
      const locale = createDocumentLocaleSource(pluginAdminCatalogs)
      this.#locale = locale.source
      this.#localeCleanup = locale.dispose
      this.#localeStop = locale.source.subscribe(() => this.render())
    }
    this.#t = createUiTranslator(this.#locale, PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
    this.#adminT = createUiTranslator(this.#locale, ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  }

  #state: AdminPageState = {
    installed: [],
    surfaceLinks: [],
    catalog: [],
    nextCursor: null,
    operations: new Map(),
    runtime: new Map(),
    inventoryAuthoritative: false,
    loading: true,
    connection: 'loading',
  }
  #kind: PluginKind | '' = ''
  #category = ''
  #presentationRuntime: RuntimeAdminSnapshot | undefined
  #presentationComposition: CompositionCapabilitySnapshot | undefined
  #api: PluginAdminApi | undefined
  #tab: 'installed' | 'discover' = 'installed'
  #query = ''
  #queryRaw = ''
  #generation = 0
  #pendingConfirm: PendingConfirm | undefined
  #confirmActionDisabled = false
  #confirmTrigger: HTMLElement | undefined
  #detailTrigger: HTMLElement | undefined
  #detailDismissed = false
  #operationModes = new Map<string, PreviewMode>()
  #operationPackages = new Map<string, string>()
  #operationTimers = new Map<string, number>()
  #operationCompletions = new Map<string, (operation: PackageOperation) => Promise<void>>()
  #submittingPackages = new Set<string>()
  #sourceMode: PreviewMode = 'install'
  #sourcePackageId: string | undefined
  #sourceTrigger: HTMLElement | undefined
  #sourceBusy = false
  #sourceTypeValue = 'npm'
  #sourceRefValue = ''
  #sourceError: SourceInlineError | undefined
  #sourceProblem: { type: string; ref: string } | undefined
  #noticeState: {
    message: string
    key?: string
    vars?: Readonly<Record<string, string | number>>
    kind: 'error' | 'state' | ''
  } = {
    message: '',
    kind: '',
  }
  #orphanPinList: RuntimePinDescriptor[] = []
  #orphanPinErrors = new Map<string, string>()
  #orphanPinNotice: number | undefined
  // Distinct from #orphanPinNotice (which reports a per-pin "no longer orphaned" outcome after a
  // release): this reports pinsInspect() itself failing during refresh(), so the section stays
  // visible with a clear message instead of silently keeping a now-unverified stale list.
  #orphanPinFetchError: { detail: AdminError; localize: boolean } | undefined

  readonly #orphanPinsHost = element('orphan-pins', 'section')
  readonly #notice = element('admin-notice', 'p')
  readonly #treeStatus = element('plugin-tree-status', 'p')
  readonly #recovery = element('recovery-notice', 'section')
  readonly #layout = element('plugin-layout', 'div')
  readonly #listHost = element('plugin-list', 'section')
  readonly #onSettingsPage = (page: SettingsPage): void => {
    const tab = page === 'discover' ? 'discover' : 'installed'
    if ((page === 'plugins' || page === 'discover') && this.#tab !== tab) {
      queueMicrotask(() => void this.selectTab(tab))
    }
    const shell = document.getElementById('config-form')
    if (shell) {
      shell.dataset.runtimePage = page
      shell.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: page, bubbles: true }))
      for (const item of shell.querySelectorAll<HTMLElement>('[data-runtime-page]')) {
        const active =
          item.dataset.runtimePage === page ||
          settingsSections.get(item.dataset.runtimePage ?? '')?.group === settingsSections.get(page)?.group
        item.classList.toggle('active', active)
        if (active) item.setAttribute('aria-current', 'page')
        else item.removeAttribute('aria-current')
      }
      this.#listHost
        .closest('.settings-content')
        ?.querySelector<HTMLElement>('.config-heading')
        ?.setAttribute('hidden', '')
    }
  }
  #exampleInstallId: string | undefined
  #exampleFlowId: string | undefined
  readonly #reviewExample = (item: PackageCatalogDescriptor): void => {
    this.#exampleFlowId = item.id
    const installed = this.#state.installed.find((candidate) => candidate.id === item.id)
    if (installed) {
      void this.confirmEnable(installed)
      return
    }
    if (!this.can('packages.install')) return
    this.#exampleInstallId = item.id
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : this.#listHost
    void this.inspect(item.source, 'install', trigger, item.id)
  }
  readonly #refreshSettings = (): Promise<void> => this.refresh()
  readonly #detail = element('plugin-detail', 'dialog')
  readonly #sourceDialog = element('source-dialog', 'dialog')
  readonly #confirmDialog = element('plugin-confirm', 'dialog')

  async start(): Promise<void> {
    if (this.#runtime) {
      this.#state = { ...this.#state, runtime: this.#runtime.snapshot() }
      this.#runtimeStop = this.#runtime.subscribe(() => {
        if (!this.#runtime) return
        this.#state = { ...this.#state, runtime: this.#runtime.snapshot() }
        this.render()
      })
    }
    await this.refresh()
  }

  bind(): void {
    // 详情是模态框：点遮罩、按 Escape 都要走同一条收尾路径（含焦点归还与「不要立刻重开」）。
    this.#detail.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeDetail()
    })
    this.#detail.addEventListener('click', (event) => {
      if (event.target === this.#detail) this.closeDetail()
    })
    // The registry owns navigation; remove the legacy second tab level and toolbar.
    this.#listHost.closest('.admin-main, .admin-pane-body')?.querySelector('.plugin-toolbar')?.remove()
    document.getElementById('install-source')?.remove()
    this.#listHost.removeAttribute('role')
    this.#sourceDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeSourceDialog()
    })
    this.#confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeConfirm()
    })
  }

  async refresh(options: { preserveError?: boolean } = {}): Promise<void> {
    const generation = ++this.#generation
    this.#state = {
      ...this.#state,
      loading: true,
      ...(options.preserveError ? {} : { error: undefined }),
    }
    this.render()
    let resolvedContext: AdminContext | undefined
    try {
      const context = await PluginAdminApi.context()
      if (generation !== this.#generation) return
      resolvedContext = context
      if (JSON.stringify(this.#state.context) !== JSON.stringify(context) || !this.#api)
        this.#api = new PluginAdminApi(context)
      // Context remains useful even when inventory cannot be read: its recovery flag must still
      // disable effects, while read-only catalog calls may remain available.
      this.#state = { ...this.#state, context }
      // Independent read models can load together. Optional feeds never block a valid inventory.
      const [list, surfaceFeed, tree, runtimeCatalog, composition] = await Promise.all([
        this.#api.list(),
        this.#api.surfaceLinks().catch(() => undefined),
        this.#api.treeList().catch(() => undefined),
        this.#api.runtime().catch(() => undefined),
        this.#api.composition().catch(() => undefined),
      ])
      if (generation !== this.#generation) return
      this.#presentationRuntime = runtimeCatalog
      this.#presentationComposition = composition
      const surfaceLinks = surfaceFeed?.surfaces ?? []
      this.#state = {
        ...this.#state,
        context,
        installed: list.packages,
        generations: list.generations,
        surfaceLinks,
        tree,
        inventoryAuthoritative: true,
        loading: false,
        connection: 'connected',
      }
      this.scheduleTreePoll()
      this.render()
      try {
        const { orphans } = await this.#api.pinsInspect()
        if (generation !== this.#generation) return
        this.#orphanPinList = [...orphans]
        this.#orphanPinErrors = new Map()
        this.#orphanPinNotice = undefined
        this.#orphanPinFetchError = undefined
      } catch (error) {
        // Orphan-pin visibility is supplementary to the primary installed-package view above;
        // a failure here must not turn an otherwise-successful refresh into an offline state. But
        // a stale list must not keep being shown as current once it is no longer verified, and the
        // failure must be visible rather than silent -- so clear the list and surface a status.
        if (generation !== this.#generation) return
        this.#orphanPinList = []
        this.#orphanPinErrors = new Map()
        this.#orphanPinFetchError = {
          detail: safeMessage(error),
          localize: !(error instanceof AdminApiError),
        }
      }
      this.restoreOperations(context)
      if (this.#tab === 'discover') await this.loadCatalog()
    } catch (error) {
      if (generation !== this.#generation) return
      const detail = safeMessage(error)
      this.#state = {
        ...this.#state,
        ...(resolvedContext ? { context: resolvedContext } : {}),
        inventoryAuthoritative: false,
        loading: false,
        error: options.preserveError && this.#state.error ? this.#state.error : detail,
        connection:
          detail.code === 'FORBIDDEN' || detail.code === 'ADMIN_FORBIDDEN' ? 'forbidden' : 'offline',
      }
    }
    this.render()
  }

  async selectTab(tab: 'installed' | 'discover'): Promise<void> {
    if (this.#tab === tab) return
    this.#tab = tab
    this.#query = ''
    this.#queryRaw = ''
    this.#state = {
      ...this.#state,
      selectedCatalog: undefined,
      preview: undefined,
    }
    this.render()
    if (tab === 'discover') await this.loadCatalog()
  }

  async loadCatalog(cursor?: string): Promise<void> {
    if (!this.#api || !this.can('packages.read')) return
    const generation = ++this.#generation
    this.#state = { ...this.#state, loading: true, error: undefined }
    this.render()
    try {
      const page = await this.#api.catalog(this.#query, cursor)
      if (generation !== this.#generation || this.#tab !== 'discover') return
      this.#state = {
        ...this.#state,
        catalog: cursor ? [...this.#state.catalog, ...page.items] : page.items,
        nextCursor: page.nextCursor,
        loading: false,
        connection: 'connected',
      }
    } catch (error) {
      if (generation !== this.#generation) return
      this.#state = {
        ...this.#state,
        loading: false,
        error: safeMessage(error),
        connection: 'offline',
      }
    }
    this.render()
  }

  async inspect(
    source: PackageSource,
    mode: PreviewMode,
    trigger: HTMLElement,
    packageId?: string,
  ): Promise<{ ok: true } | { ok: false; error: SourceInlineError }> {
    const api = this.effectApi('packages.install')
    if (!api) return { ok: false, error: this.#state.error ?? { code: 'ADMIN_UNAVAILABLE', message: '' } }
    try {
      const receipt = packageId
        ? await this.submitPackage(packageId, () => api.inspect(source))
        : await api.inspect(source)
      this.track(receipt.operationId, {
        mode,
        ...(packageId ? { packageId } : {}),
      })
      this.#confirmTrigger = trigger
      this.setNoticeKey('notice.inspecting-source', 'state')
      return { ok: true }
    } catch (error) {
      this.showError(error)
      return { ok: false, error: safeMessage(error) }
    }
  }

  async confirmPreview(): Promise<void> {
    const preview = this.#state.preview
    if (!preview) return
    const mode = this.#state.previewMode ?? 'install'
    const api = this.effectApi('packages.install')
    if (!api) return
    const installed = this.#state.installed.find((item) => item.id === preview.id)
    const activeIntegrity = installed ? this.activeIntegrity(installed) : undefined
    const combined =
      mode === 'update' &&
      !!installed &&
      activeIntegrity !== undefined &&
      !!preview.capabilityHash &&
      this.supportsCompositeActivation() &&
      this.can('packages.install') &&
      this.can('packages.trust') &&
      this.can('packages.activate')
    const receipt = await this.submitPackage(preview.id, () =>
      mode === 'install'
        ? api.install(preview.source, preview.integrity)
        : api.update(
            preview.id,
            preview.source,
            preview.integrity,
            combined && installed && preview.capabilityHash
              ? {
                  expectedInstalledIntegrity: installed.integrity,
                  expectedActiveIntegrity: activeIntegrity,
                  trust: {
                    integrity: preview.integrity,
                    capabilityHash: preview.capabilityHash,
                  },
                }
              : undefined,
          ),
    )
    const continueExample = mode === 'install' && this.#exampleInstallId === preview.id
    this.#exampleInstallId = undefined
    this.track(
      receipt.operationId,
      { packageId: preview.id },
      continueExample
        ? async () => {
            const installed = this.#state.installed.find((item) => item.id === preview.id)
            if (installed) await this.confirmEnable(installed)
          }
        : undefined,
    )
    this.#state = {
      ...this.#state,
      preview: undefined,
      previewMode: undefined,
    }
    this.setNoticeKey(mode === 'install' ? 'notice.installing' : 'notice.updating', 'state')
    this.render()
  }

  setNotice(message: string, kind: 'error' | 'state' | ''): void {
    this.#noticeState = { message, kind }
    this.render()
  }

  setNoticeKey(
    key: string,
    kind: 'error' | 'state' | '',
    vars?: Readonly<Record<string, string | number>>,
  ): void {
    this.#noticeState = { message: '', key, ...(vars ? { vars } : {}), kind }
    this.render()
  }

  noticeText(): string {
    return this.#noticeState.key
      ? this.#t(this.#noticeState.key, this.#noticeState.vars)
      : this.#noticeState.message
  }

  openSourceDialog(mode: PreviewMode, item?: PackageInstalledDescriptor, trigger?: HTMLElement): void {
    if (!this.effectApi('packages.install')) return
    if (item && this.packageBusy(item.id)) return
    this.#sourceMode = mode
    this.#sourcePackageId = item?.id
    this.#sourceTrigger = trigger ?? button('install-source')
    this.#sourceError = undefined
    this.#sourceProblem = undefined
    this.#sourceRefValue = ''
    this.syncSourceHint()
    setDialog(this.#sourceDialog, true, this.#sourceDialogFocusTarget())
    this.render()
  }

  sourceTitle(): string {
    return this.#sourceMode === 'update' && this.#sourcePackageId
      ? this.#t('source.title.update', { id: this.#sourcePackageId })
      : this.#t('source.title.inspect')
  }

  sourceIntro(): string {
    return this.#sourceMode === 'update' ? this.#t('source.intro.update') : this.#t('source.intro.install')
  }

  /** React 渲染后 input 由组件持有，首焦点交给表单第一个可交互元素。 */
  #sourceDialogFocusTarget(): HTMLElement | undefined {
    return this.#sourceDialog.querySelector<HTMLElement>('select, input, button') ?? undefined
  }

  /** The field's example follows the selected source type, and a stale complaint about the old one goes. */
  syncSourceHint(): void {
    const type = this.#sourceTypeValue
    const format = type in SOURCE_FORMATS ? SOURCE_FORMATS[type as PackageSource['type']] : undefined
    this.#sourcePlaceholder = format?.example ?? this.#t('source.placeholder.npm')
    this.#sourceError = undefined
    this.#sourceProblem = undefined
  }

  #sourcePlaceholder = 'npm:scope/package@1.2.3'

  closeSourceDialog(): void {
    setDialog(this.#sourceDialog, false)
    this.#sourceTrigger?.focus({ preventScroll: true })
  }

  submitSource(): void {
    if (this.#sourceBusy) return
    const ref = this.#sourceRefValue.trim()
    const problem = sourceProblem(this.#sourceTypeValue, ref, this.#t)
    const source = problem ? undefined : sourceFromForm(this.#sourceTypeValue, ref)
    if (!source) {
      this.#sourceProblem = { type: this.#sourceTypeValue, ref }
      this.render()
      return
    }
    this.#sourceProblem = undefined
    const mode = this.#sourceMode
    const packageId = this.#sourcePackageId
    const trigger = this.#sourceTrigger ?? button('install-source')
    this.#sourceError = undefined
    this.#sourceBusy = true
    // Stay on this dialog until the backend has accepted the check: a refusal has to be readable
    // where the user is looking, not in a panel that this dialog has just been closed over.
    void this.inspect(source, mode, trigger, packageId)
      .then((result) => {
        if (result.ok) this.closeSourceDialog()
        else this.#sourceError = result.error
      })
      .finally(() => {
        this.#sourceBusy = false
      })
      .then(() => this.render())
  }

  async operationUpdated(operation: PackageOperation): Promise<void> {
    if (!terminal(operation)) return
    const completion = this.#operationCompletions.get(operation.operationId)
    this.#operationCompletions.delete(operation.operationId)
    const previewMode = this.#operationModes.get(operation.operationId)
    const packageId = operation.packageId ?? this.#operationPackages.get(operation.operationId)
    this.forgetOperation(operation.operationId)
    if (operation.operation === 'inspect') {
      if (operation.state === 'completed' && operation.preview && previewMode) {
        this.#state = {
          ...this.#state,
          preview: operation.preview,
          previewMode,
          error: undefined,
        }
        this.render()
        this.openPreview(operation.preview, previewMode)
        return
      }
    }
    if (operation.state === 'failed') {
      this.#state = {
        ...this.#state,
        lastOperation: operation,
        error: {
          code: operation.error?.code ?? 'E_PACKAGE_STATE',
          message: operation.error?.safeMessage ?? 'The operation could not be completed.',
          blockers: operation.error?.blockers,
        },
      }
    } else if (operation.state === 'cancelled') {
      this.#state = {
        ...this.#state,
        lastOperation: operation,
        error: undefined,
      }
    } else {
      this.#state = {
        ...this.#state,
        lastOperation: operation,
        error: undefined,
      }
    }
    await this.refresh({ preserveError: operation.state === 'failed' })
    window.dispatchEvent(new CustomEvent('agnes:packages-changed'))
    if (operation.state === 'completed' && packageId) {
      const installed =
        operation.installed ?? this.#state.installed.find((candidate) => candidate.id === packageId)
      await this.reconcileRuntimeAfterOperation(
        operation,
        packageId,
        installed?.integrity,
        installed === undefined || hasClientContribution(installed),
      )
    }
    if (
      operation.state === 'completed' &&
      operation.operation === 'enable' &&
      packageId === this.#exampleFlowId
    ) {
      this.#exampleFlowId = undefined
      this.#detailDismissed = true
      this.#state = { ...this.#state, selectedId: undefined, selectedCatalog: undefined }
      setDialog(this.#detail, false)
      this.render()
    }
    if (operation.state === 'completed' && completion) {
      try {
        await completion(operation)
      } catch (error) {
        this.showError(error)
      }
    }
  }

  openPreview(preview: PackagePreview, mode: PreviewMode): void {
    this.#confirmTrigger ??= this.#sourceTrigger ?? this.#listHost
    const installed =
      mode === 'update' ? this.#state.installed.find((item) => item.id === preview.id) : undefined
    const combined = !!installed && this.canCombineUpdate(installed, preview)
    this.configureConfirm({
      title: () =>
        `${this.#t(mode === 'install' ? 'preview.title.install' : 'preview.title.update')} · ${preview.id}`,
      description: () =>
        this.#t(
          mode === 'install'
            ? 'preview.description.install'
            : combined
              ? 'preview.description.update-combined'
              : 'preview.description.update-compatible',
        ),
      label: () =>
        this.#t(
          mode === 'install'
            ? 'preview.action.install'
            : combined
              ? 'preview.action.update-activate'
              : 'preview.action.update',
        ),
      facts: (
        <>
          <ProvenanceReview value={preview.provenance} t={this.#t} />
          <CapabilityReview value={preview.declaredCapabilities} t={this.#t} />
          {combined ? (
            <UpdateActivationFacts installed={installed!} preview={preview} />
          ) : (
            <PreviewConfirmationFacts preview={preview} />
          )}
        </>
      ),
      run: () => this.confirmPreview(),
    })
  }

  configureConfirm(pending: PendingConfirm): void {
    this.#pendingConfirm = pending
    this.#confirmActionDisabled = false
    this.renderConfirm()
    setDialog(
      this.#confirmDialog,
      true,
      this.#confirmDialog.querySelector('button.primary-button') ?? undefined,
    )
  }

  closeConfirm(): void {
    this.#exampleInstallId = undefined
    this.#pendingConfirm = undefined
    this.renderConfirm()
    setDialog(this.#confirmDialog, false)
    this.#confirmTrigger?.focus({ preventScroll: true })
    this.#confirmTrigger = undefined
  }

  effectApi(permission: string): PluginAdminApi | undefined {
    if (!this.#api || !this.#state.context) {
      this.showError({
        code: 'ADMIN_UNAVAILABLE',
        message: this.#t('error.session'),
      })
      return undefined
    }
    if (this.#state.context.readOnly) {
      this.showError({
        code: 'RECOVERY_READ_ONLY',
        message: this.#t('error.read-only'),
      })
      return undefined
    }
    if (this.#state.loading || this.#state.connection !== 'connected') {
      this.showError({
        code: 'ADMIN_UNAVAILABLE',
        message: this.#t('error.restoring'),
      })
      return undefined
    }
    if (!this.can(permission)) {
      this.showError({
        code: 'ADMIN_FORBIDDEN',
        message: this.#t('error.forbidden'),
      })
      return undefined
    }
    return this.#api
  }

  can(permission: string): boolean {
    return !!this.#state.context && hasPermission(this.#state.context.permissions, permission)
  }

  canEffect(permission: string): boolean {
    return (
      !!this.#state.context &&
      !this.#state.context.readOnly &&
      !this.#state.loading &&
      this.#state.connection === 'connected' &&
      this.can(permission)
    )
  }

  supportsCompositeActivation(): boolean {
    return hasFeature(this.#state.context, ADMIN_FEATURES.compositeActivation)
  }

  activeIntegrity(item: PackageInstalledDescriptor): string | null | undefined {
    if (!hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity)) return undefined
    if (item.actualIntegrity) return item.actualIntegrity
    if (item.actual === 'not-running') return null
    const runtime = this.runtimeState(item.id)
    if (
      item.actual === 'starting' &&
      isClientOnly(item) &&
      this.actualSlots?.(item.id).length === 0 &&
      (runtime === undefined || runtime.phase === 'idle')
    )
      return null
    return undefined
  }

  canCombineUpdate(item: PackageInstalledDescriptor, preview: PackagePreview): boolean {
    return (
      this.supportsCompositeActivation() &&
      this.activeIntegrity(item) !== undefined &&
      !!preview.capabilityHash &&
      this.can('packages.install') &&
      this.can('packages.trust') &&
      this.can('packages.activate')
    )
  }

  packageBusy(packageId: string): boolean {
    if (this.#submittingPackages.has(packageId)) return true
    return [...this.#state.operations.values()].some(
      (operation) =>
        !terminal(operation) &&
        (operation.packageId === packageId ||
          this.#operationPackages.get(operation.operationId) === packageId),
    )
  }

  async submitPackage<T>(packageId: string, submit: () => Promise<T>): Promise<T> {
    if (this.packageBusy(packageId))
      throw new AdminApiError({
        code: 'PACKAGE_BUSY',
        message: this.#t('error.busy'),
      })
    this.#submittingPackages.add(packageId)
    this.render()
    try {
      return await submit()
    } catch (error) {
      this.#submittingPackages.delete(packageId)
      this.render()
      throw error
    }
  }

  showError(error: unknown): void {
    const detail =
      error && typeof error === 'object' && 'message' in error ? (error as AdminError) : safeMessage(error)
    this.#state = { ...this.#state, error: detail }
    this.render()
  }

  errorMessage(error: AdminError): string {
    const keyByCode: Readonly<Record<string, string>> = {
      ADMIN_UNAVAILABLE: 'error.connection',
      RECOVERY_READ_ONLY: 'error.read-only',
      ADMIN_FORBIDDEN: 'error.forbidden',
      FORBIDDEN: 'error.forbidden',
      PACKAGE_BUSY: 'error.busy',
      ADMIN_CONTEXT_INVALID: 'error.context-invalid',
      ADMIN_RESPONSE_INVALID: 'error.response-invalid',
      RUNTIME_NOT_CONFIRMED: 'notice.runtime-pending',
      RUNTIME_IDENTITY_UNKNOWN: 'error.runtime-unconfirmed',
      E_PACKAGE_TRUST: 'error.capability-unconfirmed',
      E_PACKAGE_STATE: 'error.state-changed',
    }
    const key = keyByCode[error.code]
    return this.#t(key ?? 'error.operation-failed')
  }

  track(
    operationId: string,
    metadata: Readonly<{ mode?: PreviewMode; packageId?: string }> = {},
    completion?: (operation: PackageOperation) => Promise<void>,
  ): void {
    const context = this.#state.context
    if (!context) return
    if (metadata.mode) this.#operationModes.set(operationId, metadata.mode)
    if (metadata.packageId) this.#operationPackages.set(operationId, metadata.packageId)
    if (completion) this.#operationCompletions.set(operationId, completion)
    this.#detailDismissed = false
    this.#state = {
      ...this.#state,
      lastOperation: undefined,
      error: undefined,
    }
    const records = new Map(this.operationRecords(context).map((entry) => [entry.operationId, entry]))
    records.set(operationId, { operationId, ...metadata })
    sessionStorage.setItem(this.operationStorageKey(context), JSON.stringify([...records.values()]))
    void this.poll(operationId)
  }

  restoreOperations(context: AdminContext): void {
    for (const record of this.operationRecords(context)) {
      if (record.mode) this.#operationModes.set(record.operationId, record.mode)
      if (record.packageId) {
        this.#operationPackages.set(record.operationId, record.packageId)
        this.#submittingPackages.add(record.packageId)
      }
      void this.poll(record.operationId)
    }
  }

  async poll(operationId: string): Promise<void> {
    const api = this.#api
    if (!api || this.#operationTimers.has(operationId)) return
    this.#operationTimers.set(operationId, -1)
    try {
      const operation = await api.operation(operationId)
      const packageId = operation.packageId ?? this.#operationPackages.get(operationId)
      if (packageId) this.#submittingPackages.delete(packageId)
      const operations = new Map(this.#state.operations)
      operations.set(operationId, operation)
      this.#state = {
        ...this.#state,
        operations,
        connection: 'connected',
        error: undefined,
      }
      this.render()
      if (terminal(operation)) {
        await this.operationUpdated(operation)
        return
      }
      const timer = window.setTimeout(() => {
        this.#operationTimers.delete(operationId)
        void this.poll(operationId)
      }, ACTIVE_REFRESH_MS)
      this.#operationTimers.set(operationId, timer)
    } catch (error) {
      this.#operationTimers.delete(operationId)
      const detail = safeMessage(error)
      this.#state = { ...this.#state, connection: 'offline', error: detail }
      this.render()
      if (
        !['E_ADMIN_AUTH', 'E_ADMIN_SCOPE', 'E_ADMIN_ORIGIN', 'ADMIN_FORBIDDEN', 'FORBIDDEN'].includes(
          detail.code,
        )
      ) {
        const timer = window.setTimeout(() => {
          this.#operationTimers.delete(operationId)
          void this.poll(operationId)
        }, RECONNECT_REFRESH_MS)
        this.#operationTimers.set(operationId, timer)
      }
    }
  }

  forgetOperation(operationId: string): void {
    const timer = this.#operationTimers.get(operationId)
    if (timer !== undefined && timer !== -1) clearTimeout(timer)
    this.#operationTimers.delete(operationId)
    const operations = new Map(this.#state.operations)
    operations.delete(operationId)
    this.#state = { ...this.#state, operations }
    const context = this.#state.context
    if (!context) return
    this.#operationModes.delete(operationId)
    this.#operationPackages.delete(operationId)
    const next = this.operationRecords(context).filter((value) => value.operationId !== operationId)
    if (next.length) sessionStorage.setItem(this.operationStorageKey(context), JSON.stringify(next))
    else sessionStorage.removeItem(this.operationStorageKey(context))
  }

  operationStorageKey(context: AdminContext): string {
    return storedOperationKey(context)
  }

  operationRecords(context: AdminContext): TrackedOperation[] {
    return readOperationRecords(context)
  }

  settingsText(key: string): string {
    return createUiTranslator(this.#locale, SETTINGS_NAMESPACE, settingsCatalog)(key)
  }

  render(): void {
    renderPluginView.call(this.viewContext())
  }

  /** React 键控行会复用 DOM：键盘焦点跟随 data-plugin-id 保留，无需手工恢复。 */

  renderDetail(): void {
    renderDetailPluginView.call(this.viewContext())
  }

  detailOperations(id?: string) {
    return [...this.#state.operations.values()]
      .filter((operation) =>
        id === undefined
          ? true
          : operation.packageId === id ||
            this.#operationPackages.get(operation.operationId) === id ||
            operation.installed?.id === id ||
            operation.preview?.id === id,
      )
      .map((operation) => ({
        operation,
        canCancel:
          !terminal(operation) &&
          operation.cancellable === true &&
          hasFeature(this.#state.context, ADMIN_FEATURES.operationControl) &&
          this.canEffect('packages.activate'),
      }))
  }

  detailActions(item: PackageInstalledDescriptor | PackageCatalogDescriptor): readonly DetailActionSpec[] {
    const specs: DetailActionSpec[] = []
    const busy = this.packageBusy(item.id)
    if ('desired' in item) {
      const installed = item as PackageInstalledDescriptor
      const links = this.surfaceLinks(item.id)
      for (const link of links) {
        specs.push({
          label:
            links.length === 1
              ? this.#t('surface.open', { mount: link.mount })
              : this.#t('surface.open-named', { surface: link.surfaceId, mount: link.mount }),
          className: 'secondary-button compact plugin-surface-link',
          href: link.mount,
          ariaLabel: this.#t('surface.open-aria', {
            id: item.id,
            surface: link.surfaceId,
            mount: link.mount,
          }),
          onClick: () => {},
        })
      }
      specs.push({
        label: this.#t('action.update-catalog'),
        className: 'secondary-button',
        disabled: !this.canEffect('packages.install') || busy,
        onClick: () => void this.chooseUpdateVersion(installed),
      })
      specs.push({
        label: this.#t('action.update-source'),
        className: 'secondary-button',
        disabled: !this.canEffect('packages.install') || busy,
        onClick: () => this.openSourceDialog('update', installed),
      })
      const target = installed.rollbackTarget
      const rollbackReady =
        !!target &&
        hasFeature(this.#state.context, ADMIN_FEATURES.rollbackTarget) &&
        this.supportsCompositeActivation() &&
        this.activeIntegrity(installed) !== undefined &&
        this.canEffect('packages.remove') &&
        this.can('packages.trust') &&
        this.can('packages.activate') &&
        !busy
      specs.push({
        label: target
          ? this.#t('action.rollback', { version: target.version })
          : this.#t('action.rollback-unknown'),
        className: 'secondary-button',
        disabled: !rollbackReady,
        title: rollbackReady ? this.#t('action.rollback-ready') : this.#t('action.rollback-unavailable'),
        onClick: () => this.confirmRollback(installed),
      })
      specs.push({
        label: this.#t('action.remove'),
        className: 'danger-button',
        disabled: !this.canEffect('packages.remove') || installed.blockers.length > 0 || busy,
        onClick: () => this.confirmRemove(installed),
      })
      return specs
    }
    const catalog = item as PackageCatalogDescriptor
    const installed = this.#state.installed.some((candidate) => candidate.id === catalog.id)
    specs.push({
      label: installed ? this.#t('action.check-update') : this.#t('action.check-install-content'),
      className: 'primary-button',
      disabled:
        catalog.compatibility === 'unsupported' ||
        !this.canEffect('packages.install') ||
        (installed && this.packageBusy(catalog.id)),
      onClick: () =>
        void this.inspect(
          catalog.source,
          installed ? 'update' : 'install',
          button('install-source'),
          installed ? catalog.id : undefined,
        ),
    })
    return specs
  }

  filteredInstalled(): readonly PackageInstalledDescriptor[] {
    return this.#state.installed.filter((item) =>
      matchesPluginSearch(item, this.#query, this.presentationOf(item), (kind) =>
        createUiTranslator(
          this.#locale,
          PLUGIN_PRESENTATION_NAMESPACE,
          pluginPresentationCatalog,
        )(`provide.${kind}`),
      ),
    )
  }

  presentationOf(item: PackageInstalledDescriptor | PackageCatalogDescriptor) {
    return pluginPresentation(
      item,
      this.#state.inventoryAuthoritative
        ? {
            runtime: this.#presentationRuntime,
            composition: this.#presentationComposition,
            slots: this.actualSlots?.(item.id),
            surfaces: this.surfaceLinks(item.id),
          }
        : {},
    )
  }

  surfaceLinks(packageId: string): readonly AdminSurfaceLink[] {
    return this.#state.surfaceLinks.filter((surface) => surface.packageId === packageId)
  }

  runtimeState(packageId: string): PluginRuntimeState | undefined {
    const states = [...this.#state.runtime.values()].filter((state) => state.packageId === packageId)
    return states.find((state) => state.phase === 'failed') ?? states.at(-1)
  }

  async reconcileRuntimeAfterOperation(
    operation: PackageOperation,
    packageId: string,
    expectedRevision: string | undefined,
    hasBrowserUi: boolean,
  ): Promise<void> {
    if (!this.#runtime || !['enable', 'disable', 'update'].includes(operation.operation)) return
    if (!hasBrowserUi) return
    if (!expectedRevision) {
      this.#state = {
        ...this.#state,
        error: {
          code: 'RUNTIME_NOT_CONFIRMED',
          message: 'The host completed the operation, but the browser UI state is not confirmed yet.',
        },
      }
      this.render()
      return
    }
    try {
      await this.#runtime.invalidate()
    } catch {
      this.#state = {
        ...this.#state,
        error: {
          code: 'RUNTIME_NOT_CONFIRMED',
          message: 'The host completed the operation, but the browser UI state is not confirmed yet.',
        },
      }
      this.render()
      return
    }

    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      const states = [...this.#state.runtime.values()].filter((state) => state.packageId === packageId)
      const hasWrongActiveRevision = states.some(
        (state) => state.phase === 'active' && state.revision !== expectedRevision,
      )
      const matching = states.filter((state) => state.revision === expectedRevision)
      const matchingFailed = matching.some((state) => state.phase === 'failed')
      if (matchingFailed) break
      if (
        matching.length > 0 &&
        !hasWrongActiveRevision &&
        matching.every((state) =>
          operation.operation === 'disable' ? state.phase === 'idle' : state.phase === 'active',
        )
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.#state = {
      ...this.#state,
      error: {
        code: 'RUNTIME_NOT_CONFIRMED',
        message: 'The host completed the operation, but the browser UI state is not confirmed yet.',
      },
    }
    this.render()
  }

  scheduleTreePoll(): void {
    if (this.#treeTimer !== undefined) window.clearTimeout(this.#treeTimer)
    this.#treeTimer = window.setTimeout(() => {
      this.#treeTimer = undefined
      void this.pollTree()
    }, ACTIVE_REFRESH_MS)
  }

  #treeTimer: number | undefined

  async pollTree(): Promise<void> {
    const api = this.#api
    if (!api || this.#state.connection !== 'connected') return
    try {
      const tree = await api.treeList()
      this.#state = { ...this.#state, tree }
      this.render()
    } catch {
      // Lost tree_changed recovers by the next successful poll, not by inventing actual.
    }
    this.scheduleTreePoll()
  }

  primaryAction(item: PackageInstalledDescriptor | PackageCatalogDescriptor): {
    label: string
    disabled: boolean
    run: () => Promise<void>
  } {
    if (this.#tab === 'discover') {
      const catalog = item as PackageCatalogDescriptor
      const installed = this.#state.installed.some((candidate) => candidate.id === catalog.id)
      return {
        label:
          catalog.compatibility === 'unsupported'
            ? this.#t('action.unsupported')
            : installed
              ? this.#t('action.check-update')
              : this.#t('action.check-install'),
        disabled:
          !this.canEffect('packages.install') ||
          catalog.compatibility === 'unsupported' ||
          (installed && this.packageBusy(catalog.id)),
        // A catalog entry has no dialog to keep open: a failure already reaches the page notice.
        run: async () => {
          await this.inspect(
            sourceForCatalog(catalog),
            installed ? 'update' : 'install',
            button('install-source'),
            installed ? catalog.id : undefined,
          )
        },
      }
    }
    const installed = item as PackageInstalledDescriptor
    if (installed.trusted && this.runtimeState(installed.id)?.phase === 'failed') {
      return {
        label: this.#t('action.retry-ui'),
        disabled: this.packageBusy(installed.id),
        run: async () => {
          if (!this.#runtime) return
          try {
            await this.#runtime.invalidate()
          } catch {
            this.#state = {
              ...this.#state,
              error: {
                code: 'RUNTIME_NOT_CONFIRMED',
                message: 'The browser UI state is not confirmed. You can retry later.',
              },
            }
            this.render()
          }
        },
      }
    }
    return installed.actual === 'running'
      ? {
          label: this.#t('action.disable'),
          disabled: !this.canEffect('packages.activate') || this.packageBusy(installed.id),
          run: () => this.confirmDisable(installed),
        }
      : {
          label:
            hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
            this.activeIntegrity(installed) === undefined
              ? this.#t('action.runtime-unconfirmed')
              : this.#t('action.enable'),
          disabled:
            !this.canEffect('packages.activate') ||
            (!installed.trusted && (!this.can('packages.trust') || !installed.capabilityHash)) ||
            this.packageBusy(installed.id) ||
            (hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
              this.activeIntegrity(installed) === undefined),
          run: () => this.confirmEnable(installed),
        }
  }

  selectItem(item: PackageInstalledDescriptor | PackageCatalogDescriptor): void {
    // React 键控行复用 DOM：触发行查询自渲染结果，详情关闭后焦点可以精确归还。
    this.#detailTrigger =
      this.#listHost.querySelector<HTMLElement>(`.plugin-row[data-plugin-id="${CSS.escape(item.id)}"]`) ??
      undefined
    this.#detailDismissed = false
    if (this.#tab === 'installed') {
      this.#state = {
        ...this.#state,
        selectedId: item.id,
        selectedCatalog: undefined,
      }
    } else {
      this.#state = {
        ...this.#state,
        selectedCatalog: item as PackageCatalogDescriptor,
        selectedId: undefined,
      }
    }
    this.render()
  }

  hasDetail(): boolean {
    return (
      !!this.#state.selectedId ||
      !!this.#state.selectedCatalog ||
      (!this.#detailDismissed &&
        (this.#state.operations.size > 0 ||
          !!this.#state.lastOperation ||
          !!this.#state.error?.blockers?.length))
    )
  }

  closeDetail(): void {
    const targetId = this.#detailTrigger?.dataset.pluginId
    this.#detailDismissed = true
    this.#state = {
      ...this.#state,
      selectedId: undefined,
      selectedCatalog: undefined,
    }
    this.#detailTrigger = undefined
    this.render()
    if (!targetId) return
    for (const row of this.#listHost.querySelectorAll<HTMLElement>('.plugin-row')) {
      if (row.dataset.pluginId === targetId) {
        row.focus({ preventScroll: true })
        return
      }
    }
  }

  async chooseUpdateVersion(item: PackageInstalledDescriptor): Promise<void> {
    this.#tab = 'discover'
    this.#query = item.id
    this.#queryRaw = item.id
    this.#state = {
      ...this.#state,
      selectedCatalog: undefined,
      selectedId: undefined,
    }
    this.render()
    await this.loadCatalog()
  }

  confirmEnable(item: PackageInstalledDescriptor): Promise<void> {
    if (
      hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
      this.activeIntegrity(item) === undefined
    ) {
      this.showError({
        code: 'RUNTIME_IDENTITY_UNKNOWN',
        message:
          'The actual runtime summary has not been confirmed, so this plugin cannot be safely enabled.',
      })
      return Promise.resolve()
    }
    const capabilityHash = item.capabilityHash
    if (!item.trusted && !capabilityHash) {
      this.showError({
        code: 'E_PACKAGE_TRUST',
        message: 'The capability summary has not been confirmed, so this version cannot be safely enabled.',
      })
      return Promise.resolve()
    }
    this.configureConfirm({
      title: () => this.#t('confirm.enable.title', { id: item.id }),
      description: () => this.#t(item.trusted ? 'confirm.enable.trusted' : 'confirm.enable.verify'),
      label: () => this.#t('confirm.enable.action'),
      facts: (
        <>
          <ProvenanceReview value={item.provenance} t={this.#t} />
          <CapabilityReview value={item.declaredCapabilities} t={this.#t} />
          {!item.trusted ? <TrustConfirmationFacts item={item} leadKey="lead.trust-enable" /> : undefined}
        </>
      ),
      run: async () => {
        if (item.trusted) {
          await this.#submitEnable(item)
          return
        }
        const api = this.effectApi('packages.trust')
        if (!api || !this.canEffect('packages.activate') || !capabilityHash) return
        const receipt = await this.submitPackage(item.id, () =>
          api.trust(item.id, item.integrity, capabilityHash),
        )
        this.track(receipt.operationId, { packageId: item.id }, async () => {
          const current = this.#state.installed.find((candidate) => candidate.id === item.id)
          if (!current || current.integrity !== item.integrity || current.capabilityHash !== capabilityHash) {
            this.showError({
              code: 'E_PACKAGE_STATE',
              message:
                'The plugin version or capability scope has changed. Review the latest details before enabling it again.',
            })
            return
          }
          await this.#submitEnable(current)
        })
      },
    })
    return Promise.resolve()
  }

  async #submitEnable(item: PackageInstalledDescriptor): Promise<void> {
    const api = this.effectApi('packages.activate')
    if (!api) return
    const activeIntegrity = this.activeIntegrity(item)
    if (hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) && activeIntegrity === undefined) {
      this.showError({
        code: 'RUNTIME_IDENTITY_UNKNOWN',
        message:
          'The actual runtime summary has not been confirmed, so this plugin cannot be safely enabled.',
      })
      return
    }
    const receipt = await this.submitPackage(item.id, () =>
      activeIntegrity === undefined
        ? api.enable(item.id)
        : api.enableChecked(item.id, item.integrity, activeIntegrity),
    )
    this.track(receipt.operationId, { packageId: item.id })
  }

  confirmDisable(item: PackageInstalledDescriptor): Promise<void> {
    this.configureConfirm({
      title: () => this.#t('confirm.disable.title', { id: item.id }),
      description: () => this.#t('confirm.disable.description'),
      label: () => this.#t('confirm.disable.action'),
      run: async () => {
        const api = this.effectApi('packages.activate')
        if (!api) return
        const receipt = await this.submitPackage(item.id, () => api.disable(item.id))
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
    return Promise.resolve()
  }

  confirmRemove(item: PackageInstalledDescriptor): void {
    this.configureConfirm({
      title: () => this.#t('confirm.remove.title', { id: item.id }),
      description: () => this.#t('confirm.remove.description'),
      label: () => this.#t('confirm.remove.action'),
      run: async () => {
        const api = this.effectApi('packages.remove')
        if (!api) return
        const receipt = await this.submitPackage(item.id, () => api.remove(item.id))
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
  }

  confirmRollback(item: PackageInstalledDescriptor): void {
    const target = item.rollbackTarget
    const activeIntegrity = this.activeIntegrity(item)
    if (!target || activeIntegrity === undefined || !this.supportsCompositeActivation()) return
    this.configureConfirm({
      title: () => this.#t('confirm.rollback.title', { id: item.id, version: target.version }),
      description: () => this.#t('confirm.rollback.description'),
      label: () => this.#t('confirm.rollback.action'),
      facts: <RollbackActivationFacts installed={item} />,
      run: async () => {
        const api = this.effectApi('packages.remove')
        if (!api || !this.can('packages.trust') || !this.can('packages.activate')) return
        const receipt = await this.submitPackage(item.id, () =>
          api.rollback(item.id, target.integrity, {
            expectedInstalledIntegrity: item.integrity,
            expectedActiveIntegrity: activeIntegrity,
            trust: {
              integrity: target.integrity,
              capabilityHash: target.capabilityHash,
            },
          }),
        )
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
  }

  confirmReleasePins(pinIds: readonly string[], trigger: HTMLElement): void {
    if (!pinIds.length) return
    this.#confirmTrigger = trigger
    this.configureConfirm({
      title: () =>
        pinIds.length === 1
          ? this.#t('confirm.release.one', { id: pinIds[0]! })
          : this.#t('confirm.release.all', { count: pinIds.length }),
      description: () => this.#t('confirm.release.description'),
      label: () => this.#t('confirm.release.action'),
      run: async () => {
        const api = this.effectApi('packages.remove')
        if (!api) return
        // Apply each chunk's results as it arrives: a later chunk's failure must not discard the
        // UI update for chunks that already succeeded (release is non-transactional per pinId).
        let skipped = 0
        for (let offset = 0; offset < pinIds.length; offset += PIN_RELEASE_BATCH_SIZE) {
          const chunk = pinIds.slice(offset, offset + PIN_RELEASE_BATCH_SIZE)
          const response = await api.pinsRelease(chunk)
          skipped = this.applyPinReleaseResults(response.results, skipped)
        }
      },
    })
  }

  applyPinReleaseResults(results: readonly RuntimePinReleaseResult[], skippedSoFar = 0): number {
    let skipped = skippedSoFar
    for (const result of results) {
      if (result.outcome === 'failed') {
        this.#orphanPinErrors.set(result.pinId, result.error?.safeMessage ?? this.#t('error.pin-release'))
        continue
      }
      if (result.outcome === 'skipped-no-longer-orphaned') skipped++
      this.#orphanPinErrors.delete(result.pinId)
      this.#orphanPinList = this.#orphanPinList.filter((pin) => pin.pinId !== result.pinId)
    }
    this.#orphanPinNotice = skipped > 0 ? skipped : undefined
    this.render()
    return skipped
  }

  async cancelOperation(operationId: string, trigger: HTMLButtonElement): Promise<void> {
    const api = this.effectApi('packages.activate')
    if (!api) return
    trigger.disabled = true
    try {
      const receipt = await api.cancel(operationId)
      this.track(receipt.operationId)
    } catch (error) {
      this.showError(error)
    } finally {
      trigger.disabled = false
    }
  }

  renderConfirm(): void {
    renderConfirmPluginView.call(this.viewContext())
  }

  renderSource(): void {
    renderSourcePluginView.call(this.viewContext())
  }

  dispose(): void {
    this.#runtimeStop?.()
    this.#runtimeStop = undefined
    this.#localeStop()
    this.#localeCleanup?.()
    if (this.#treeTimer !== undefined) window.clearTimeout(this.#treeTimer)
    for (const timer of this.#operationTimers.values()) {
      if (timer >= 0) window.clearTimeout(timer)
    }
    this.#operationTimers.clear()
    this.#operationCompletions.clear()
    unmountRegion(this.#orphanPinsHost)
    unmountRegion(this.#listHost)
    unmountRegion(this.#detail)
    unmountRegion(this.#sourceDialog)
    unmountRegion(this.#confirmDialog)
  }
}

export type PluginAdminViewContext = ReturnType<PluginAdminPage['viewContext']>
