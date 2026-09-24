import type {
  PackageBlocker,
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
  PackageSource,
  RuntimePinDescriptor,
  RuntimePinReleaseResult,
} from '@agnes/protocol'
import {
  createSelectPicker,
  createStateLights,
  createSwitch,
  createTabs,
  type StateTone,
} from '@agnes/web-admin-frame'
import type { PluginRuntimeState } from '../../client-modules/runtime-status.js'
import { AdminApiError, PluginAdminApi } from './api.js'
import {
  renderPreviewConfirmationFacts,
  renderRollbackActivationFacts,
  renderTrustConfirmationFacts,
  renderUntrustConfirmationFacts,
  renderUpdateActivationFacts,
} from './confirmation.js'
import {
  actualIdentity,
  blockerText,
  hasPermission,
  installedState,
  integrityLabel,
  operationLabel,
  runtimeStateLabel,
  runtimeStateMessage,
  sourceLabel,
  terminal,
} from './presentation.js'
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

/** 「实际」状态的中文与色档。运行中才算正常，其余都要用户多看一眼。 */
const ACTUAL_LABEL: Record<PackageInstalledDescriptor['actual'], string> = {
  'not-running': '未运行',
  starting: '正在启动',
  running: '运行中',
  failed: '运行失败',
  'restart-required': '需要重启',
  unavailable: '不可用',
}
const ACTUAL_TONE: Record<PackageInstalledDescriptor['actual'], StateTone> = {
  'not-running': 'off',
  starting: 'warn',
  running: 'ok',
  failed: 'bad',
  'restart-required': 'warn',
  unavailable: 'bad',
}

const RUNTIME_TONE: Record<PluginRuntimeState['phase'], StateTone> = {
  idle: 'off',
  loading: 'warn',
  active: 'ok',
  stopping: 'warn',
  failed: 'bad',
}

type PreviewMode = 'install' | 'update'
type TrackedOperation = Readonly<{ operationId: string; mode?: PreviewMode; packageId?: string }>
type PendingConfirm = {
  title: string
  description: string
  label: string
  run: () => Promise<void>
  renderFacts?: (parent: HTMLElement) => void
}

type PluginAdminOptions = Readonly<{
  actualSlots?: (packageId: string) => readonly string[]
  runtime?: PluginRuntimeSource
}>

function element<K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] {
  const found = document.getElementById(id)
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return found as HTMLElementTagNameMap[K]
}

function button(id: string): HTMLButtonElement {
  return element(id, 'button')
}

function emptyState(title: string, description: string): HTMLElement {
  const empty = document.createElement('div')
  empty.className = 'plugin-empty admin-empty-state'
  const mark = document.createElement('span')
  mark.className = 'agnes-mark admin-empty-state-mark'
  mark.setAttribute('aria-hidden', 'true')
  const heading = document.createElement('h2')
  heading.textContent = title
  const copy = document.createElement('p')
  copy.textContent = description
  empty.append(mark, heading, copy)
  return empty
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
  return { code: 'ADMIN_UNAVAILABLE', message: '无法连接插件管理后台。已保留当前页面内容。' }
}

