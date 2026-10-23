import type {
  McpServerDefinitionInput,
  McpServerDescriptor,
  ResourceOperation,
  ResourceOperationReceipt,
  SkillDescriptor,
  SkillRootStatus,
} from '@agnes/protocol'
import {
  type ConfirmController,
  createConfirmController,
  createDocumentLocaleSource,
  createSelectPicker,
  createUiTranslator,
  isPageDialog,
  type LocaleTranslator,
  McpDetailContent,
  RESOURCE_DETAIL_LOCALE_NAMESPACE,
  RESOURCE_LIST_LOCALE_NAMESPACE,
  type ResourceDetailAction,
  ResourceListContent,
  type ResourceProgress,
  ResourceRoots,
  renderRegion,
  resolveFeedback,
  resourceDesiredEnabled,
  resourceDetailLocaleCatalog,
  resourceFailureKey,
  resourceFailureLabel,
  resourceListLocaleCatalog,
  type SelectPicker,
  SkillDetailContent,
  showDialogHost,
  UiLocaleProvider,
  type UiLocaleSource,
  unmountRegion,
} from '@agnes/web-ui'
import { $, type ResourceNotice, renderNotice } from './admin-dom.js'
import { resourceAdminError as errorOf, ResourceAdminApi, ResourceAdminApiError } from './api.js'
import { RESOURCE_ADMIN_LOCALE_NAMESPACE, resourceAdminLocaleCatalog } from './locales/admin.js'
import {
  createMcpForm,
  keepToolDisclosure,
  McpFormValidationError,
  sandboxProfileOf,
  saveToolDisclosure,
} from './mcp-form.js'
import { mountMcpPresets } from './mcp-presets.js'
import { pollResourceOperation, watchMcpPanel } from './mcp-refresh.js'
import { mountMcpWizard } from './mcp-wizard.js'
import { type ResourceCompletion, ResourcePageFeedback } from './operation-feedback.js'
import { resourceActionMenu, skillDetailActions } from './skill-actions.js'
import { SkillsPage } from './skills-page.js'

export { registerSkillPagePanels, type SkillPagePanels } from './skills-page.js'

import { type ResourceAdminSurface, renderSettingsChrome } from './settings-chrome.js'
import type { ResourceAdminContext } from './types.js'

export type { ResourceAdminSurface } from './settings-chrome.js'

let list!: HTMLElement
let detail!: HTMLDialogElement
let notice!: HTMLElement
let dialog!: HTMLDialogElement
let form!: HTMLFormElement
let mcpTransport!: HTMLSelectElement
let mcpSecretKind!: HTMLSelectElement
let mcpForm!: ReturnType<typeof createMcpForm>
let mcpPickers: SelectPicker[] = []
let mcpWizard: ReturnType<typeof mountMcpWizard> | undefined
let mcpPresets: ReturnType<typeof mountMcpPresets> | undefined
let surface: ResourceAdminSurface | undefined
let refreshButton!: HTMLButtonElement
let createButton!: HTMLButtonElement
// The dialogs and form are single: the latest mount owns them and an earlier page stops drawing.
let activePage: ResourceAdminPage | undefined
let stopMcpRefresh: (() => void) | undefined

type Tab = 'skills' | 'mcp'
type Item = SkillDescriptor | McpServerDescriptor
type ResourceLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type ResourceAdminOptions = {
  workspaceId?: string
  tab?: Tab
  locale?: UiLocaleSource
  surface?: ResourceAdminSurface
}
export type ResourceScope = Readonly<{ tab: Tab; workspaceId?: string }>

function normalizeWorkspaceId(workspaceId?: string): string | undefined {
  return workspaceId && /^[a-f0-9]{64}$/.test(workspaceId) ? workspaceId : undefined
}
const resourceAdminCatalogs = {
  [RESOURCE_ADMIN_LOCALE_NAMESPACE]: resourceAdminLocaleCatalog,
  [RESOURCE_LIST_LOCALE_NAMESPACE]: resourceListLocaleCatalog,
  [RESOURCE_DETAIL_LOCALE_NAMESPACE]: resourceDetailLocaleCatalog,
} as const
let activeResourceText: LocaleTranslator = createUiTranslator(
  undefined,
  RESOURCE_ADMIN_LOCALE_NAMESPACE,
  resourceAdminLocaleCatalog,
)
let confirmController: ConfirmController | undefined
async function confirmEffect(summary: string, t: LocaleTranslator = activeResourceText): Promise<boolean> {
  confirmController ??= createConfirmController()
  return confirmController.ask({
    title: t('confirmation.title'),
    description: t('confirmation.description', { summary }),
    confirmLabel: t('confirmation.confirm'),
  })
}

/** 详情三段式：头部固定 / 中段滚动 / 动作固定。操作按钮因此永远留在可视区内。 */
class ResourceAdminPage {
  readonly lifetime = new AbortController()
  readonly #locale: UiLocaleSource
  readonly #localeStop: () => void
  readonly #localeCleanup?: () => void
  readonly #t: LocaleTranslator
  readonly #detailT: LocaleTranslator
  #api: ResourceAdminApi | undefined
  #context: ResourceAdminContext | undefined
  #tab: Tab = 'skills'
  #items: Item[] = []
  #skillQuery = ''
  #skillRoots: SkillRootStatus[] = []
  #selected: string | undefined
  #detailTrigger: HTMLElement | undefined
  #generation = 0
  readonly #feedback = new ResourcePageFeedback()
  #operations = new Map<string, ResourceOperation>()
  #activeOperation: string | undefined
  #activeSkillId: string | undefined
  #nextCursor: string | undefined
  #cursorStale = false
  #workspaceId: string | undefined
  #loadState: ResourceLoadState = 'idle'
  #reloadPromise: Promise<void> | undefined
  #loadMorePromise: Promise<void> | undefined
  #loadedTab: Tab | undefined
  #loadedWorkspace: string | undefined
  #notice: ResourceNotice = { raw: '', kind: '' }

