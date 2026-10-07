import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
  PackageSource,
  RuntimePinDescriptor,
  RuntimePinReleaseResult,
} from '@agnes/protocol'
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
  blockerText,
  ConfirmDialogContent,
  contributionText,
  createDocumentLocaleSource,
  createUiTranslator,
  type DetailActionSpec,
  DetailContent,
  hasPermission,
  integrityLabel,
  OrphanPins,
  operationLabel,
  PluginList,
  PreviewConfirmationFacts,
  RollbackActivationFacts,
  type RuntimeStateView,
  renderRegion,
  SourceDialogContent,
  sourceLabel,
  TrustConfirmationFacts,
  terminal,
  UiLocaleProvider,
  type UiLocaleSource,
  UpdateActivationFacts,
  unmountRegion,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import type { PluginRuntimeState } from '../../client-modules/runtime-status.js'
import { AdminApiError, PluginAdminApi } from './api.js'
import {
  KindFilter,
  PluginBadges,
  type PluginKind,
  pluginFailureMessage,
  SessionDefaultsPanel,
} from './control-panel.js'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'
import { SOURCE_FORMATS, sourceFromForm, sourceProblem } from './source-form.js'
import {
  ADMIN_FEATURES,
  type AdminContext,
  type AdminError,
  type AdminPageState,
  type AdminSurfaceLink,
  hasFeature,
  type PluginRuntimeSource,
  type PluginTreeView,
} from './types.js'

const OPERATION_STORAGE_PREFIX = 'agnes-plugin-operation-ids:'
const ACTIVE_REFRESH_MS = 1_200
const RECONNECT_REFRESH_MS = 3_000
// Must match PackagePinsReleaseParams.pinIds maxItems in packages/protocol/schema/package-admin.json.
// "Release all" can see far more orphans than one release call accepts, so it batches.
const PIN_RELEASE_BATCH_SIZE = 64

type PreviewMode = 'install' | 'update'
type SourceInlineError = { code: string; message: string }
type TrackedOperation = Readonly<{
  operationId: string
  mode?: PreviewMode
  packageId?: string
}>
type PendingConfirm = {
  title: string | (() => string)
  description: string | (() => string)
  label: string | (() => string)
  run: () => Promise<void>
  facts?: ReactNode
}

type PluginAdminOptions = Readonly<{
  actualSlots?: (packageId: string) => readonly string[]
  locale?: UiLocaleSource
  runtime?: PluginRuntimeSource
}>

const pluginAdminCatalogs = {
  [PLUGIN_ADMIN_LOCALE_NAMESPACE]: pluginAdminLocaleCatalog,
  [ADMIN_CONFIRMATION_LOCALE_NAMESPACE]: adminConfirmationLocaleCatalog,
  [ADMIN_DETAIL_LOCALE_NAMESPACE]: adminDetailLocaleCatalog,
  [ADMIN_DIALOGS_LOCALE_NAMESPACE]: adminDialogsLocaleCatalog,
  [ADMIN_LIST_LOCALE_NAMESPACE]: adminListLocaleCatalog,
  [ADMIN_LOCALE_NAMESPACE]: adminLocaleCatalog,
} as const

const SOURCE_TYPE_OPTIONS = Object.keys(SOURCE_FORMATS).map((type) => ({
  value: type,
  label: type,
}))

function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}

function button(id: string): HTMLButtonElement {
  return element(id, 'button')
}

function setDialog(dialog: HTMLDialogElement, open: boolean, focus?: HTMLElement): void {
  if (open) {
    for (const other of document.querySelectorAll('dialog[open]')) {
      if (other === dialog) continue
      // The settings dialog is the page these dialogs belong to: closing it left the user with
      // nothing on screen after every source check, confirmation or detail view.
      if (other.id === 'config') continue
      try {
        if (other instanceof HTMLDialogElement && other.open) other.close()
        else other.removeAttribute('open')
      } catch {
        other.removeAttribute('open')
      }
    }
  }
  if (open && !dialog.open) {
    try {
      dialog.showModal()
    } catch {
      dialog.setAttribute('open', '')
    }
  }
  if (!open && dialog.open) {
    try {
      dialog.close()
    } catch {
      dialog.removeAttribute('open')
    }
  }
  if (open) focus?.focus()
}

