import type {
  McpServerDefinitionInput,
  McpServerDescriptor,
  ResourceOperation,
  SkillDescriptor,
  SkillRootStatus,
} from '@agnes/protocol'
import {
  type ConfirmController,
  createConfirmController,
  createDocumentLocaleSource,
  createSelectPicker,
  createUiTranslator,
  type LocaleTranslator,
  McpDetailContent,
  RESOURCE_DETAIL_LOCALE_NAMESPACE,
  RESOURCE_LIST_LOCALE_NAMESPACE,
  type ResourceDetailAction,
  ResourceListContent,
  type ResourceProgress,
  materializeSettingsControls,
  renderRegion,
  resourceDesiredEnabled,
  resourceDetailLocaleCatalog,
  resourceFailureKey,
  resourceFailureLabel,
  resourceListLocaleCatalog,
  type SelectPicker,
  SkillDetailContent,
  UiLocaleProvider,
  type UiLocaleSource,
  unmountRegion,
} from '@agnes/web-ui'
import { $ } from './admin-dom.js'
import { ResourceAdminApi, ResourceAdminApiError } from './api.js'
import { RESOURCE_ADMIN_LOCALE_NAMESPACE, resourceAdminLocaleCatalog } from './locales/admin.js'
import { createMcpForm, McpFormValidationError } from './mcp-form.js'
import { watchMcpPanel } from './mcp-refresh.js'
import { SKILL_LOCATION_HINTS } from './skill-copy.js'
import type { ResourceAdminContext, ResourceAdminError } from './types.js'

let list!: HTMLElement
let detail!: HTMLDialogElement
let notice!: HTMLElement
let dialog!: HTMLDialogElement
let form!: HTMLFormElement
let mcpTransport!: HTMLSelectElement
let mcpSecretKind!: HTMLSelectElement
let mcpForm!: ReturnType<typeof createMcpForm>
let mcpPickers: SelectPicker[] = []
let stopMcpRefresh: (() => void) | undefined
const terminal = new Set<ResourceOperation['state']>(['succeeded', 'failed', 'cancelled'])

type Tab = 'skills' | 'mcp'
type Item = SkillDescriptor | McpServerDescriptor
type ResourceLoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type ResourceAdminOptions = {
  workspaceId?: string
  tab?: Tab
  embedded?: boolean
  locale?: UiLocaleSource
}
export type ResourceScope = Readonly<{ tab: Tab; workspaceId?: string }>