function contributionText(item: { contributions: readonly { kind: string; id: string }[] }): string {
  if (!item.contributions.length) return '未报告贡献'
  const labels = item.contributions
    .slice(0, 3)
    .map((contribution) => `${contribution.kind} · ${contribution.id}`)
  return `${labels.join('，')}${item.contributions.length > labels.length ? `，另有 ${item.contributions.length - labels.length} 项` : ''}`
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

function pinPurposeLabel(purpose: RuntimePinDescriptor['purpose']): string {
  const label: Record<RuntimePinDescriptor['purpose'], string> = {
    active: '当前运行',
    candidate: '安装候选',
    recovery: '恢复保留',
    rollback: '回滚目标',
    turn: '进行中的调用',
  }
  return label[purpose]
}

class PluginAdminPage {
  readonly #runtime: PluginRuntimeSource | undefined
  #runtimeStop: (() => void) | undefined

  constructor(options: PluginAdminOptions = {}) {
    this.actualSlots = options.actualSlots
    this.#runtime = options.runtime
  }

  private readonly actualSlots: ((packageId: string) => readonly string[]) | undefined

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
  #api: PluginAdminApi | undefined
  #tab: 'installed' | 'discover' = 'installed'
  #query = ''
  #generation = 0
  #pendingConfirm: PendingConfirm | undefined
  #confirmTrigger: HTMLElement | undefined
  #detailTrigger: HTMLElement | undefined
  #detailDismissed = false
  #operationModes = new Map<string, PreviewMode>()
  #operationPackages = new Map<string, string>()
  #operationTimers = new Map<string, number>()
  #submittingPackages = new Set<string>()
  #sourceMode: PreviewMode = 'install'
  #sourcePackageId: string | undefined
  #sourceTrigger: HTMLElement | undefined
  #sourceBusy = false
  #orphanPinList: RuntimePinDescriptor[] = []
  #orphanPinErrors = new Map<string, string>()
  #orphanPinNotice: string | undefined
  // Distinct from #orphanPinNotice (which reports a per-pin "no longer orphaned" outcome after a
  // release): this reports pinsInspect() itself failing during refresh(), so the section stays
  // visible with a clear message instead of silently keeping a now-unverified stale list.
  #orphanPinFetchError: string | undefined

  readonly #list = element('plugin-list', 'section')
  readonly #layout = element('plugin-layout', 'div')
  readonly #detail = element('plugin-detail', 'dialog')
  readonly #notice = element('admin-notice', 'p')
  readonly #treeStatus = element('plugin-tree-status', 'p')
  #treeTimer: number | undefined
  readonly #recovery = element('recovery-notice', 'section')
  readonly #orphanPins = element('orphan-pins', 'section')
  readonly #orphanPinsList = element('orphan-pins-list', 'ul')
  readonly #orphanPinsStatus = element('orphan-pins-status', 'p')
  readonly #orphanPinsReleaseAll = button('orphan-pins-release-all')
  readonly #search = element('plugin-search', 'input')
  readonly #tabs = createTabs({ installed: 'installed-tab', discover: 'discover-tab' }, this.#list)
  readonly #sourceDialog = element('source-dialog', 'dialog')
  readonly #sourceForm = element('source-form', 'form')
  readonly #sourceTitle = element('source-dialog-title', 'h2')
  readonly #sourceType = element('source-type', 'select')
  readonly #sourcePicker = createSelectPicker(this.#sourceType, { label: '来源类型' })
  readonly #sourceRef = element('source-ref', 'input')
  readonly #sourceError = element('source-error', 'p')
  readonly #confirmDialog = element('plugin-confirm', 'dialog')
  readonly #confirmTitle = element('plugin-confirm-title', 'h2')
  readonly #confirmDescription = element('plugin-confirm-description', 'p')
  readonly #confirmFacts = element('plugin-confirm-preview', 'div')
  readonly #confirmAction = button('plugin-confirm-action')

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
    // 详情是模态框：点遮罩、按 Escape 都要走同一条收尾路径（含焦点归还与"不要立刻重开"）。
    this.#detail.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeDetail()
    })
    this.#detail.addEventListener('click', (event) => {
      if (event.target === this.#detail) this.closeDetail()
    })
    button('install-source').addEventListener('click', () => this.openSourceDialog('install'))
    this.#orphanPinsReleaseAll.addEventListener('click', () =>
      this.confirmReleasePins(
        this.#orphanPinList.map((pin) => pin.pinId),
        this.#orphanPinsReleaseAll,
      ),
    )
    this.#tabs.bind((tab) => void this.selectTab(tab))
    this.#search.addEventListener('input', () => {
      this.#query = this.#search.value.trim()
      if (this.#tab === 'installed') this.render()
      else void this.loadCatalog()
    })
    this.#sourceType.addEventListener('change', () => this.syncSourceHint())
    this.#sourceForm.addEventListener('submit', (event) => {
      event.preventDefault()
      if (this.#sourceBusy) return
      const ref = this.#sourceRef.value.trim()
      const problem = sourceProblem(this.#sourceType.value, ref)
      const source = problem ? undefined : sourceFromForm(this.#sourceType.value, ref)
      if (!source) {
        this.#sourceError.textContent = problem ?? '请输入符合所选来源格式的完整引用。'
        return
      }
      const mode = this.#sourceMode
      const packageId = this.#sourcePackageId
      const trigger = this.#sourceTrigger ?? button('install-source')
      this.#sourceError.textContent = ''
      this.#sourceBusy = true
      // Stay on this dialog until the backend has accepted the check: a refusal has to be readable
      // where the user is looking, not in a panel that this dialog has just been closed over.
      void this.inspect(source, mode, trigger, packageId)
        .then((result) => {
          if (result.ok) this.closeSourceDialog()
          else this.#sourceError.textContent = result.message
        })
        .finally(() => {
          this.#sourceBusy = false
        })
    })
    button('source-cancel').addEventListener('click', () => this.closeSourceDialog())
    this.#sourceDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeSourceDialog()
    })
    button('plugin-confirm-cancel').addEventListener('click', () => this.closeConfirm())
    this.#confirmDialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      this.closeConfirm()
    })
    this.#confirmAction.addEventListener('click', () => {
      const pending = this.#pendingConfirm
      if (!pending) return
      this.#confirmAction.disabled = true
      void pending
        .run()
        .then(() => this.closeConfirm())
        .catch((error: unknown) => this.showError(error))
        .finally(() => {
          this.#confirmAction.disabled = false
        })
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
        // live route feed is unavailable, and never retain a stale link after it can no longer be
        // confirmed.
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
        // a failure here must not turn an otherwise-successful refresh into an offline state. But a
        // stale list must not keep being shown as current once it is no longer verified, and the
        // failure must be visible rather than silent -- so clear the list and surface a status line.
        if (generation !== this.#generation) return
        this.#orphanPinList = []
        this.#orphanPinErrors = new Map()
        this.#orphanPinFetchError = safeMessage(error).message
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
    this.#search.value = ''
    this.#state = { ...this.#state, selectedCatalog: undefined, preview: undefined }
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
      this.#state = { ...this.#state, loading: false, error: safeMessage(error), connection: 'offline' }
    }
    this.render()
  }

  async inspect(
    source: PackageSource,
    mode: PreviewMode,
    trigger: HTMLElement,
    packageId?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const api = this.effectApi('packages.install')
    if (!api) return { ok: false, message: this.#notice.textContent || '暂时无法检查来源。' }
    try {
      const receipt = packageId
        ? await this.submitPackage(packageId, () => api.inspect(source))
        : await api.inspect(source)
      this.track(receipt.operationId, { mode, ...(packageId ? { packageId } : {}) })
      this.#confirmTrigger = trigger
      this.#notice.textContent = '正在检查来源、完整性与权限变化。'
      this.#notice.dataset.kind = 'state'
      return { ok: true }
    } catch (error) {
      this.showError(error)
      return { ok: false, message: this.#notice.textContent || '检查来源失败。' }
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
                  trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash },
                }
              : undefined,
          ),
    )
    this.track(receipt.operationId, { packageId: preview.id })
    this.#state = { ...this.#state, preview: undefined, previewMode: undefined }
    this.#notice.textContent =
      mode === 'install' ? '正在安装。完成后仍需单独信任和启用。' : '正在更新，实际运行状态将由后台确认。'
    this.#notice.dataset.kind = 'state'
    this.render()
  }

  openSourceDialog(mode: PreviewMode, item?: PackageInstalledDescriptor, trigger?: HTMLElement): void {
    if (!this.effectApi('packages.install')) return
    if (item && this.packageBusy(item.id)) return
    this.#sourceMode = mode
    this.#sourcePackageId = item?.id
    this.#sourceTrigger = trigger ?? button('install-source')
    this.#sourceError.textContent = ''
    this.#sourceRef.value = ''
    this.syncSourceHint()
    this.#sourceTitle.textContent = mode === 'update' && item ? `从新来源更新 ${item.id}` : '从来源检查插件'
    const intro = this.#sourceForm.querySelector<HTMLElement>('.dialog-intro')
    if (intro)
      intro.textContent =
        mode === 'update'
          ? '请输入明确的新来源。检查不会复用当前已安装来源，也不会在确认前改变运行版本。'
          : '检查不会安装或启用插件。确认预览中的完整性摘要后，才能继续安装。'
    setDialog(this.#sourceDialog, true, this.#sourceRef)
  }

  /** The field's example follows the selected source type, and a stale complaint about the old one goes. */
  syncSourceHint(): void {
    this.#sourcePicker.sync()
    const type = this.#sourceType.value
    const format = type in SOURCE_FORMATS ? SOURCE_FORMATS[type as PackageSource['type']] : undefined
    if (format) this.#sourceRef.placeholder = format.example
    this.#sourceError.textContent = ''
  }

  closeSourceDialog(): void {
    setDialog(this.#sourceDialog, false)
    this.#sourceTrigger?.focus({ preventScroll: true })
  }

  async operationUpdated(operation: PackageOperation): Promise<void> {
    if (!terminal(operation)) return
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
          message: operation.error?.safeMessage ?? '操作未能完成。',
          blockers: operation.error?.blockers,
        },
      }
    } else if (operation.state === 'cancelled') {
      this.#state = { ...this.#state, lastOperation: operation, error: undefined }
    } else {
      this.#state = { ...this.#state, lastOperation: operation, error: undefined }
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
  }

  openPreview(preview: PackagePreview, mode: PreviewMode): void {
    this.#confirmTrigger = this.#sourceTrigger ?? button('install-source')
    const installed =
      mode === 'update' ? this.#state.installed.find((item) => item.id === preview.id) : undefined
    const combined = !!installed && this.canCombineUpdate(installed, preview)
    this.configureConfirm({
      title: `${mode === 'install' ? '安装预览' : '更新预览'} · ${preview.id}`,
      description:
        mode === 'install'
          ? '请先审阅下方后台返回的完整性、能力、依赖和阻断信息。安装后仍会保持未信任和停用状态。'
          : combined
            ? '将原子执行更新、目标信任和安全激活，并绑定当前安装与运行摘要。'
            : '将按兼容模式更新为停用且未信任状态；后台未声明组合热更新能力，或当前摘要条件不完整。',
      label: mode === 'install' ? '确认安装' : combined ? '确认更新并激活' : '确认更新（保持停用）',
      renderFacts: (parent) =>
        combined && installed
          ? renderUpdateActivationFacts(parent, installed, preview)
          : renderPreviewConfirmationFacts(parent, preview),
      run: () => this.confirmPreview(),
    })
  }

  configureConfirm(pending: PendingConfirm): void {
    this.#pendingConfirm = pending
    this.#confirmTitle.textContent = pending.title
    this.#confirmDescription.textContent = pending.description
    this.#confirmAction.textContent = pending.label
    this.#confirmFacts.replaceChildren()
    this.#confirmFacts.hidden = !pending.renderFacts
    pending.renderFacts?.(this.#confirmFacts)
    setDialog(this.#confirmDialog, true, this.#confirmAction)
  }

  closeConfirm(): void {
    this.#pendingConfirm = undefined
    this.#confirmFacts.replaceChildren()
    this.#confirmFacts.hidden = true
    setDialog(this.#confirmDialog, false)
    this.#confirmTrigger?.focus({ preventScroll: true })
    this.#confirmTrigger = undefined
  }

  effectApi(permission: string): PluginAdminApi | undefined {
    if (!this.#api || !this.#state.context) {
      this.showError({ code: 'ADMIN_UNAVAILABLE', message: '管理会话尚未就绪。' })
      return undefined
    }
    if (this.#state.context.readOnly) {
      this.showError({ code: 'RECOVERY_READ_ONLY', message: '当前处于只读恢复模式，无法执行插件操作。' })
      return undefined
    }
    if (this.#state.loading || this.#state.connection !== 'connected') {
      this.showError({ code: 'ADMIN_UNAVAILABLE', message: '管理后台尚未恢复，无法执行插件操作。' })
      return undefined
    }
    if (!this.can(permission)) {
      this.showError({ code: 'ADMIN_FORBIDDEN', message: '当前账户没有执行此操作的权限。' })
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
      throw new AdminApiError({ code: 'PACKAGE_BUSY', message: '此插件已有操作正在提交或执行。' })
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
    this.#notice.textContent = detail.message
    this.#notice.dataset.kind = 'error'
    this.render()
  }

  track(operationId: string, metadata: Readonly<{ mode?: PreviewMode; packageId?: string }> = {}): void {
    const context = this.#state.context
    if (!context) return
    if (metadata.mode) this.#operationModes.set(operationId, metadata.mode)
    if (metadata.packageId) this.#operationPackages.set(operationId, metadata.packageId)
    this.#detailDismissed = false
    this.#state = { ...this.#state, lastOperation: undefined, error: undefined }
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
      this.#state = { ...this.#state, operations, connection: 'connected', error: undefined }
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
    const { context, connection, error } = this.#state
    this.#tabs.sync(this.#tab)
    this.#search.placeholder = this.#tab === 'installed' ? '筛选当前已安装列表' : '搜索目录中的插件'
    this.#search.setAttribute('aria-label', this.#search.placeholder)
    this.#search.disabled = !context || !this.can('packages.read')
    button('install-source').disabled = !this.canEffect('packages.install')
    this.#recovery.hidden = !context?.readOnly
    this.#layout.dataset.detail = String(this.hasDetail())
    const connectionNotice =
      connection === 'loading'
        ? '正在连接管理后台…'
        : connection === 'offline'
          ? '连接中断，内容保留，等待重新连接。'
          : connection === 'forbidden'
            ? '没有插件管理权限。'
            : ''
    this.#notice.textContent = error
      ? `${this.#state.lastOperation ? `${operationLabel(this.#state.lastOperation)}：` : ''}${error.message}`
      : this.#state.lastOperation
        ? `${operationLabel(this.#state.lastOperation)}。已读取最新状态。`
        : connectionNotice
    this.#notice.dataset.kind = error ? 'error' : connection === 'connected' ? '' : 'state'
    this.renderTreeStatus()
    this.renderList()
    this.renderDetail()
    this.renderOrphanPins()
  }

  renderTreeStatus(): void {
    const tree = this.#state.tree
    if (!tree?.desiredDigest) {
      this.#treeStatus.textContent = ''
      this.#treeStatus.hidden = true
      return
    }
    this.#treeStatus.hidden = false
    const actual = tree.actual ? '实际已对齐' : '实际待资格化'
    const pending = tree.pending ? ' · 资源更新保持待定' : ''
    const diagnostic = tree.failurePhase && !tree.actual ? ` · 诊断阶段 ${tree.failurePhase}` : ''
    this.#treeStatus.textContent = `期望 ${tree.desiredDigest} · ${actual}${pending}${diagnostic}`
  }

  scheduleTreePoll(): void {
    if (this.#treeTimer !== undefined) window.clearTimeout(this.#treeTimer)
    this.#treeTimer = window.setTimeout(() => {
      this.#treeTimer = undefined
      void this.pollTree()
    }, ACTIVE_REFRESH_MS)
  }

  async pollTree(): Promise<void> {
    const api = this.#api
    if (!api || this.#state.connection !== 'connected') return
    try {
      const tree = await api.treeList()
      this.#state = { ...this.#state, tree }
      this.renderTreeStatus()
    } catch {
      // Lost tree_changed recovers by the next successful poll, not by inventing actual.
    }
    this.scheduleTreePoll()
  }

  renderOrphanPins(): void {
    this.#orphanPins.hidden = this.#orphanPinList.length === 0 && !this.#orphanPinFetchError
    this.#orphanPinsReleaseAll.disabled =
      !this.canEffect('packages.remove') || this.#orphanPinList.length === 0
    this.#orphanPinsStatus.hidden = !this.#orphanPinFetchError && !this.#orphanPinNotice
    this.#orphanPinsStatus.textContent = this.#orphanPinFetchError ?? this.#orphanPinNotice ?? ''
    this.#orphanPinsList.replaceChildren()
    for (const pin of this.#orphanPinList) {
      const row = document.createElement('li')
      row.className = 'orphan-pin-row'
      row.dataset.pinId = pin.pinId
      const content = document.createElement('div')
      content.className = 'orphan-pin-content'
      const summary = document.createElement('p')
      summary.textContent = `${pin.packageId}@${pin.version} · ${pinPurposeLabel(pin.purpose)}`
      const meta = document.createElement('p')
      meta.className = 'orphan-pin-meta'
      meta.textContent = `pin ${pin.pinId} · 快照 ${integrityLabel(pin.snapshotId)}`
      content.append(summary, meta)
      const error = this.#orphanPinErrors.get(pin.pinId)
      if (error) {
        const errorText = document.createElement('p')
        errorText.className = 'orphan-pin-error'
        errorText.textContent = error
        content.append(errorText)
      }
      const release = document.createElement('button')
      release.type = 'button'
      release.className = 'secondary-button compact'
      release.textContent = '释放'
      release.disabled = !this.canEffect('packages.remove')
      release.addEventListener('click', () => this.confirmReleasePins([pin.pinId], release))
      row.append(content, release)
      this.#orphanPinsList.append(row)
    }
  }

  renderList(): void {
    const rows = this.#tab === 'installed' ? this.filteredInstalled() : this.#state.catalog
    const focused =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.pluginId : undefined
    this.#list.replaceChildren()
    if (this.#state.loading && !rows.length) {
      const loading = document.createElement('p')
      loading.className = 'plugin-empty'
      loading.textContent = '正在读取插件状态…'
      this.#list.append(loading)
      return
    }
    if (!rows.length) {
      const title =
        this.#tab === 'installed'
          ? this.#state.inventoryAuthoritative
            ? '尚未安装插件'
            : '已安装状态暂不可确认'
          : this.#query
            ? '没有匹配的目录条目'
            : '目录暂时没有可显示的插件'
      const copy =
        this.#tab === 'installed'
          ? this.#state.inventoryAuthoritative
            ? '可以浏览目录，或从已知来源检查一个插件。'
            : '后台尚未确认当前已安装状态；恢复后会自动刷新。'
          : '请调整搜索词，或确认目录连接后重试。'
      this.#list.append(emptyState(title, copy))
      return
    }
    if (this.#tab === 'installed' && !this.#state.inventoryAuthoritative) {
      const stale = document.createElement('p')
      stale.className = 'plugin-inventory-status'
      stale.textContent = '以下为上次读取的状态，当前后台尚未确认。'
      this.#list.append(stale)
    }
    for (const item of rows) {
      const row = document.createElement('article')
      row.className = 'plugin-row'
      row.dataset.pluginId = item.id
      // 目录页第三列是动作按钮、已装页是 Switch，两者宽度不同，用 data-tab 分轨道。
      row.dataset.tab = this.#tab
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      row.setAttribute('aria-label', `查看 ${item.id} 的详情`)
      row.addEventListener('click', (event) => {
        // 行内 Switch / 动作按钮自己处理点击；置灰控件在部分浏览器里不发 click，
        // 事件会落到行上，所以这里再挡一次，避免"拨开关顺带打开详情"。
        if (event.target instanceof Element && event.target.closest('.switch, button, a')) return
        this.selectItem(item, row)
      })
      row.addEventListener('keydown', (event) => {
        // 行内控件的按键会冒泡到行：焦点在 Switch 上按空格是拨开关，不是打开详情。
        if (event.target !== row) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.selectItem(item, row)
        }
      })
      const content = document.createElement('div')
      content.className = 'plugin-row-content'
      const name = document.createElement('h2')
      name.textContent = item.id
      const summary = document.createElement('p')
      summary.textContent = contributionText(item)
      const source = document.createElement('p')
      source.className = 'plugin-source'
      source.textContent = `${item.version} · ${sourceLabel(item.source)}`
      content.append(name, summary, source)
      if (this.#tab === 'installed') {
        const surfaceLinks = this.renderSurfaceLinks(item.id)
        if (surfaceLinks) content.append(surfaceLinks)
      }
      row.append(content, this.#renderRowStates(item), this.#renderRowControl(item))
      this.#list.append(row)
      if (focused === item.id) row.focus({ preventScroll: true })
    }
    if (this.#tab === 'discover' && this.#state.nextCursor) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'secondary-button plugin-more'
      more.textContent = '加载更多目录条目'
      more.addEventListener('click', () => void this.loadCatalog(this.#state.nextCursor ?? undefined))
      this.#list.append(more)
    }
  }

  filteredInstalled(): readonly PackageInstalledDescriptor[] {
    const query = this.#query.toLocaleLowerCase()
    if (!query) return this.#state.installed
    return this.#state.installed.filter((item) =>
      `${item.id} ${item.version} ${contributionText(item)}`.toLocaleLowerCase().includes(query),
    )
  }

  surfaceLinks(packageId: string): readonly AdminSurfaceLink[] {
    return this.#state.surfaceLinks.filter((surface) => surface.packageId === packageId)
  }

  effectiveActual(item: PackageInstalledDescriptor): PackageInstalledDescriptor['actual'] {
    return item.actual
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
        error: { code: 'RUNTIME_NOT_CONFIRMED', message: '后台已完成，浏览器 UI 状态待确认。' },
      }
      this.render()
      return
    }
    try {
      await this.#runtime.invalidate()
    } catch {
      this.#state = {
        ...this.#state,
        error: { code: 'RUNTIME_NOT_CONFIRMED', message: '后台已完成，浏览器 UI 状态待确认。' },
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
      error: { code: 'RUNTIME_NOT_CONFIRMED', message: '后台已完成，浏览器 UI 状态待确认。' },
    }
    this.render()
  }

  renderSurfaceLinks(packageId: string): HTMLElement | undefined {
    const links = this.surfaceLinks(packageId)
    if (!links.length) return undefined
    const group = document.createElement('div')
    group.className = 'plugin-surface-links'
    for (const surface of links) {
      const link = document.createElement('a')
      link.className = 'secondary-button compact plugin-surface-link'
      link.href = surface.mount
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent =
        links.length === 1 ? `打开页面 · ${surface.mount}` : `${surface.surfaceId} · ${surface.mount}`
      link.setAttribute('aria-label', `打开 ${packageId} 的 ${surface.surfaceId} 页面 ${surface.mount}`)
      link.addEventListener('click', (event) => event.stopPropagation())
      group.append(link)
    }
    return group
  }

  /**
   * 行骨架第二列：四颗状态灯（信任 / 期望 / 实际 / 浏览器 UI）。
   * 此前是一排文字 chip，取值长短不一，扫读要逐个读字；色点让"哪一格不对劲"一眼可见。
   */
  #renderRowStates(item: PackageInstalledDescriptor | PackageCatalogDescriptor): HTMLElement {
    if (this.#tab === 'installed') {
      const installed = item as PackageInstalledDescriptor
      const runtime = this.runtimeState(installed.id)
      return createStateLights([
        {
          label: '信任',
          value: installed.trusted ? '已信任' : '未信任',
          tone: installed.trusted ? 'ok' : 'warn',
        },
        {
          label: '期望',
          value: installed.desired === 'enabled' ? '启用' : '停用',
          tone: installed.desired === 'enabled' ? 'ok' : 'off',
        },
        {
          label: '实际',
          value: ACTUAL_LABEL[this.effectiveActual(installed)],
          tone: ACTUAL_TONE[this.effectiveActual(installed)],
        },
        {
          label: '浏览器 UI',
          value: runtimeStateLabel(runtime),
          tone: runtime ? RUNTIME_TONE[runtime.phase] : 'off',
        },
      ])
    }
    const catalog = item as PackageCatalogDescriptor
    return createStateLights([
      {
        label: '兼容',
        value: catalog.compatibility === 'unsupported' ? '不支持' : '兼容',
        tone: catalog.compatibility === 'unsupported' ? 'bad' : 'ok',
      },
    ])
  }

  /**
   * 行骨架第三列：已装页是表达"期望状态"的 Switch，目录页没有状态可拨，保留动作按钮。
   * 未信任的插件其 Switch 置灰：开关代表生效意图，未信任时后台不会接受启用请求。
   */
  #renderRowControl(item: PackageInstalledDescriptor | PackageCatalogDescriptor): HTMLElement {
    if (this.#tab === 'installed') {
      const installed = item as PackageInstalledDescriptor
      if (!installed.trusted) {
        const action = this.primaryAction(installed)
        const trust = document.createElement('button')
        trust.type = 'button'
        trust.className = 'secondary-button compact plugin-row-trust'
        trust.textContent = action.label
        trust.disabled = action.disabled
        trust.addEventListener('click', (event) => {
          event.stopPropagation()
          void action.run()
        })
        return trust
      }
      if (this.runtimeState(installed.id)?.phase === 'failed') {
        const enabled = installed.desired === 'enabled'
        const actions = document.createElement('div')
        actions.className = 'plugin-row-actions'
        const switchControl = createSwitch({
          label: enabled ? `请求停用 ${installed.id}` : `请求启用 ${installed.id}`,
          checked: enabled,
          disabled:
            !installed.trusted || !this.canEffect('packages.activate') || this.packageBusy(installed.id),
          onToggle: (next) => void (next ? this.confirmEnable(installed) : this.confirmDisable(installed)),
        })
        const action = this.primaryAction(installed)
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'secondary-button compact plugin-row-retry'
        retry.textContent = action.label
        retry.disabled = action.disabled
        retry.addEventListener('click', (event) => {
          event.stopPropagation()
          void action.run()
        })
        actions.append(switchControl, retry)
        return actions
      }
      const enabled = installed.desired === 'enabled'
      return createSwitch({
        label: enabled ? `请求停用 ${installed.id}` : `请求启用 ${installed.id}`,
        checked: enabled,
        disabled:
          !installed.trusted || !this.canEffect('packages.activate') || this.packageBusy(installed.id),
        onToggle: (next) => void (next ? this.confirmEnable(installed) : this.confirmDisable(installed)),
      })
    }
    const action = this.primaryAction(item)
    const control = document.createElement('button')
    control.type = 'button'
    control.className = 'secondary-button compact'
    control.textContent = action.label
    control.disabled = action.disabled
    control.addEventListener('click', (event) => {
      event.stopPropagation()
      void action.run()
    })
    return control
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
        label: catalog.compatibility === 'unsupported' ? '不支持' : installed ? '检查更新' : '检查安装',
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
        label: '重试 UI',
        disabled: this.packageBusy(installed.id),
        run: async () => {
          if (!this.#runtime) return
          try {
            await this.#runtime.invalidate()
          } catch {
            this.#state = {
              ...this.#state,
              error: { code: 'RUNTIME_NOT_CONFIRMED', message: '浏览器 UI 状态待确认，可稍后重试。' },
            }
            this.render()
          }
        },
      }
    }
    if (!installed.trusted) {
      return {
        label: '信任',
        disabled:
          !this.canEffect('packages.trust') || !installed.capabilityHash || this.packageBusy(installed.id),
        run: () => this.confirmTrust(installed),
      }
    }
    return installed.desired === 'enabled'
      ? {
          label: '请求停用',
          disabled: !this.canEffect('packages.activate') || this.packageBusy(installed.id),
          run: () => this.confirmDisable(installed),
        }
      : {
          label:
            hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
            this.activeIntegrity(installed) === undefined
              ? '运行状态待确认'
              : '请求启用',
          disabled:
            !this.canEffect('packages.activate') ||
            this.packageBusy(installed.id) ||
            (hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
              this.activeIntegrity(installed) === undefined),
          run: () => this.confirmEnable(installed),
        }
  }

  selectItem(item: PackageInstalledDescriptor | PackageCatalogDescriptor, trigger: HTMLElement): void {
    this.#detailTrigger = trigger
    this.#detailDismissed = false
    if (this.#tab === 'installed') {
      this.#state = { ...this.#state, selectedId: item.id, selectedCatalog: undefined }
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

  renderDetail(): void {
    this.#detail.replaceChildren()
    const item =
      this.#tab === 'installed'
        ? this.#state.installed.find((candidate) => candidate.id === this.#state.selectedId)
        : this.#state.selectedCatalog
    if (!item) {
      if (!this.hasDetail()) {
        setDialog(this.#detail, false)
        return
      }
      // 不传焦点目标：render 每 1.2 秒被刷新触发一次，抢焦点会打断弹窗里的输入。
      setDialog(this.#detail, true)
      const head = document.createElement('div')
      head.className = 'admin-detail-head'
      const headingRow = document.createElement('div')
      headingRow.className = 'plugin-detail-heading'
      const heading = document.createElement('h2')
      heading.textContent = this.#state.operations.size ? '插件操作' : '插件详情'
      headingRow.append(heading, this.detailClose('operation'))
      const copy = document.createElement('p')
      copy.textContent = this.#state.operations.size
        ? '后台正在处理以下操作；此处仅显示后台已报告的状态。'
        : '选择一项插件，查看来源、权限和运行状态。'
      head.append(headingRow, copy)
      const body = document.createElement('div')
      body.className = 'admin-detail-scroll'
      this.#detail.append(head, body)
      this.appendBlockers(body, '此操作的阻断项', this.#state.error?.blockers ?? [])
      this.renderLastOperation(body)
      this.renderOperations(body)
      return
    }
    // 不传焦点目标：render 每 1.2 秒被刷新触发一次，抢焦点会打断弹窗里的操作。
    setDialog(this.#detail, true)
    const head = document.createElement('div')
    head.className = 'admin-detail-head'
    const headingRow = document.createElement('div')
    headingRow.className = 'plugin-detail-heading'
    const heading = document.createElement('h2')
    heading.textContent = item.id
    headingRow.append(heading, this.detailClose(item.id))
    const version = document.createElement('p')
    version.className = 'plugin-detail-version'
    version.textContent = `版本 ${item.version}`
    const states = document.createElement('p')
    states.className = 'plugin-detail-state'
    states.textContent =
      'trusted' in item ? installedState(item, this.effectiveActual(item)) : `兼容性：${item.compatibility}`
    head.append(headingRow, version, states)
    const body = document.createElement('div')
    body.className = 'admin-detail-scroll'
    const facts = document.createElement('dl')
    facts.className = 'plugin-facts'
    this.fact(facts, '来源', sourceLabel(item.source))
    this.fact(facts, '完整性', integrityLabel(item.integrity))
    this.fact(facts, '贡献', contributionText(item))
    if ('license' in item) this.fact(facts, '许可证', item.license)
    if ('desired' in item) {
      // Manifest slots are an author declaration.  This fact is intentionally derived from the
      // live browser registry so the operator can distinguish a declaration from what this page
      // actually registered in the current browser session.
      const actualSlots = this.actualSlots?.(item.id) ?? []
      this.fact(
        facts,
        '本浏览器会话实际注册槽位',
        actualSlots.length ? actualSlots.join('、') : '当前没有已注册的浏览器槽位',
      )
      this.fact(facts, '实际版本与摘要', actualIdentity(item))
      this.fact(facts, '实际状态原因', item.actualReason ?? '后台未报告')
      const runtime = this.runtimeState(item.id)
      this.fact(facts, '浏览器 UI 状态', runtimeStateMessage(runtime))
      if (runtime?.error) this.fact(facts, '浏览器 UI 原因', runtime.error.message)
      this.fact(facts, '旧资源清理', item.cleanupPending ? '尚未完成，后台会继续重试' : '无待清理状态')
      this.fact(
        facts,
        '已核验回滚目标',
        item.rollbackTarget
          ? `${item.rollbackTarget.version} · ${integrityLabel(item.rollbackTarget.integrity)}`
          : '后台未提供',
      )
    }
    const blockers = 'blockers' in item ? item.blockers : []
    body.append(facts)
    this.appendBlockers(body, '当前阻断项', blockers)
    this.appendBlockers(body, '此操作的阻断项', this.#state.error?.blockers ?? [])
    const actions = document.createElement('div')
    actions.className = 'admin-detail-actions'
    if ('desired' in item) this.detailInstalledActions(actions, item)
    else this.detailCatalogActions(actions, item)
    // 头部与动作固定，只有 body 滚动：操作按钮不会被长事实值推出可视区。
    this.#detail.append(head, body, actions)
    this.renderOperations(body, item.id)
  }

  detailClose(id: string): HTMLButtonElement {
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'secondary-button compact plugin-detail-close'
    close.textContent = '关闭详情'
    close.setAttribute('aria-label', `关闭 ${id} 的详情`)
    close.addEventListener('click', () => this.closeDetail())
    return close
  }

  closeDetail(): void {
    const targetId = this.#detailTrigger?.dataset.pluginId
    this.#detailDismissed = true
    this.#state = { ...this.#state, selectedId: undefined, selectedCatalog: undefined }
    this.#detailTrigger = undefined
    this.render()
    if (!targetId) return
    for (const row of this.#list.querySelectorAll<HTMLElement>('.plugin-row')) {
      if (row.dataset.pluginId === targetId) {
        row.focus({ preventScroll: true })
        return
      }
    }
  }

  appendBlockers(parent: HTMLElement, titleText: string, blockers: readonly PackageBlocker[]): void {
    if (!blockers.length) return
    const blocking = document.createElement('section')
    blocking.className = 'plugin-blockers'
    const title = document.createElement('h3')
    title.textContent = titleText
    const list = document.createElement('ul')
    for (const blocker of blockers) {
      const row = document.createElement('li')
      row.textContent = blockerText(blocker)
      list.append(row)
    }
    blocking.append(title, list)
    parent.append(blocking)
  }

  fact(parent: HTMLDListElement, label: string, value: string): void {
    const key = document.createElement('dt')
    key.textContent = label
    const detail = document.createElement('dd')
    detail.textContent = value
    parent.append(key, detail)
  }

  detailCatalogActions(parent: HTMLElement, item: PackageCatalogDescriptor): void {
    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'primary-button'
    const installed = this.#state.installed.some((candidate) => candidate.id === item.id)
    preview.textContent = installed ? '检查更新' : '检查安装内容'
    preview.disabled =
      item.compatibility === 'unsupported' ||
      !this.canEffect('packages.install') ||
      (installed && this.packageBusy(item.id))
    preview.addEventListener(
      'click',
      () =>
        void this.inspect(
          item.source,
          installed ? 'update' : 'install',
          preview,
          installed ? item.id : undefined,
        ),
    )
    parent.append(preview)
  }

  detailInstalledActions(parent: HTMLElement, item: PackageInstalledDescriptor): void {
    const surfaceLinks = this.renderSurfaceLinks(item.id)
    if (surfaceLinks) parent.append(surfaceLinks)
    const catalog = document.createElement('button')
    catalog.type = 'button'
    catalog.className = 'secondary-button'
    catalog.textContent = '从目录选择更新版本'
    catalog.disabled = !this.canEffect('packages.install') || this.packageBusy(item.id)
    catalog.addEventListener('click', () => void this.chooseUpdateVersion(item, catalog))
    parent.append(catalog)
    const source = document.createElement('button')
    source.type = 'button'
    source.className = 'secondary-button'
    source.textContent = '从新来源更新'
    source.disabled = !this.canEffect('packages.install') || this.packageBusy(item.id)
    source.addEventListener('click', () => this.openSourceDialog('update', item, source))
    parent.append(source)
    const rollback = document.createElement('button')
    rollback.type = 'button'
    rollback.className = 'secondary-button'
    rollback.textContent = item.rollbackTarget ? `回滚到 ${item.rollbackTarget.version}` : '回滚（目标未知）'
    const rollbackReady =
      !!item.rollbackTarget &&
      hasFeature(this.#state.context, ADMIN_FEATURES.rollbackTarget) &&
      this.supportsCompositeActivation() &&
      this.activeIntegrity(item) !== undefined &&
      this.canEffect('packages.remove') &&
      this.can('packages.trust') &&
      this.can('packages.activate') &&
      !this.packageBusy(item.id)
    rollback.disabled = !rollbackReady
    rollback.title = rollbackReady
      ? '将绑定已核验目标并原子执行回滚、信任和激活。'
      : '后台未声明组合回滚能力，或缺少目标、运行摘要及必要权限。'
    rollback.addEventListener('click', () => this.confirmRollback(item, rollback))
    parent.append(rollback)
    if (item.trusted) {
      const untrust = document.createElement('button')
      untrust.type = 'button'
      untrust.className = 'danger-button'
      untrust.textContent = '撤销信任并停用'
      untrust.disabled =
        !this.canEffect('packages.trust') || !item.capabilityHash || this.packageBusy(item.id)
      untrust.addEventListener('click', () => this.confirmUntrust(item, untrust))
      parent.append(untrust)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger-button'
    remove.textContent = '卸载插件'
    remove.disabled =
      !this.canEffect('packages.remove') || item.blockers.length > 0 || this.packageBusy(item.id)
    remove.addEventListener('click', () => this.confirmRemove(item, remove))
    parent.append(remove)
  }

  async chooseUpdateVersion(item: PackageInstalledDescriptor, trigger: HTMLElement): Promise<void> {
    this.#detailTrigger = trigger
    this.#tab = 'discover'
    this.#query = item.id
    this.#search.value = item.id
    this.#state = { ...this.#state, selectedCatalog: undefined, selectedId: undefined }
    this.render()
    await this.loadCatalog()
  }

  renderOperations(parent: HTMLElement, id?: string): void {
    const entries = [...this.#state.operations.values()].filter((operation) =>
      id === undefined
        ? true
        : operation.packageId === id ||
          this.#operationPackages.get(operation.operationId) === id ||
          operation.installed?.id === id ||
          operation.preview?.id === id,
    )
    if (!entries.length) return
    const section = document.createElement('section')
    section.className = 'plugin-operations'
    const title = document.createElement('h3')
    title.textContent = '正在进行的操作'
    section.append(title)
    for (const operation of entries) {
      const row = document.createElement('div')
      row.className = 'operation-row'
      const copy = document.createElement('p')
      copy.textContent = `${operationLabel(operation)}${operation.progress ? ` · ${operation.progress}%` : ''}${operation.retryable ? ' · 后台允许重试' : ''}`
      row.append(copy)
      if (
        !terminal(operation) &&
        operation.cancellable === true &&
        hasFeature(this.#state.context, ADMIN_FEATURES.operationControl) &&
        this.canEffect('packages.activate')
      ) {
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'secondary-button compact'
        cancel.textContent = '请求取消'
        cancel.addEventListener('click', () => void this.cancelOperation(operation.operationId, cancel))
        row.append(cancel)
      }
      section.append(row)
    }
    parent.append(section)
  }

  renderLastOperation(parent: HTMLElement): void {
    const operation = this.#state.lastOperation
    if (!operation) return
    const section = document.createElement('section')
    section.className = 'plugin-operations'
    const title = document.createElement('h3')
    title.textContent = '最近完成的操作'
    const copy = document.createElement('p')
    copy.textContent = `${operationLabel(operation)}${operation.retryable ? ' · 后台允许重试' : ''}`
    section.append(title, copy)
    parent.append(section)
  }

  confirmTrust(item: PackageInstalledDescriptor): Promise<void> {
    const capabilityHash = item.capabilityHash
    if (!capabilityHash) {
      this.showError({ code: 'E_PACKAGE_TRUST', message: '缺少已确认的能力摘要，不能信任此版本。' })
      return Promise.resolve()
    }
    this.configureConfirm({
      title: `信任 ${item.id}`,
      description: '请核对下方完整性摘要、能力摘要哈希及已报告的贡献与能力字段。信任不会启用插件。',
      label: '确认信任',
      renderFacts: (parent) => renderTrustConfirmationFacts(parent, item),
      run: async () => {
        const api = this.effectApi('packages.trust')
        if (!api) return
        const receipt = await this.submitPackage(item.id, () =>
          api.trust(item.id, item.integrity, capabilityHash),
        )
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
    return Promise.resolve()
  }

  confirmUntrust(item: PackageInstalledDescriptor, trigger: HTMLElement): void {
    const capabilityHash = item.capabilityHash
    if (!capabilityHash) {
      this.showError({ code: 'E_PACKAGE_TRUST', message: '缺少已确认的能力摘要，不能安全撤销信任。' })
      return
    }
    this.#confirmTrigger = trigger
    this.configureConfirm({
      title: `撤销信任 ${item.id}`,
      description:
        '撤销信任会停用插件、清除其恢复与回滚候选，并撤回浏览器与后端运行行；它不会删除已安装的文件。',
      label: '确认撤销信任',
      renderFacts: (parent) => renderUntrustConfirmationFacts(parent, item),
      run: async () => {
        const api = this.effectApi('packages.trust')
        if (!api) return
        const receipt = await this.submitPackage(item.id, () =>
          api.untrust(item.id, item.integrity, capabilityHash),
        )
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
  }

  confirmEnable(item: PackageInstalledDescriptor): Promise<void> {
    if (
      hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
      this.activeIntegrity(item) === undefined
    ) {
      this.showError({ code: 'RUNTIME_IDENTITY_UNKNOWN', message: '实际运行摘要尚未确认，不能安全启用。' })
      return Promise.resolve()
    }
    this.configureConfirm({
      title: `请求启用 ${item.id}`,
      description: '请求启用只提交期望状态；后台和浏览器 UI 状态确认后才显示已运行。',
      label: '请求启用',
      run: async () => {
        const api = this.effectApi('packages.activate')
        if (!api) return
        const activeIntegrity = this.activeIntegrity(item)
        if (
          hasFeature(this.#state.context, ADMIN_FEATURES.runtimeIdentity) &&
          activeIntegrity === undefined
        ) {
          this.showError({
            code: 'RUNTIME_IDENTITY_UNKNOWN',
            message: '实际运行摘要尚未确认，不能安全启用。',
          })
          return
        }
        const receipt = await this.submitPackage(item.id, () =>
          activeIntegrity === undefined
            ? api.enable(item.id)
            : api.enableChecked(item.id, item.integrity, activeIntegrity),
        )
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
    return Promise.resolve()
  }

  confirmDisable(item: PackageInstalledDescriptor): Promise<void> {
    this.configureConfirm({
      title: `请求停用 ${item.id}`,
      description: '停用后插件 UI 贡献将移除，Agnes 原界面保持可用；后台会在安全边界完成排干与撤销。',
      label: '请求停用',
      run: async () => {
        const api = this.effectApi('packages.activate')
        if (!api) return
        const receipt = await this.submitPackage(item.id, () => api.disable(item.id))
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
    return Promise.resolve()
  }

  confirmRemove(item: PackageInstalledDescriptor, trigger: HTMLElement): void {
    this.#confirmTrigger = trigger
    this.configureConfirm({
      title: `卸载 ${item.id}`,
      description: '卸载会由后台检查依赖、运行代际和部署引用。出现阻断项时不会绕过检查。',
      label: '确认卸载',
      run: async () => {
        const api = this.effectApi('packages.remove')
        if (!api) return
        const receipt = await this.submitPackage(item.id, () => api.remove(item.id))
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
  }

  confirmRollback(item: PackageInstalledDescriptor, trigger: HTMLElement): void {
    const target = item.rollbackTarget
    const activeIntegrity = this.activeIntegrity(item)
    if (!target || activeIntegrity === undefined || !this.supportsCompositeActivation()) return
    this.#confirmTrigger = trigger
    this.configureConfirm({
      title: `回滚 ${item.id} 到 ${target.version}`,
      description: '后台会重新核验目标摘要，并原子执行回滚、目标信任和安全激活。',
      label: '确认回滚并激活',
      renderFacts: (parent) => renderRollbackActivationFacts(parent, item),
      run: async () => {
        const api = this.effectApi('packages.remove')
        if (!api || !this.can('packages.trust') || !this.can('packages.activate')) return
        const receipt = await this.submitPackage(item.id, () =>
          api.rollback(item.id, target.integrity, {
            expectedInstalledIntegrity: item.integrity,
            expectedActiveIntegrity: activeIntegrity,
            trust: { integrity: target.integrity, capabilityHash: target.capabilityHash },
          }),
        )
        this.track(receipt.operationId, { packageId: item.id })
      },
    })
  }

  confirmReleasePins(pinIds: string[], trigger: HTMLElement): void {
    if (!pinIds.length) return
    this.#confirmTrigger = trigger
    this.configureConfirm({
      title: pinIds.length === 1 ? `释放 pin ${pinIds[0]}` : `释放全部孤儿 pin（共 ${pinIds.length} 个）`,
      description:
        '释放会立即解除对应运行时快照的占用。若某个 pin 在确认前已不再孤儿，后台会跳过并说明原因。',
      label: '确认释放',
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
        this.#orphanPinErrors.set(result.pinId, result.error?.safeMessage ?? '释放失败，原因未知。')
        continue
      }
      if (result.outcome === 'skipped-no-longer-orphaned') skipped++
      this.#orphanPinErrors.delete(result.pinId)
      this.#orphanPinList = this.#orphanPinList.filter((pin) => pin.pinId !== result.pinId)
    }
    this.#orphanPinNotice = skipped > 0 ? `${skipped} 个 pin 已不再是孤儿，无需释放。` : undefined
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

  dispose(): void {
    this.#sourcePicker.destroy()
    this.#tabs.dispose()
    this.#runtimeStop?.()
    this.#runtimeStop = undefined
    if (this.#treeTimer !== undefined) window.clearTimeout(this.#treeTimer)
    for (const timer of this.#operationTimers.values()) {
      if (timer >= 0) window.clearTimeout(timer)
    }
    this.#operationTimers.clear()
  }
}

export type PluginAdminMount = Readonly<{ reload(): Promise<void>; dispose(): void }>

/**
 * Binds the plugin admin surface to markup already present in the current document.
 * Importing this module never touches the DOM; the host decides when to mount.
 */
export function mountPluginAdmin(options: PluginAdminOptions = {}): PluginAdminMount {
  const page = new PluginAdminPage(options)
  page.bind()
  void page.start()
  return { reload: () => page.refresh(), dispose: () => page.dispose() }
}