function safeMessage(error: unknown): AdminError {
  if (error instanceof AdminApiError) return error.details
  return {
    code: 'ADMIN_UNAVAILABLE',
    message: 'Could not connect to the plugin admin service. The current page content has been kept.',
  }
}

function hasClientContribution(item: PackageInstalledDescriptor): boolean {
  return item.contributions.some(
    (contribution) =>
      (contribution.kind === 'client' && 'client' in contribution) ||
      (contribution.kind === 'extension' && contribution.client !== undefined),
  )
}

function isClientOnly(item: PackageInstalledDescriptor): boolean {
  return (
    item.contributions.length > 0 &&
    item.contributions.every(
      (contribution) =>
        contribution.kind === 'extension' &&
        contribution.client !== undefined &&
        Object.keys(contribution.capabilities ?? {}).every((capability) => capability === 'ui'),
    )
  )
}

function sourceForCatalog(item: PackageCatalogDescriptor): PackageSource {
  return item.source
}

function pinPurposeLabel(purpose: RuntimePinDescriptor['purpose'], t: (key: string) => string): string {
  const key: Record<RuntimePinDescriptor['purpose'], string> = {
    active: 'pin.active',
    candidate: 'pin.candidate',
    recovery: 'pin.recovery',
    rollback: 'pin.rollback',
    turn: 'pin.turn',
  }
  return t(key[purpose])
}

function asRuntimeView(state: PluginRuntimeState | undefined): RuntimeStateView | undefined {
  return state
}

class PluginAdminPage {
  readonly #runtime: PluginRuntimeSource | undefined
  #runtimeStop: (() => void) | undefined
  readonly #locale: UiLocaleSource
  readonly #localeStop: () => void
  readonly #localeCleanup: (() => void) | undefined
  readonly #t: ReturnType<typeof createUiTranslator>
  readonly #adminT: ReturnType<typeof createUiTranslator>
  private readonly actualSlots: ((packageId: string) => readonly string[]) | undefined