function normalizeWorkspaceId(workspaceId?: string): string | undefined {
  return workspaceId && /^[a-f0-9]{64}$/.test(workspaceId) ? workspaceId : undefined
}
const errorOf = (error: unknown): ResourceAdminError =>
  error instanceof ResourceAdminApiError
    ? error.details
    : {
        code: 'RESOURCE_ADMIN_UNAVAILABLE',
        message: 'The resource admin service is temporarily unavailable. Try again later.',
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
  readonly #locale: UiLocaleSource
  readonly #localeStop: () => void
  readonly #localeCleanup?: () => void
  readonly #t: LocaleTranslator
  readonly #detailT: LocaleTranslator
  #api: ResourceAdminApi | undefined
  #context: ResourceAdminContext | undefined
  #tab: Tab = 'skills'
  #items: Item[] = []
  #skillRoots: SkillRootStatus[] = []
  #selected: string | undefined
  #detailTrigger: HTMLElement | undefined
  #generation = 0
  #operations = new Map<string, ResourceOperation>()
  #activeOperation: string | undefined
  #nextCursor: string | undefined
  #workspaceId: string | undefined
  #loadState: ResourceLoadState = 'idle'
  #reloadPromise: Promise<void> | undefined
  #loadMorePromise: Promise<void> | undefined
  #loadedTab: Tab | undefined
  #loadedWorkspace: string | undefined
  #notice: {
    key?: string
    vars?: Readonly<Record<string, string | number>>
    raw?: string
    kind: string
  } = { raw: '', kind: '' }

  constructor(workspaceId?: string, tab: Tab = 'skills', locale?: UiLocaleSource) {
    this.#workspaceId = normalizeWorkspaceId(workspaceId)
    this.#tab = tab
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
      if (dialog?.open)
        $('mcp-dialog-title', 'h2').textContent = editing
          ? this.#t('form.title.edit', { name: editing.displayName })
          : this.#t('form.title.create')
      this.render()
    })
  }

  confirm(summary: string): Promise<boolean> {
    return confirmEffect(summary, this.#t)
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
    if (!preserveNotice) {
      this.setNotice('notice.loading')
    }
    try {
      const context = this.#context ?? (await ResourceAdminApi.context())
      this.#context = context
      this.#api = new ResourceAdminApi(context, fetch, requestWorkspace)
      const result = requestTab === 'skills' ? await this.#api.skills() : await this.#api.mcp()
      if (generation !== this.#generation) return
      if (requestTab !== this.#tab || requestWorkspace !== this.#workspaceId) return
      this.#items = result.items
      this.#skillRoots = requestTab === 'skills' && 'skillRoots' in result ? (result.skillRoots ?? []) : []
      this.#nextCursor = result.nextCursor
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
    if (!this.#api) throw new Error(this.#t('error.not-connected'))
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
  /** 详情是模态框：打开一次即可，重复 render 不能反复 showModal（会抛 InvalidStateError）。 */
  openDetail(label: string): void {
    detail.setAttribute('aria-label', label)
    if (detail.open) return
    try {
      detail.showModal()
    } catch {
      detail.setAttribute('open', '')
    }
  }
  #closeDetailDialog(): void {
    if (!detail.open) return
    try {
      detail.close()
    } catch {
      detail.removeAttribute('open')
    }
  }
  /**
   * 关闭详情并把焦点还给当初打开它的那一行。
   *
   * 不能用当初点击的那个行元素：`render()` 会 `replaceChildren()` 重建整个列表，那个引用
   * 在调用点已经脱离文档（`isConnected === false`），焦点只会落回 body。与插件页一致，
   * 按 `data-resource-id` 在**新**列表里找回对应的行。
   */
  closeDetail(): void {
    const targetId = this.#detailTrigger?.dataset.resourceId
    this.#closeDetailDialog()
    this.#selected = undefined
    this.#detailTrigger = undefined
    this.render()
    if (!targetId) return
    for (const row of list.querySelectorAll<HTMLElement>('.resource-row')) {
      if (row.dataset.resourceId !== targetId) continue
      row.querySelector<HTMLButtonElement>('.plugin-details-button')?.focus({ preventScroll: true })
      return
    }
  }
  setTab(tab: Tab): void {
    if (this.#tab === tab) return
    this.#tab = tab
    this.#selected = undefined
    void this.#ensureLoaded()
  }
  async loadMore(): Promise<void> {
    if (!this.#nextCursor || this.#loadMorePromise || this.#reloadPromise) return
    const cursor = this.#nextCursor
    const requestTab = this.#tab
    const requestWorkspace = this.#workspaceId
    const requestGeneration = this.#generation
    this.#loadMorePromise = (async () => {
      try {
        const result =
          requestTab === 'skills' ? await this.api().skills(cursor) : await this.api().mcp(cursor)
        if (
          requestGeneration !== this.#generation ||
          requestTab !== this.#tab ||
          requestWorkspace !== this.#workspaceId
        )
          return
        const known = new Set(this.#items.map((item) => item.resourceId))
        this.#items = [...this.#items, ...result.items.filter((item) => !known.has(item.resourceId))]
        this.#nextCursor = result.nextCursor
        this.#loadState = this.#items.length ? 'ready' : 'empty'
      } catch (error) {
        this.setNotice('notice.load-more-failed', 'error')
        this.showError(error)
      } finally {
        this.#loadMorePromise = undefined
        this.render()
      }
    })()
    await this.#loadMorePromise
  }
  async track(receipt: { operationId: string }): Promise<boolean> {
    const api = this.api()
    this.#activeOperation = receipt.operationId
    this.setNotice('notice.submitted')
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const op = await api.operation(receipt.operationId)
      this.#operations.set(op.operationId, op)
      this.render()
      if (terminal.has(op.state)) {
        this.#activeOperation = undefined
        if (op.state === 'succeeded') this.setNotice('notice.succeeded', 'success')
        else if (op.lastSafeError?.message) this.setNotice(resourceFailureKey(op.lastSafeError.code), 'error')
        else this.setNotice('notice.failed', 'error')
        await this.reload(true)
        if (this.#loadState === 'error') return false
        return op.state === 'succeeded'
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    this.#activeOperation = undefined
    this.setNotice('notice.running', 'warning')
    return false
  }

  render(): void {
    const heading = document.querySelector<HTMLElement>('#resource-settings-pane h2')
    if (heading) {
      heading.dataset.i18n = `tab.${this.#tab}`
      heading.textContent = this.#t(`tab.${this.#tab}`)
    }
    const addHint = document.querySelector<HTMLElement>(
      '#resource-settings-pane [data-i18n="shell.embedded.add-description"]',
    )
    if (addHint) addHint.hidden = this.#tab !== 'mcp'
    notice.textContent = this.#notice.key
      ? this.#t(this.#notice.key, this.#notice.vars)
      : (this.#notice.raw ?? '')
    notice.dataset.kind = this.#notice.kind
    const skillTab = $('skills-tab', 'button')
    const mcpTab = $('mcp-tab', 'button')
    for (const [control, selected] of [
      [skillTab, this.#tab === 'skills'],
      [mcpTab, this.#tab === 'mcp'],
    ] as const) {
      if (control.getAttribute('role') === 'tab') {
        control.setAttribute('aria-selected', String(selected))
        control.tabIndex = selected ? 0 : -1
      } else {
        control.removeAttribute('aria-selected')
        control.setAttribute('aria-current', selected ? 'page' : 'false')
        control.tabIndex = 0
      }
    }
    $('skill-refresh', 'button').hidden = this.#tab !== 'skills'
    const busy = this.#reloadPromise !== undefined || this.#loadMorePromise !== undefined
    $('skill-refresh', 'button').disabled = !this.writable() || busy
    $('mcp-create', 'button').hidden = true
    $('mcp-create', 'button').disabled = !this.writable() || busy
    list.dataset.state = this.#loadState
    list.setAttribute('aria-busy', String(this.#loadState === 'loading'))
    renderRegion(
      list,
      <UiLocaleProvider source={this.#locale}>
        <ResourceListContent
          tab={this.#tab}
          loadState={this.#loadState}
          items={this.#items}
          skillRoots={this.#skillRoots}
          selectedId={this.#selected}
          nextCursor={this.#nextCursor}
          loadingMore={this.#loadMorePromise !== undefined}
          emptyTitle={this.#t(this.#tab === 'skills' ? 'empty.skills.title' : 'empty.mcp.title')}
          emptyDescription={
            this.#tab === 'skills' ? this.#t('empty.skills.description') : this.#t('empty.mcp.description')
          }
          emptyHints={this.#tab === 'skills' ? SKILL_LOCATION_HINTS : undefined}
          switchDisabled={!this.writable() || this.#activeOperation !== undefined}
          itemNameOf={(item) => this.#itemName(item)}
          onOpen={(item) => this.select(item.resourceId, this.#rowOf(item.resourceId))}
          onToggleDesired={(item, next) => void this.toggleDesired(item, next)}
          onLoadMore={() => void this.loadMore()}
          onRetry={() => void this.reload()}
        />
      </UiLocaleProvider>,
    )
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
    if (selected.kind === 'skill') {
      renderRegion(
        detail,
        <UiLocaleProvider source={this.#locale}>
          <SkillDetailContent
            skill={selected}
            disabled={!this.writable() || this.#activeOperation !== undefined}
            actions={this.#detailActions(selected)}
            progress={progress}
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
            onAction={(action) => void this.#runAction(action)}
            onStatus={async () => {
              const value = await this.api().mcpStatus(selected.serverId)
              const panel: (readonly [string, string])[] = [
                [this.#t('fact.connection'), value.connectionState],
                ...(selected.transportKind === 'stdio'
                  ? [
                      [
                        this.#t('sandbox.title'),
                        this.#t(
                          'sandbox.' +
                            (('sandboxProfile' in selected.definition
                              ? selected.definition.sandboxProfile
                              : undefined) ?? 'strict'),
                        ),
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
                names: result.items.map((tool) =>
                  tool.description ? `${tool.name} — ${tool.description}` : tool.name,
                ),
                nextCursor: result.nextCursor,
              }
            }}
            onEdit={() => openMcpDialog(selected)}
            onClose={() => this.closeDetail()}
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

  #itemName(item: Item): string {
    return item.kind === 'skill' ? item.name : item.displayName
  }

  async toggleDesired(item: Item, next: boolean): Promise<void> {
    const kind = item.kind === 'skill' ? 'Skill' : 'MCP'
    const summary = this.#t('action.request', {
      action: this.#t(next ? 'action.enable' : 'action.disable'),
      kind,
      name: this.#itemName(item),
      revision: `${item.revision.slice(0, 12)}…`,
    })
    const sandbox =
      item.kind === 'mcp' && item.definition.transport.kind === 'stdio'
        ? this.#t(
            'sandbox.' +
              (('sandboxProfile' in item.definition ? item.definition.sandboxProfile : undefined) ??
                'strict'),
          )
        : ''
    if (!(await this.confirm(sandbox ? summary + '\n' + sandbox : summary))) return
    try {
      await this.#setDesired(item, next)
    } catch (error) {
      this.showError(error)
      this.render()
    }
  }

  async #setDesired(item: Item, next: boolean): Promise<void> {
    if (next && item.trust !== 'trusted') {
      const trusted = await this.track(
        item.kind === 'skill'
          ? await this.api().skillTrust(item.resourceId, item.revision, 'trusted')
          : await this.api().mcpTrust(item.serverId, item.revision, 'trusted'),
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
    )
  }

  /** 动作规格统一走壳的确认链：确认框 → 提交 → track 轮询。 */
  #detailActions(item: Item): readonly ResourceDetailAction[] {
    const disabled = !this.writable() || this.#activeOperation !== undefined
    const specs: ResourceDetailAction[] = []
    if (item.kind === 'skill') {
      const skill = item
      const removing = skill.lastSafeError?.code === 'SKILL_REMOVAL_PENDING'
      const add = (
        label: string,
        summary: string,
        run: () => Promise<{ operationId: string } | undefined>,
        extra?: Partial<ResourceDetailAction>,
      ): void => {
        specs.push({
          label,
          summary,
          run,
          disabled: disabled || (removing && label !== this.#t('action.remove-skill.label')),
          ...extra,
        })
      }
      add(
        this.#t(resourceDesiredEnabled(skill) ? 'action.disable' : 'action.enable'),
        this.#t('action.request', {
          action: this.#t(resourceDesiredEnabled(skill) ? 'action.disable' : 'action.enable'),
          kind: this.#t('tab.skills'),
          name: skill.name,
          revision: `${skill.revision.slice(0, 12)}…`,
        }),
        async () => {
          await this.#setDesired(skill, !resourceDesiredEnabled(skill))
          return undefined
        },
      )
      if (skill.sourceIdentity.scope === 'workspace' || skill.sourceIdentity.scope === 'user') {
        add(
          this.#t('action.remove-skill.label'),
          this.#t('action.remove-skill.summary', { name: skill.name }),
          () => this.api().skillRemove(skill.resourceId, skill.revision),
          { className: 'danger-button compact' },
        )
      }
      return specs
    }
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
      server.transportKind === 'stdio'
        ? '\n' +
          this.#t(
            'sandbox.' +
              (('sandboxProfile' in server.definition ? server.definition.sandboxProfile : undefined) ??
                'strict'),
          )
        : ''
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
      { className: 'danger-button compact' },
    )
    return specs
  }

  async #runAction(action: ResourceDetailAction): Promise<void> {
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
    this.#localeStop()
    this.#localeCleanup?.()
    stopMcpRefresh?.()
    stopMcpRefresh = undefined
    for (const picker of mcpPickers) picker.destroy()
    mcpPickers = []
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
  $('mcp-sandbox', 'select').value =
    ('sandboxProfile' in definition ? definition.sandboxProfile : undefined) ?? 'strict'
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
  if (server) writeDefinition(server.definition)
  syncTransport(t)
  $('mcp-dialog-title', 'h2').textContent = server
    ? t('form.title.edit', { name: server.displayName })
    : t('form.title.create')
  $('mcp-id', 'input').disabled = !!server
  $('mcp-error', 'p').textContent = ''
  dialog.showModal()
  $('mcp-name', 'input').focus()
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
  const allowed = stdio ? ['none', 'stdio-env'] : ['none', 'http-bearer', 'http-header']
  for (const option of mcpSecretKind.options) option.hidden = !allowed.includes(option.value)
  if (!allowed.includes(mcpSecretKind.value)) mcpSecretKind.value = 'none'
  $('mcp-secret-row', 'label').hidden = mcpSecretKind.value === 'none'
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
  sync(scope: ResourceScope, options?: { refresh?: boolean }): Promise<void>
}>

/**
 * Binds the Skill / MCP admin surface to markup already present in the current document.
 * Importing this module never touches the DOM; the host decides when to mount.
 */
export function mountResourceAdmin(options: ResourceAdminOptions = {}): ResourceAdminMount {
  materializeSettingsControls(document)
  list = $('resource-list', 'section')
  detail = $('resource-detail', 'dialog')
  notice = $('resource-notice', 'p')
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
  syncResourcePickers(activeResourceText)

  // 详情是模态框：点遮罩、按 Escape、点「关闭详情」都要走同一条收尾路径（含焦点归还）。
  detail.addEventListener('cancel', (event) => {
    event.preventDefault()
    page.closeDetail()
  })
  detail.addEventListener('click', (event) => {
    if (event.target === detail) page.closeDetail()
  })
  // 添加 / 编辑 MCP 的弹窗同样点遮罩关闭。
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  if (!options.embedded) {
    $('skills-tab', 'button').addEventListener('click', () => page.setTab('skills'))
    $('mcp-tab', 'button').addEventListener('click', () => page.setTab('mcp'))
    for (const [tab, id] of [
      ['skills', 'skills-tab'],
      ['mcp', 'mcp-tab'],
    ] as const) {
      $(id, 'button').addEventListener('keydown', (event) => {
        let next: Tab | undefined
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = tab === 'skills' ? 'mcp' : 'skills'
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
          next = tab === 'skills' ? 'mcp' : 'skills'
        if (event.key === 'Home') next = 'skills'
        if (event.key === 'End') next = 'mcp'
        if (!next) return
        event.preventDefault()
        page.setTab(next)
        $(next === 'skills' ? 'skills-tab' : 'mcp-tab', 'button').focus()
      })
    }
  }
  $('skill-refresh', 'button').addEventListener(
    'click',
    () =>
      void (async () => {
        if (await page.confirm(activeResourceText('action.refresh-skills')))
          await page.track(await page.api().refresh())
      })().catch((error) => page.showError(error)),
  )
  $('mcp-create', 'button').addEventListener('click', () => openMcpDialog(undefined, activeResourceText))
  $('mcp-cancel', 'button').addEventListener('click', () => dialog.close())
  mcpTransport.addEventListener('change', () => syncTransport(activeResourceText))
  mcpSecretKind.addEventListener('change', () => syncTransport(activeResourceText))
  // input/change 都在 form 上冒泡：文本框逐字触发 input，select 触发 change。
  // 必须包一层箭头函数——addEventListener 会把 Event 对象当第一个参数传进去。
  form.addEventListener('input', () => syncMcpFieldFeedback())
  form.addEventListener('change', () => syncMcpFieldFeedback())
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const error = $('mcp-error', 'p')
    error.textContent = ''
    void (async () => {
      if (syncMcpFieldFeedback(true, activeResourceText).length) return
      const definition = definitionFromForm(activeResourceText)
      const creating = !editing
      const summary = editing
        ? activeResourceText('action.update-mcp-summary', {
            name: editing.displayName,
            revision: `${editing.revision.slice(0, 12)}…`,
          })
        : activeResourceText('action.create-mcp-summary', { name: definition.displayName })
      const sandboxSummary =
        'sandboxProfile' in definition
          ? '\n' + activeResourceText('sandbox.' + definition.sandboxProfile)
          : ''
      if (!(await page.confirm(summary + sandboxSummary))) return
      const receipt = editing
        ? await page.api().mcpUpdate(editing.serverId, editing.revision, definition)
        : await page.api().mcpCreate(definition)
      dialog.close()
      editing = undefined
      await page.track(receipt)
      // track() already reported success generically; a new server still needs an explicit enable.
      if (creating && notice.dataset.kind === 'success')
        page.setNotice('notice.created', 'success', { name: definition.displayName })
    })().catch((cause) => {
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
  })
  syncTransport(activeResourceText)
  stopMcpRefresh?.()
  stopMcpRefresh = watchMcpPanel({
    root: list,
    visible: () =>
      !list.closest('[hidden]') &&
      (document.getElementById('mcp-tab')?.getAttribute('aria-selected') === 'true' ||
        document.getElementById('mcp-tab')?.getAttribute('aria-current') === 'page'),
    refresh: () => page.refreshMcpIfChanged(),
  })
  const ready = page.start()
  return {
    ready,
    reload: () => page.reload(),
    dispose: () => page.dispose(),
    setWorkspace: (id) => page.setWorkspace(id),
    setTab: (tab) => page.setTab(tab),
    sync: (scope, options) => page.sync(scope, options),
  }
}
function syncMcpFieldFeedback(requireFilled = false, t: LocaleTranslator = activeResourceText) {
  return mcpForm.syncMcpFieldFeedback(requireFilled, t)
}
function definitionFromForm(t: LocaleTranslator = activeResourceText) {
  return mcpForm.definitionFromForm(t)
}