  constructor(workspaceId?: string, tab: Tab = 'skills', locale?: UiLocaleSource) {
    this.#workspaceId = normalizeWorkspaceId(workspaceId)
    this.#tab = tab
    this.#skillQuery = new URLSearchParams(location.search).get('skill')?.slice(0, 128) ?? ''
    if (locale) this.#locale = locale
    else {
      const documentLocale = createDocumentLocaleSource(resourceAdminCatalogs)
      this.#locale = documentLocale.source
      this.#localeCleanup = documentLocale.dispose
    }
    this.#t = createUiTranslator(this.#locale, RESOURCE_ADMIN_LOCALE_NAMESPACE, resourceAdminLocaleCatalog)
    this.#detailT = createUiTranslator(
      this.#locale,
      RESOURCE_DETAIL_LOCALE_NAMESPACE,
      resourceDetailLocaleCatalog,
    )
    activeResourceText = this.#t
    this.#localeStop = this.#locale.subscribe(() => {
      activeResourceText = this.#t
      syncResourcePickers(this.#t)
      syncTransport(this.#t)
      mcpPresets?.localize()
      mcpWizard?.localize()
      if (dialog?.open)
        $('mcp-dialog-title', 'h2').textContent = editing
          ? this.#t('form.title.edit', { name: editing.displayName })
          : this.#t('form.title.create')
      this.render()
    })
  }

  locale(): 'en' | 'zh-CN' {
    return this.#locale.getSnapshot()
  }

  async confirm(summary: string): Promise<boolean> {
    if (this.lifetime.signal.aborted) return false
    const confirmed = await confirmEffect(summary, this.#t)
    return confirmed && !this.lifetime.signal.aborted
  }

  showError(error: unknown): void {
    const value = errorOf(error)
    if (
      error instanceof ResourceAdminApiError &&
      value.code !== 'ADMIN_UNAVAILABLE' &&
      value.code !== 'RESOURCE_ADMIN_UNAVAILABLE'
    ) {
      this.setNotice(resourceFailureKey(value.code), 'error')
      return
    }
    this.setNotice('error.unavailable', 'error')
  }

  setNotice(key: string | undefined, kind = '', vars?: Readonly<Record<string, string | number>>): void {
    this.#notice = key ? { key, ...(vars ? { vars } : {}), kind } : { raw: '', kind }
    this.render()
  }

  setRawNotice(raw: string, kind = ''): void {
    this.#notice = { raw, kind }
    this.render()
  }
  /** Re-scopes to the workbench's current workspace (or clears the scope) and reloads. */
  async setWorkspace(workspaceId?: string): Promise<void> {
    this.#workspaceId = normalizeWorkspaceId(workspaceId)
    await this.#ensureLoaded()
  }
  async sync(scope: ResourceScope, options: { refresh?: boolean } = {}): Promise<void> {
    const nextWorkspace = normalizeWorkspaceId(scope.workspaceId)
    const tabChanged = this.#tab !== scope.tab
    const workspaceChanged = this.#workspaceId !== nextWorkspace
    if (tabChanged || workspaceChanged) this.#feedback.clear()
    this.#tab = scope.tab
    this.#workspaceId = nextWorkspace
    this.#selected = undefined
    if (tabChanged || workspaceChanged) await this.#ensureLoaded()
    else if (options.refresh) await this.reload()
  }
  async refreshMcpIfChanged(): Promise<void> {
    if (
      this.#tab !== 'mcp' ||
      !this.#api ||
      this.#reloadPromise ||
      this.#nextCursor ||
      detail.open ||
      dialog.open
    )
      return
    const page = await this.#api.mcp()
    if (
      this.#tab === 'mcp' &&
      !detail.open &&
      !dialog.open &&
      JSON.stringify(page.items) !== JSON.stringify(this.#items)
    )
      await this.reload(true)
  }
  async start(): Promise<void> {
    await this.#ensureLoaded()
  }
  async #ensureLoaded(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    if (this.#loadedTab !== this.#tab || this.#loadedWorkspace !== this.#workspaceId) {
      this.#loadedTab = undefined
      this.#loadedWorkspace = undefined
      this.#items = []
      this.#skillRoots = []
      this.#nextCursor = undefined
      this.#loadState = 'loading'
      this.render()
    }
    await this.reload()
    if (this.#loadedTab !== this.#tab || this.#loadedWorkspace !== this.#workspaceId) await this.reload()
  }
  async reload(preserveNotice = false): Promise<void> {
    if (this.lifetime.signal.aborted) return
    if (this.#reloadPromise) return this.#reloadPromise
    this.#reloadPromise = this.#reload(preserveNotice).finally(() => {
      this.#reloadPromise = undefined
      this.render()
    })
    return this.#reloadPromise
  }
  async #reload(preserveNotice: boolean): Promise<void> {
    const generation = ++this.#generation
    const requestTab = this.#tab
    const requestWorkspace = this.#workspaceId
    this.#loadState = 'loading'
    this.render()
    // The list shows its own placeholder while it reads; the notice line stays for outcomes.
    if (!preserveNotice) this.setNotice(undefined)
    try {
      const context = this.#context ?? (await ResourceAdminApi.context())
      if (this.lifetime.signal.aborted) return
      this.#context = context
      this.#api = new ResourceAdminApi(context, fetch, requestWorkspace)
      const result = requestTab === 'skills' ? await this.#api.skills() : await this.#api.mcp()
      if (generation !== this.#generation) return
      if (requestTab !== this.#tab || requestWorkspace !== this.#workspaceId) return
      this.#items = result.items
      this.#skillRoots = requestTab === 'skills' && 'skillRoots' in result ? (result.skillRoots ?? []) : []
      this.#nextCursor = result.nextCursor
      this.#cursorStale = false
      this.#loadedTab = this.#tab
      this.#loadedWorkspace = this.#workspaceId
      this.#loadState = this.#items.length ? 'ready' : 'empty'
      // 详情是模态框，选中即等于弹出。所以这里只能"选中的资源消失了就清掉"，
      // 不能再像双列抽屉时代那样替用户选中第一项——那会让一进 Tab 就弹出一个详情。
      if (this.#selected !== undefined && !this.#items.some((item) => item.resourceId === this.#selected))
        this.#selected = undefined
      if (!preserveNotice) {
        this.setNotice(context.readOnly ? 'notice.read-only' : undefined, context.readOnly ? 'warning' : '')
      }
      this.render()
    } catch (error) {
      if (generation === this.#generation) {
        this.#loadState = 'error'
        this.showError(error)
        this.render()
      }
    }
  }
  api(): ResourceAdminApi {
    if (!this.#api || this.lifetime.signal.aborted) throw new Error(this.#t('error.not-connected'))
    return this.#api
  }
  writable(): boolean {
    return !!this.#context && !this.#context.readOnly
  }
  select(resourceId: string, trigger?: HTMLElement): void {
    this.#selected = resourceId
    this.#detailTrigger = trigger
    this.render()
  }
  /** 详情打开一次即可：重复 render 不能反复打开（showModal 会抛 InvalidStateError）。 */
  openDetail(label: string): void {
    detail.setAttribute('aria-label', label)
    // The page holding the detail names it in its address by this id.
    detail.dataset.resourceId = this.#selected ?? ''
    showDialogHost(detail)
  }
  #closeDetailDialog(): void {
    if (!detail.open) return
    try {
      detail.close()
    } catch {
      detail.removeAttribute('open')
    }
  }
  /** Return focus by resource ID: rendering may have replaced the original trigger row. */
  closeDetail(): void {
    const targetId = this.#detailTrigger?.dataset.resourceId
    this.#closeDetailDialog()
    this.#selected = undefined
    this.#detailTrigger = undefined
    this.render()
    if (!targetId) return
    for (const row of list.querySelectorAll<HTMLElement>('.resource-row')) {
      if (row.dataset.resourceId !== targetId) continue
      row
        .querySelector<HTMLButtonElement>('.agh-list-row-title, .plugin-details-button')
        ?.focus({ preventScroll: true })
      return
    }
  }
  setTab(tab: Tab): void {
    if (this.#tab === tab) return
    this.#feedback.clear()
    this.#tab = tab
    this.#selected = undefined
    void this.#ensureLoaded()
  }
  async loadMore(): Promise<void> {
    if (!this.#nextCursor || this.#loadMorePromise || this.#reloadPromise || this.#activeOperation) return
    const cursor = this.#nextCursor
    const requestTab = this.#tab
    const requestWorkspace = this.#workspaceId
    const requestGeneration = this.#generation
    this.#loadMorePromise = (async () => {
      try {
        const result =
          requestTab === 'skills'
            ? this.#cursorStale
              ? await this.api().skillsThrough(this.#items.length)
              : await this.api().skills(cursor)
            : await this.api().mcp(cursor)
        if (
          requestGeneration !== this.#generation ||
          requestTab !== this.#tab ||
          requestWorkspace !== this.#workspaceId
        )
          return
        const known = new Set(this.#items.map((item) => item.resourceId))
        this.#items =
          this.#cursorStale && requestTab === 'skills'
            ? result.items
            : [...this.#items, ...result.items.filter((item) => !known.has(item.resourceId))]
        this.#cursorStale = false
        this.#nextCursor = result.nextCursor
        this.#loadState = this.#items.length ? 'ready' : 'empty'
      } catch (error) {
        if (
          requestGeneration !== this.#generation ||
          requestTab !== this.#tab ||
          requestWorkspace !== this.#workspaceId
        )
          return
        this.setNotice('notice.load-more-failed', 'error')
        this.showError(error)
      } finally {
        this.#loadMorePromise = undefined
        this.render()
      }
    })()
    await this.#loadMorePromise
  }
  async track(
    receipt: { operationId: string },
    completion?: ResourceCompletion,
    skillId?: string,
  ): Promise<boolean> {
    const api = this.api()
    const generation = this.#generation
    const workspace = this.#workspaceId
    const publish = this.#feedback.capture()
    this.#activeSkillId = skillId
    this.#activeOperation = receipt.operationId
    this.setNotice('notice.submitted')
    try {
      const op = await pollResourceOperation(
        () => api.operation(receipt.operationId),
        this.lifetime.signal,
        (op) => {
          this.#operations.set(op.operationId, op)
          this.render(false)
        },
      )
      if (!op) {
        if (!this.lifetime.signal.aborted) this.setNotice('notice.running', 'warning')
        return false
      }
      this.#operations.set(op.operationId, op)
      if (skillId) {
        const item = await api.skill(skillId)
        if (
          this.lifetime.signal.aborted ||
          generation !== this.#generation ||
          workspace !== this.#workspaceId ||
          this.#tab !== 'skills'
        )
          return false
        const index = this.#items.findIndex((item) => item.resourceId === skillId)
        if (index >= 0) this.#items[index] = item
        this.#cursorStale = !!this.#nextCursor
      }
      if (!publish(op, activeResourceText, completion)) return false
      if (op.state === 'succeeded') {
        this.setNotice(undefined)
      } else if (op.lastSafeError?.message) this.setNotice(resourceFailureKey(op.lastSafeError.code), 'error')
      else this.setNotice('notice.failed', 'error')
      if (!skillId) await this.reload(true)
      return this.#loadState !== 'error' && op.state === 'succeeded'
    } finally {
      this.#activeOperation = undefined
      this.#activeSkillId = undefined
      this.render()
    }
  }

  tab(): Tab {
    return this.#tab
  }

  render(renderList = true): void {
    if (activePage !== this) return
    if (!surface) renderSettingsChrome(this.#tab, this.#t)
    const failure = renderNotice(notice, this.#notice, this.#t, !!surface)
    refreshButton.hidden = true
    const busy = this.#reloadPromise !== undefined || this.#loadMorePromise !== undefined
    refreshButton.disabled = !this.writable() || busy
    createButton.hidden = this.#tab !== 'mcp'
    createButton.disabled = !this.writable() || busy || this.#activeOperation !== undefined
    if (mcpPresets) {
      mcpPresets.setAvailability({
        hidden: this.#tab !== 'mcp',
        disabled: !this.writable() || busy || this.#activeOperation !== undefined,
      })
    }
    list.dataset.state = this.#loadState
    list.setAttribute('aria-busy', String(this.#loadState === 'loading'))
    if (renderList) {
      renderRegion(
        list,
        <UiLocaleProvider source={this.#locale}>
          {this.#tab === 'skills' ? (
            <SkillsPage
              embedded={!!surface}
              query={this.#skillQuery}
              onQuery={(query) => {
                this.#skillQuery = query
                this.render()
              }}
              onRefresh={() => refreshButton.click()}
              busy={busy || this.#activeOperation !== undefined}
              writable={this.writable()}
              locations={<ResourceRoots roots={this.#skillRoots} />}
            >
              {(onImport) => this.#resourceList(onImport)}
            </SkillsPage>
          ) : (
            this.#resourceList()
          )}
        </UiLocaleProvider>,
      )
    }
    const selected = this.#items.find((item) => item.resourceId === this.#selected)
    if (!selected) {
      this.#closeDetailDialog()
      renderRegion(detail, <UiLocaleProvider source={this.#locale} />)
      return
    }
    const operationId = this.#activeOperation
    let progress: ResourceProgress | undefined
    if (operationId) {
      const current = this.#operations.get(operationId)
      progress = {
        text:
          current?.progress === undefined
            ? this.#t('progress.waiting')
            : this.#t('progress.running', { progress: current.progress }),
        canCancel: this.writable() && current?.kind !== '_agnes/v1/skills.remove',
        cancelTitle:
          current?.kind === '_agnes/v1/skills.remove' ? this.#t('progress.delete-uncancellable') : undefined,
        onCancel: () =>
          void (async () => {
            if (await this.confirm(this.#t('progress.cancel-summary', { id: operationId })))
              await this.track(await this.api().cancel(operationId))
          })().catch((error) => this.showError(error)),
      }
    }
    detail.classList.toggle('agh-drawer', selected.kind === 'skill')
    if (selected.kind === 'skill') {
      renderRegion(
        detail,
        <UiLocaleProvider source={this.#locale}>
          <SkillDetailContent
            skill={selected}
            disabled={!this.writable() || this.#activeOperation !== undefined}
            actions={this.#detailActions(selected)}
            progress={progress}
            failure={failure}
            onAction={(action) => void this.#runAction(action)}
            onPrioritySave={(next) => void this.#savePriority(selected, next)}
            onClose={() => this.closeDetail()}
          />
        </UiLocaleProvider>,
      )
    } else {
      renderRegion(
        detail,
        <UiLocaleProvider source={this.#locale}>
          <McpDetailContent
            server={selected}
            disabled={!this.writable()}
            actions={this.#detailActions(selected)}
            progress={progress}
            failure={failure}
            onAction={(action) => void this.#runAction(action)}
            onStatus={async () => {
              const value = await this.api().mcpStatus(selected.serverId)
              const panel: (readonly [string, string])[] = [
                [this.#t('fact.connection'), value.connectionState],
                ...(selected.transportKind === 'stdio'
                  ? [
                      [
                        this.#t('sandbox.title'),
                        this.#t(`sandbox.${sandboxProfileOf(selected.definition)}`),
                      ] as const,
                    ]
                  : []),
                [this.#t('fact.tools'), String(value.toolCount)],
                [this.#t('fact.observed-revision'), value.observedRevision ?? this.#t('fact.none')],
                [this.#t('fact.catalog-revision'), value.catalogRevision ?? this.#t('fact.none')],
                [
                  this.#t('fact.updated-at'),
                  new Date(value.observedAt).toLocaleString(this.#locale.getSnapshot()),
                ],
              ]
              if (value.lastSafeError)
                panel.push([
                  this.#t('fact.safe-error'),
                  this.#detailT('safe-error', {
                    code: value.lastSafeError.code,
                    message: resourceFailureLabel(value.lastSafeError.code, this.#t),
                  }),
                ])
              return panel
            }}
            onTools={async (cursor) => {
              const result = await this.api().mcpTools(selected.serverId, cursor)
              return {
                items: result.items,
                nextCursor: result.nextCursor,
              }
            }}
            onEdit={() => openMcpDialog(selected)}
            onClose={() => this.closeDetail()}
            onToolDisclosure={(mode) => void saveToolDisclosure(this, selected, mode)}
          />
        </UiLocaleProvider>,
      )
    }
    this.openDetail(this.#itemName(selected))
  }

  /** 在**新**列表里找回资源行（React 键控行复用 DOM，焦点可精确归还）。 */
  #rowOf(resourceId: string): HTMLElement | undefined {
    return (
      list.querySelector<HTMLElement>(`.resource-row[data-resource-id="${CSS.escape(resourceId)}"]`) ??
      undefined
    )
  }

  #resourceList(onImport?: () => void) {
    return (
      <ResourceListContent
        tab={this.#tab}
        loadState={this.#loadState}
        items={
          this.#tab === 'skills' && this.#skillQuery
            ? this.#items.filter((item) =>
                `${this.#itemName(item)} ${item.kind === 'skill' ? (item.description ?? '') : ''}`
                  .toLocaleLowerCase(this.locale())
                  .includes(this.#skillQuery.toLocaleLowerCase(this.locale())),
              )
            : this.#items
        }
        skillRoots={this.#skillRoots}
        busy={this.#activeOperation !== undefined}
        busyResourceId={this.#activeSkillId}
        selectedId={this.#selected}
        nextCursor={this.#nextCursor}
        loadingMore={this.#loadMorePromise !== undefined}
        emptyTitle={this.#t(this.#tab === 'skills' ? 'empty.skills.title' : 'empty.mcp.title')}
        emptyDescription={
          this.#tab === 'skills' ? this.#t('empty.skills.description') : this.#t('empty.mcp.description')
        }
        switchDisabled={!this.writable() || (this.#activeOperation !== undefined && !this.#activeSkillId)}
        itemNameOf={(item) => this.#itemName(item)}
        onOpen={this.#openItem}
        onToggleDesired={this.#toggleItem}
        onLoadMore={() => void this.loadMore()}
        onRetry={() => void this.reload()}
        mcpActions={(item) => ({
          edit: () => {
            this.closeDetail()
            openMcpDialog(item, this.#t)
          },
          test: () => {
            const action = this.#detailActions(item).find(
              (action) => action.label === this.#t('action.test-mcp'),
            )
            if (action) void this.#runAction(action)
          },
          remove: () => {
            const action = this.#detailActions(item).find(
              (action) => action.label === this.#t('action.remove-mcp'),
            )
            if (action) void this.#runAction(action)
          },
        })}
        onImport={onImport ?? (() => undefined)}
        filtered={!!this.#skillQuery}
        menuOf={this.#menuOf}
      />
    )
  }
  #openItem = (item: Item): void => this.select(item.resourceId, this.#rowOf(item.resourceId))
  #toggleItem = (item: Item, next: boolean): void => void this.toggleDesired(item, next)
  #menuOf = (item: Item) =>
    resourceActionMenu(this.#detailActions(item), (action) => void this.#runAction(action))
  #itemName = (item: Item): string => (item.kind === 'skill' ? item.name : item.displayName)

  async toggleDesired(item: Item, next: boolean): Promise<void> {
    if (this.#activeOperation || this.#reloadPromise || this.#loadMorePromise || !this.writable()) return
    if (item.kind === 'skill' && item.sourceIdentity.scope === 'runtime') return
    const kind = item.kind === 'skill' ? 'Skill' : 'MCP'
    const summary = this.#t('action.request', {
      action: this.#t(next ? 'action.enable' : 'action.disable'),
      kind,
      name: this.#itemName(item),
      revision: `${item.revision.slice(0, 12)}…`,
    })
    const sandbox =
      item.kind === 'mcp' && item.definition.transport.kind === 'stdio'
        ? this.#t(`sandbox.${sandboxProfileOf(item.definition)}`)
        : ''
    if (!(await this.confirm(sandbox ? `${summary}\n${sandbox}` : summary))) return
    try {
      await this.#setDesired(item, next)
    } catch (error) {
      this.#activeOperation = undefined
      this.#activeSkillId = undefined
      this.showError(error)
    }
  }

  async #setDesired(item: Item, next: boolean): Promise<void> {
    if (next && item.trust !== 'trusted') {
      const trusted = await this.track(
        item.kind === 'skill'
          ? await this.api().skillTrust(item.resourceId, item.revision, 'trusted')
          : await this.api().mcpTrust(item.serverId, item.revision, 'trusted'),
        undefined,
        item.kind === 'skill' ? item.resourceId : undefined,
      )
      if (!trusted) return
      const current = this.#items.find((candidate) => candidate.resourceId === item.resourceId)
      if (!current || current.revision !== item.revision || current.trust !== 'trusted') {
        this.setNotice('notice.changed', 'warning')
        return
      }
      item = current
    }
    await this.track(
      item.kind === 'skill'
        ? await this.api().skillDesired(item.resourceId, item.revision, next ? 'enabled' : 'disabled')
        : next
          ? await this.api().mcpEnable(item.serverId, item.revision)
          : await this.api().mcpDisable(item.serverId, item.revision),
      undefined,
      item.kind === 'skill' ? item.resourceId : undefined,
    )
  }

  /** 动作规格统一走壳的确认链：确认框 → 提交 → track 轮询。 */
  #detailActions(item: Item): readonly ResourceDetailAction[] {
    const disabled = !this.writable() || this.#activeOperation !== undefined
    const specs: ResourceDetailAction[] = []
    if (item.kind === 'skill')
      return skillDetailActions(
        item,
        disabled,
        this.#t,
        (next) => this.#setDesired(item, next),
        () => this.api().skillRemove(item.resourceId, item.revision),
        { className: 'agh-btn--danger' },
      )
    const server = item
    const revision = `${server.revision.slice(0, 12)}…`
    const add = (
      label: string,
      summary: string,
      run: () => Promise<{ operationId: string } | undefined>,
      extra?: Partial<ResourceDetailAction>,
    ): void => {
      specs.push({ label, summary, run, disabled, ...extra })
    }
    add(
      this.#t('action.test-mcp'),
      this.#t('action.test-mcp-summary', { name: server.displayName, revision }),
      () => this.api().mcpTest(server.serverId, server.revision),
    )
    const sandboxSummary =
      server.transportKind === 'stdio' ? `\n${this.#t(`sandbox.${sandboxProfileOf(server.definition)}`)}` : ''
    add(
      this.#t(resourceDesiredEnabled(server) ? 'action.disable' : 'action.enable'),
      this.#t('action.request', {
        action: this.#t(resourceDesiredEnabled(server) ? 'action.disable' : 'action.enable'),
        kind: 'MCP',
        name: server.displayName,
        revision,
      }) + sandboxSummary,
      async () => {
        await this.#setDesired(server, !resourceDesiredEnabled(server))
        return undefined
      },
    )
    add(
      this.#t('action.reconnect'),
      this.#t('action.reconnect-summary', { name: server.displayName, revision }),
      () => this.api().mcpReconnect(server.serverId, server.revision),
    )
    add(
      this.#t('action.remove-mcp'),
      this.#t('action.remove-mcp-summary', { name: server.displayName, revision }),
      () => this.api().mcpRemove(server.serverId, server.revision),
      { className: 'agh-btn--danger' },
    )
    return specs
  }

  async #runAction(action: ResourceDetailAction): Promise<void> {
    if (this.#activeOperation || !this.writable()) return
    try {
      if (await this.confirm(action.summary)) {
        const receipt = await action.run()
        if (receipt) await this.track(receipt)
      }
    } catch (error) {
      // 旧 button() helper 的错误路径：动作失败必须落到页面通知，不能静默。
      this.showError(error)
      this.render()
    }
  }

  async #savePriority(skill: SkillDescriptor, next: number): Promise<void> {
    if (
      await this.confirm(
        this.#t('action.adjust-priority', {
          name: skill.name,
          current: skill.priority,
          next,
        }),
      )
    )
      await this.track(await this.api().skillPriority(skill.resourceId, skill.revision, skill.priority, next))
  }

  dispose(): void {
    this.lifetime.abort()
    this.#generation += 1
    this.#localeStop()
    this.#localeCleanup?.()
    // A later mount already took the shared form, dialogs and hosts over.
    if (activePage !== this) return
    this.#feedback.clear()
    activePage = undefined
    stopMcpRefresh?.()
    stopMcpRefresh = undefined
    for (const picker of mcpPickers) picker.destroy()
    mcpPickers = []
    mcpWizard?.dispose()
    mcpWizard = undefined
    mcpPresets?.dispose()
    mcpPresets = undefined
    unmountRegion(list)
    unmountRegion(detail)
  }
}

let editing: McpServerDescriptor | undefined
function writeDefinition(definition: McpServerDefinitionInput): void {
  $('mcp-workspace', 'input').value =
    ('workspacePath' in definition ? definition.workspacePath : undefined) ?? ''
  $('mcp-id', 'input').value = definition.serverId
  $('mcp-name', 'input').value = definition.displayName
  mcpTransport.value = definition.transport.kind
  $('mcp-sandbox', 'select').value = sandboxProfileOf(definition)
  $('mcp-executable', 'input').value =
    definition.transport.kind === 'stdio' ? definition.transport.executable : ''
  $('mcp-args', 'textarea').value =
    definition.transport.kind === 'stdio' ? definition.transport.args.join('\n') : ''
  $('mcp-url', 'input').value =
    definition.transport.kind === 'http' || definition.transport.kind === 'sse'
      ? definition.transport.url
      : ''
  mcpSecretKind.value = definition.secretBinding.kind
  // 'oauth' has no credentialRef (it carries an optional staticClientId instead); the OAuth admin
  // flow itself is a separate task (see the dedicated MCP OAuth Web UI plan) — this just keeps the
  // existing kind-by-kind rendering exhaustive now that the union has a fourth branch.
  $('mcp-secret', 'textarea').value =
    definition.secretBinding.kind === 'stdio-env'
      ? Object.entries(definition.secretBinding.env)
          .map(([name, reference]) => `${name}=${reference}`)
          .join('\n')
      : definition.secretBinding.kind === 'none'
        ? ''
        : definition.secretBinding.kind === 'oauth'
          ? (definition.secretBinding.staticClientId ?? '')
          : definition.secretBinding.credentialRef
  if (definition.secretBinding.kind === 'http-header')
    $('mcp-header-name', 'select').value = definition.secretBinding.headerName
  $('mcp-tools', 'textarea').value = definition.toolPolicy?.allow?.join('\n') ?? ''
}
function openMcpDialog(server?: McpServerDescriptor, t: LocaleTranslator = activeResourceText): void {
  editing = server
  form.reset()
  mcpPresets?.reset()
  if (server) writeDefinition(server.definition)
  mcpWizard?.reset(!!server)
  syncTransport(t)
  $('mcp-dialog-title', 'h2').textContent = server
    ? t('form.title.edit', { name: server.displayName })
    : t('form.title.create')
  $('mcp-id', 'input').disabled = !!server
  $('mcp-error', 'p').textContent = ''
  showDialogHost(dialog)
  const focus = server
    ? $('mcp-name', 'input')
    : (document.getElementById('mcp-method-local') ?? $('mcp-name', 'input'))
  focus.focus()
}
function syncResourcePickers(t: LocaleTranslator = activeResourceText): void {
  for (const picker of mcpPickers) picker.destroy()
  mcpPickers = [
    createSelectPicker($('mcp-sandbox', 'select'), { label: t('sandbox.title') }),
    createSelectPicker(mcpTransport, { label: t('select.transport') }),
    createSelectPicker(mcpSecretKind, { label: t('select.secret') }),
    createSelectPicker($('mcp-header-name', 'select'), { label: t('select.header') }),
  ]
}

function syncTransport(t: LocaleTranslator = activeResourceText): void {
  const stdio = mcpTransport.value === 'stdio'
  $('mcp-workspace-row', 'label').hidden = !stdio
  $('mcp-sandbox-row', 'label').hidden = !stdio
  $('mcp-executable-row', 'label').hidden = !stdio
  $('mcp-args-row', 'label').hidden = !stdio
  $('mcp-url-row', 'label').hidden = stdio
  const allowed = stdio ? ['none', 'stdio-env'] : ['none', 'http-bearer', 'http-header', 'oauth']
  for (const option of mcpSecretKind.options) option.hidden = !allowed.includes(option.value)
  if (!allowed.includes(mcpSecretKind.value)) mcpSecretKind.value = 'none'
  $('mcp-secret-row', 'label').hidden = ['none', 'oauth'].includes(mcpSecretKind.value)
  $('mcp-header-row', 'label').hidden = mcpSecretKind.value !== 'http-header'
  $('mcp-secret', 'textarea').placeholder =
    mcpSecretKind.value === 'stdio-env' ? t('placeholder.env') : 'secret://namespace/name'
  for (const picker of mcpPickers) picker.sync()
  syncMcpFieldFeedback()
}

export type ResourceAdminMount = Readonly<{
  ready: Promise<void>
  reload(): Promise<void>
  dispose(): void
  /** Re-scopes to the workbench's current workspace, or clears the scope when none is selected. */
  setWorkspace(workspaceId?: string): Promise<void>
  /** 设置页把「技能」和「MCP」做成两条独立 Tab，由宿主决定打开哪一类。 */
  setTab(tab: Tab): void
  /** Open one resource's detail, as a click on its row does. */
  select(resourceId: string): void
  sync(scope: ResourceScope, options?: { refresh?: boolean }): Promise<void>
}>

/**
 * Binds the Skill / MCP admin surface to markup already present in the current document.
 * Importing this module never touches the DOM; the host decides when to mount.
 */
export function mountResourceAdmin(options: ResourceAdminOptions = {}): ResourceAdminMount {
  let mcpSubmitting = false
  activePage?.dispose()
  surface = options.surface
  list = surface?.list ?? $('resource-list', 'section')
  detail = $('resource-detail', 'dialog')
  notice = surface?.notice ?? $('resource-notice', 'p')
  refreshButton = surface?.refresh ?? $('skill-refresh', 'button')
  createButton = surface?.create ?? $('mcp-create', 'button')
  dialog = $('mcp-dialog', 'dialog')
  form = $('mcp-form', 'form')
  mcpTransport = $('mcp-transport', 'select')
  mcpSecretKind = $('mcp-secret-kind', 'select')
  mcpForm = createMcpForm({
    transport: mcpTransport,
    secretKind: mcpSecretKind,
    text: () => activeResourceText,
  })
  const page = new ResourceAdminPage(options.workspaceId, options.tab, options.locale)
  activePage = page
  mcpWizard?.dispose()
  mcpWizard = mountMcpWizard(
    () => activeResourceText,
    () => syncTransport(),
  )
  mcpWizard.localize()
  syncResourcePickers(activeResourceText)
  mcpPresets?.dispose()
  mcpPresets = mountMcpPresets({
    form,
    toolbar: createButton.parentElement as HTMLElement,
    open: () => openMcpDialog(),
    fill: (definition) => {
      writeDefinition(definition)
      mcpWizard?.filled()
      syncTransport()
    },
    locale: () => page.locale(),
    text: () => activeResourceText,
  })
  mcpPresets.localize()

  // 详情是模态框：点遮罩、按 Escape、点「关闭详情」都要走同一条收尾路径（含焦点归还）。
  // The dialogs and the form are shared between mounts: every listener leaves with its mount.
  const stop = page.lifetime
  const bound = { signal: stop.signal }
  detail.addEventListener(
    'cancel',
    (event) => {
      event.preventDefault()
      page.closeDetail()
    },
    bound,
  )
  detail.addEventListener(
    'click',
    (event) => {
      if (event.target === detail) page.closeDetail()
    },
    bound,
  )
  // 添加 / 编辑 MCP 的弹窗同样点遮罩关闭。
  dialog.addEventListener(
    'click',
    (event) => {
      if (event.target === dialog) dialog.close()
    },
    bound,
  )

  refreshButton.addEventListener(
    'click',
    () =>
      void (async () => {
        if (await page.confirm(activeResourceText('action.refresh-skills'))) {
          if (await page.track(await page.api().refresh())) resolveFeedback('skill-folders')
        }
      })().catch((error) => page.showError(error)),
    bound,
  )
  createButton.addEventListener('click', () => openMcpDialog(undefined, activeResourceText), bound)
  $('mcp-cancel', 'button').addEventListener('click', () => dialog.close(), bound)
  mcpTransport.addEventListener('change', () => syncTransport(activeResourceText), bound)
  mcpSecretKind.addEventListener('change', () => syncTransport(activeResourceText), bound)
  // input/change 都在 form 上冒泡：文本框逐字触发 input，select 触发 change。
  // 必须包一层箭头函数——addEventListener 会把 Event 对象当第一个参数传进去。
  form.addEventListener('input', () => syncMcpFieldFeedback(), bound)
  form.addEventListener('change', () => syncMcpFieldFeedback(), bound)
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (mcpSubmitting) return
    mcpSubmitting = true
    const error = $('mcp-error', 'p')
    error.textContent = ''
    void (async () => {
      if (syncMcpFieldFeedback(true, activeResourceText).length) return
      const definition = keepToolDisclosure(definitionFromForm(activeResourceText), editing)
      const creating = !editing
      const summary = editing
        ? activeResourceText('action.update-mcp-summary', {
            name: editing.displayName,
            revision: `${editing.revision.slice(0, 12)}…`,
          })
        : activeResourceText('action.create-mcp-summary', { name: definition.displayName })
      const sandboxSummary =
        'sandboxProfile' in definition
          ? `\n${activeResourceText(`sandbox.${definition.sandboxProfile}`)}`
          : ''
      // A modal form closes before its confirmation; the draft remains in the mounted form. A form
      // shown as a page stays where it is, under the confirmation.
      if (!isPageDialog(dialog)) dialog.close()
      let confirmed = false
      try {
        confirmed = await page.confirm(summary + sandboxSummary)
      } finally {
        if (!confirmed && !stop.signal.aborted) showDialogHost(dialog)
      }
      if (!confirmed) return
      let receipt: ResourceOperationReceipt
      try {
        receipt = editing
          ? await page.api().mcpUpdate(editing.serverId, editing.revision, definition)
          : await page.api().mcpCreate(definition)
      } catch (cause) {
        if (!stop.signal.aborted) showDialogHost(dialog)
        throw cause
      }
      if (stop.signal.aborted) return
      editing = undefined
      if (dialog.open) dialog.close()
      await page.track(receipt, {
        message: activeResourceText(creating ? 'notice.created' : 'notice.updated', {
          name: definition.displayName,
        }),
      })
    })()
      .catch((cause) => {
        if (stop.signal.aborted) return
        if (dialog.open)
          error.textContent =
            cause instanceof McpFormValidationError
              ? cause.message
              : cause instanceof ResourceAdminApiError &&
                  ['ADMIN_UNAVAILABLE', 'RESOURCE_ADMIN_UNAVAILABLE'].includes(cause.details.code)
                ? activeResourceText('error.unavailable')
                : resourceFailureLabel(errorOf(cause).code, activeResourceText)
        else page.showError(cause)
      })
      .finally(() => {
        mcpSubmitting = false
      })
  }
  form.addEventListener('submit', submit, bound)
  syncTransport(activeResourceText)
  stopMcpRefresh?.()
  stopMcpRefresh = watchMcpPanel({
    root: list,
    visible: () =>
      !list.closest('[hidden]') &&
      (surface
        ? page.tab() === 'mcp'
        : document.getElementById('mcp-tab')?.getAttribute('aria-selected') === 'true' ||
          document.getElementById('mcp-tab')?.getAttribute('aria-current') === 'page'),
    refresh: () => page.refreshMcpIfChanged(),
  })
  const ready = page.start()
  return {
    ready,
    reload: () => page.reload(),
    dispose: () => {
      stop.abort()
      page.dispose()
    },
    setWorkspace: (id) => page.setWorkspace(id),
    setTab: (tab) => page.setTab(tab),
    select: (resourceId) => page.select(resourceId),
    sync: (scope, options) => page.sync(scope, options),
  }
}
function syncMcpFieldFeedback(requireFilled = false, t: LocaleTranslator = activeResourceText) {
  return mcpForm.syncMcpFieldFeedback(requireFilled, t)
}
function definitionFromForm(t: LocaleTranslator = activeResourceText) {
  return mcpForm.definitionFromForm(t)
}