  constructor(options: PluginAdminOptions = {}) {
    this.actualSlots = options.actualSlots
    this.#runtime = options.runtime
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
  readonly #tabs = {
    installed: button('installed-tab'),
    discover: button('discover-tab'),
  } as const
  readonly #search = element('plugin-search', 'input')
  readonly #layout = element('plugin-layout', 'div')
  readonly #listHost = element('plugin-list', 'section')
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
    button('install-source').addEventListener('click', () => this.openSourceDialog('install'))
    // 页签交互（点击 + 方向键/Home/End）与搜索框留在骨架元素上：它们是静态结构，
    // 状态切换由 syncTabs 用 aria-selected/tabIndex 表达。
    for (const name of ['installed', 'discover'] as const) {
      this.#tabs[name].addEventListener('click', () => void this.selectTab(name))
    }
    this.#tabs.installed.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'Home') {
        event.preventDefault()
        void this.selectTab('discover')
        this.#tabs.discover.focus()
      }
    })
    this.#tabs.discover.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'End') {
        event.preventDefault()
        void this.selectTab('installed')
        this.#tabs.installed.focus()
      }
    })
    this.#search.addEventListener('input', () => {
      this.#queryRaw = this.#search.value
      this.#query = this.#search.value.trim()
      if (this.#tab === 'installed') this.render()
      else void this.loadCatalog()
    })
    this.#sourceDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeSourceDialog()
    })
    this.#confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeConfirm()
    })
  }

  /** 页签选中态：aria-selected 与 roving tabIndex 同步（同组只保留一个 tabindex=0）。 */
  syncTabs(): void {
    for (const name of ['installed', 'discover'] as const) {
      const selected = this.#tab === name
      const tab = this.#tabs[name]
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
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
      const list = await this.#api.list()
      if (generation !== this.#generation) return
      let surfaceLinks: readonly AdminSurfaceLink[] = []
      try {
        surfaceLinks = (await this.#api.surfaceLinks()).surfaces
      } catch {
        // Surface links are supplementary. Never hide a valid installed inventory because the
        // live route feed is unavailable, and never retain a stale link after it can no longer
        // be confirmed.
      }
      if (generation !== this.#generation) return
      let tree: PluginTreeView | undefined
      try {
        tree = await this.#api.treeList()
      } catch {
        // Tree actual is the qualified report view. A miss must not hide installed inventory.
      }
      if (generation !== this.#generation) return
      this.#state = {
        ...this.#state,
        context,
        installed: list.packages,
        surfaceLinks,
        tree,
        inventoryAuthoritative: true,
        loading: false,
        connection: 'connected',
      }
      this.scheduleTreePoll()
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
    this.track(receipt.operationId, { packageId: preview.id })
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
    if (operation.state === 'completed' && completion) {
      try {
        await completion(operation)
      } catch (error) {
        this.showError(error)
      }
    }
  }

  openPreview(preview: PackagePreview, mode: PreviewMode): void {
    this.#confirmTrigger = this.#sourceTrigger ?? button('install-source')
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
      facts: combined ? (
        <UpdateActivationFacts installed={installed!} preview={preview} />
      ) : (
        <PreviewConfirmationFacts preview={preview} />
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
    return key ? this.#t(key) : error.message
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
    return `${OPERATION_STORAGE_PREFIX}${context.authScope ?? `legacy.${context.clientId}`}:${context.profile}`
  }

  operationRecords(context: AdminContext): TrackedOperation[] {
    try {
      const stored = JSON.parse(sessionStorage.getItem(this.operationStorageKey(context)) ?? '[]')
      if (!Array.isArray(stored)) return []
      return stored.flatMap((value): TrackedOperation[] => {
        if (typeof value === 'string') return [{ operationId: value }]
        if (!value || typeof value !== 'object') return []
        const record = value as Record<string, unknown>
        if (typeof record.operationId !== 'string') return []
        return [
          {
            operationId: record.operationId,
            ...(record.mode === 'install' || record.mode === 'update' ? { mode: record.mode } : {}),
            ...(typeof record.packageId === 'string' ? { packageId: record.packageId } : {}),
          },
        ]
      })
    } catch {
      return []
    }
  }

  render(): void {
    const { context, connection, error, loading, tree } = this.#state
    // 通知条/树状态/恢复横幅是骨架上的单行文本节点，命令式赋值即可；真正的手工业（列表行、
    // 详情体、对话框内容）全部在下面的 React 区域里。
    this.#tabs.installed.disabled = this.#tabs.discover.disabled = !context || !this.can('packages.read')
    this.syncTabs()
    this.#search.placeholder =
      this.#tab === 'installed' ? this.#t('search.installed') : this.#t('search.discover')
    this.#search.setAttribute('aria-label', this.#search.placeholder)
    this.#search.disabled = !context || !this.can('packages.read')
    button('install-source').disabled = !this.canEffect('packages.install')
    this.#recovery.hidden = !context?.readOnly
    this.#layout.dataset.detail = String(this.hasDetail())
    const connectionNotice =
      connection === 'loading'
        ? this.#t('connection.loading')
        : connection === 'offline'
          ? this.#t('connection.offline')
          : connection === 'forbidden'
            ? this.#t('connection.forbidden')
            : ''
    const noticeMessage = error
      ? this.#state.lastOperation
        ? this.#t('notice.operation-error', {
            operation: operationLabel(this.#state.lastOperation, this.#adminT),
            message: this.errorMessage(error),
          })
        : this.errorMessage(error)
      : this.#state.lastOperation
        ? this.#t('notice.operation-refreshed', {
            operation: operationLabel(this.#state.lastOperation, this.#adminT),
          })
        : this.noticeText() || connectionNotice
    const noticeKind = error ? 'error' : connection === 'connected' ? this.#noticeState.kind : 'state'
    this.#notice.textContent = noticeMessage
    this.#notice.dataset.kind = noticeKind
    const treeText =
      tree?.desiredDigest && !tree.actual
        ? tree.failurePhase && !tree.pending
          ? this.#t('tree.error')
          : this.#t('tree.loading')
        : ''
    this.#treeStatus.textContent = treeText
    this.#treeStatus.hidden = !treeText
    this.#orphanPinsHost.hidden = this.#orphanPinList.length === 0 && !this.#orphanPinFetchError
    renderRegion(
      this.#orphanPinsHost,
      <UiLocaleProvider source={this.#locale}>
        <OrphanPins
          pins={this.#orphanPinList.map((pin) => ({
            pinId: pin.pinId,
            packageId: pin.packageId,
            version: pin.version,
            purpose: pinPurposeLabel(pin.purpose, this.#t),
            snapshotId: integrityLabel(pin.snapshotId),
          }))}
          errors={this.#orphanPinErrors}
          notice={
            this.#orphanPinNotice === undefined
              ? undefined
              : this.#t('notice.pin-skipped', { count: this.#orphanPinNotice })
          }
          fetchError={
            this.#orphanPinFetchError
              ? this.#orphanPinFetchError.localize
                ? this.errorMessage(this.#orphanPinFetchError.detail)
                : this.#orphanPinFetchError.detail.message
              : undefined
          }
          canRelease={this.canEffect('packages.remove') && this.#orphanPinList.length > 0}
          onRelease={(pinIds, trigger) => this.confirmReleasePins(pinIds, trigger)}
        />
      </UiLocaleProvider>,
    )
    renderRegion(
      this.#listHost,
      <UiLocaleProvider source={this.#locale}>
        <SessionDefaultsPanel api={this.#api} canSave={this.canEffect('packages.activate')} t={this.#t} />
        <KindFilter
          value={this.#kind}
          t={this.#t}
          onChange={(value) => {
            this.#kind = value
            this.render()
          }}
        />
        <PluginList
          formatFailure={(message) => pluginFailureMessage(message, this.#t)}
          metadataOf={(item) => <PluginBadges item={item} runtime={this.runtimeState(item.id)} t={this.#t} />}
          tab={this.#tab}
          rows={(this.#tab === 'installed' ? this.filteredInstalled() : this.#state.catalog).filter(
            (item) => !this.#kind || item.kinds?.includes(this.#kind),
          )}
          loading={loading}
          inventoryAuthoritative={this.#state.inventoryAuthoritative}
          query={this.#query}
          nextCursor={this.#state.nextCursor}
          surfaceLinksOf={(packageId) => this.surfaceLinks(packageId)}
          runtimeOf={(packageId) => asRuntimeView(this.runtimeState(packageId))}
          primaryActionOf={(item) => this.primaryAction(item)}
          switchDisabledOf={(installed) =>
            !this.canEffect('packages.activate') ||
            (!installed.trusted && (!this.can('packages.trust') || !installed.capabilityHash)) ||
            this.packageBusy(installed.id)
          }
          onOpen={(item) => this.selectItem(item)}
          onToggleDesired={(item, next) => void (next ? this.confirmEnable(item) : this.confirmDisable(item))}
          onLoadMore={() => void this.loadCatalog(this.#state.nextCursor ?? undefined)}
        />
      </UiLocaleProvider>,
    )
    this.#layout.dataset.detail = String(this.hasDetail())
    this.renderDetail()
    this.renderConfirm()
    this.renderSource()
  }

  /** React 键控行会复用 DOM：键盘焦点跟随 data-plugin-id 保留，无需手工恢复。 */

  renderDetail(): void {
    const item =
      this.#tab === 'installed'
        ? this.#state.installed.find((candidate) => candidate.id === this.#state.selectedId)
        : this.#state.selectedCatalog
    if (!item) {
      if (!this.hasDetail()) {
        setDialog(this.#detail, false)
        renderRegion(this.#detail, <UiLocaleProvider source={this.#locale} />)
        return
      }
      // 不传焦点目标：render 每 1.2 秒被刷新触发一次，抢焦点会打断弹窗里的输入。
      setDialog(this.#detail, true)
      renderRegion(
        this.#detail,
        <UiLocaleProvider source={this.#locale}>
          <DetailContent
            heading={
              this.#state.operations.size
                ? this.#t('detail.heading.operations')
                : this.#t('detail.heading.plugin')
            }
            intro={
              this.#state.operations.size
                ? this.#t('detail.intro.operations')
                : this.#t('detail.intro.plugin')
            }
            version={undefined}
            stateText={undefined}
            facts={[]}
            blockerSections={[
              {
                title: this.#t('blocker.operation'),
                items: (this.#state.error?.blockers ?? []).map((blocker) =>
                  blockerText(blocker, this.#adminT),
                ),
              },
            ]}
            operations={this.detailOperations()}
            lastOperationLabel={
              this.#state.lastOperation
                ? `${operationLabel(this.#state.lastOperation, this.#adminT)}${this.#state.lastOperation.retryable ? ` · ${this.#t('detail.retry-allowed')}` : ''}`
                : undefined
            }
            actions={[]}
            onClose={() => this.closeDetail()}
            onCancelOperation={(operationId, trigger) => void this.cancelOperation(operationId, trigger)}
          />
        </UiLocaleProvider>,
      )
      return
    }
    // 不传焦点目标：render 每 1.2 秒被刷新触发一次，抢焦点会打断弹窗里的操作。
    setDialog(this.#detail, true)
    const facts: (readonly [string, string])[] = [
      [this.#t('fact.source'), sourceLabel(item.source as PackageSource, this.#adminT)],
      [this.#t('fact.integrity'), integrityLabel(item.integrity)],
      [this.#t('fact.contribution'), contributionText(item, this.#adminT)],
    ]
    if ('license' in item) facts.push([this.#t('fact.license'), item.license])
    if ('desired' in item) {
      // Manifest slots are an author declaration. This fact is intentionally derived from the
      // live browser registry so the operator can distinguish a declaration from what this page
      // actually registered in the current browser session.
      const actualSlotList = this.actualSlots?.(item.id) ?? []
      facts.push([
        this.#t('fact.browser-slots'),
        actualSlotList.length
          ? actualSlotList.join(this.#locale.getSnapshot() === 'en' ? ', ' : '、')
          : this.#t('fact.no-browser-slots'),
      ])
      const runtime = this.runtimeState(item.id)
      const failureReason =
        runtime?.error?.message ?? (item.actual === 'running' ? undefined : item.actualReason)
      if (failureReason) facts.push([this.#t('fact.failure'), pluginFailureMessage(failureReason, this.#t)])
      facts.push([
        this.#t('fact.cleanup'),
        item.cleanupPending ? this.#t('fact.cleanup-pending') : this.#t('fact.cleanup-none'),
      ])
      facts.push([
        this.#t('fact.rollback-target'),
        item.rollbackTarget
          ? `${item.rollbackTarget.version} · ${integrityLabel(item.rollbackTarget.integrity)}`
          : this.#t('fact.unavailable'),
      ])
    }
    renderRegion(
      this.#detail,
      <UiLocaleProvider source={this.#locale}>
        <DetailContent
          heading={item.id}
          metadata={<PluginBadges item={item} runtime={this.runtimeState(item.id)} t={this.#t} />}
          intro=""
          version={this.#t('version', { version: item.version })}
          stateText={'trusted' in item ? undefined : this.#t('compatibility', { value: item.compatibility })}
          facts={facts}
          blockerSections={[
            {
              title: this.#t('blocker.current'),
              items: ('blockers' in item ? item.blockers : []).map((blocker) =>
                blockerText(blocker, this.#adminT),
              ),
            },
            {
              title: this.#t('blocker.operation'),
              items: (this.#state.error?.blockers ?? []).map((blocker) => blockerText(blocker, this.#adminT)),
            },
          ]}
          operations={this.detailOperations(item.id)}
          lastOperationLabel={undefined}
          actions={this.detailActions(item)}
          onClose={() => this.closeDetail()}
          onCancelOperation={(operationId, trigger) => void this.cancelOperation(operationId, trigger)}
        />
      </UiLocaleProvider>,
    )
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
    const query = this.#query.toLocaleLowerCase()
    if (!query) return this.#state.installed
    return this.#state.installed.filter((item) =>
      `${item.id} ${item.version} ${contributionText(item, this.#adminT)}`
        .toLocaleLowerCase()
        .includes(query),
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
      facts: !item.trusted ? <TrustConfirmationFacts item={item} leadKey="lead.trust-enable" /> : undefined,
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
    const pending = this.#pendingConfirm
    if (!pending) {
      renderRegion(this.#confirmDialog, <UiLocaleProvider source={this.#locale} />)
      return
    }
    renderRegion(
      this.#confirmDialog,
      <UiLocaleProvider source={this.#locale}>
        <ConfirmDialogContent
          title={typeof pending.title === 'function' ? pending.title() : pending.title}
          description={
            typeof pending.description === 'function' ? pending.description() : pending.description
          }
          facts={pending.facts}
          actionLabel={typeof pending.label === 'function' ? pending.label() : pending.label}
          actionDisabled={this.#confirmActionDisabled}
          onAction={() => {
            if (!this.#pendingConfirm) return
            this.#confirmActionDisabled = true
            this.renderConfirm()
            void this.#pendingConfirm
              .run()
              .then(() => this.closeConfirm())
              .catch((error: unknown) => this.showError(error))
              .finally(() => {
                // 确认框在失败路径保持打开：按钮必须复位为可重试，而不是停在置灰。
                this.#confirmActionDisabled = false
                this.renderConfirm()
              })
          }}
          onCancel={() => this.closeConfirm()}
        />
      </UiLocaleProvider>,
    )
  }

  renderSource(): void {
    renderRegion(
      this.#sourceDialog,
      <UiLocaleProvider source={this.#locale}>
        <SourceDialogContent
          title={this.sourceTitle()}
          intro={this.sourceIntro()}
          typeOptions={SOURCE_TYPE_OPTIONS.map(({ value }) => ({
            value,
            label: this.#adminT(`source.${value}`),
          }))}
          type={this.#sourceTypeValue}
          ref_={this.#sourceRefValue}
          placeholder={this.#sourcePlaceholder}
          error={
            this.#sourceProblem
              ? (sourceProblem(this.#sourceProblem.type, this.#sourceProblem.ref, this.#t) ??
                this.#t('source.error.incomplete'))
              : this.#sourceError
                ? this.errorMessage(this.#sourceError)
                : ''
          }
          busy={this.#sourceBusy}
          onTypeChange={(type) => {
            this.#sourceTypeValue = type
            this.syncSourceHint()
            this.render()
          }}
          onRefChange={(ref) => {
            this.#sourceRefValue = ref
          }}
          onSubmit={() => this.submitSource()}
          onCancel={() => this.closeSourceDialog()}
        />
      </UiLocaleProvider>,
    )
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

export type PluginAdminMount = Readonly<{
  ready: Promise<void>
  reload(): Promise<void>
  dispose(): void
}>

/**
 * Binds the plugin admin surface to markup already present in the current document.
 * Importing this module never touches the DOM; the host decides when to mount.
 */
export function mountPluginAdmin(options: PluginAdminOptions = {}): PluginAdminMount {
  const page = new PluginAdminPage(options)
  page.bind()
  const ready = page.start()
  return { ready, reload: () => page.refresh(), dispose: () => page.dispose() }
}
