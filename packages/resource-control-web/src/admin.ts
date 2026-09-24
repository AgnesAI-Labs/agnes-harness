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
  createSelectPicker,
  createStateLights,
  createSwitch,
  type SelectPicker,
  type StateTone,
} from '@agnes/web-admin-frame'
import { ResourceAdminApi, ResourceAdminApiError } from './api.js'
import { type McpFormFieldId, type McpFormFieldSnapshot, mcpFormIssues } from './mcp-form-validation.js'
import { watchMcpPanel } from './mcp-refresh.js'
import { SKILL_EMPTY_DESCRIPTION, SKILL_EMPTY_TITLE, SKILL_LOCATION_HINTS } from './skill-copy.js'
import type { ResourceAdminContext, ResourceAdminError } from './types.js'

const $ = <K extends keyof HTMLElementTagNameMap>(id: string, tag: K): HTMLElementTagNameMap[K] => {
  const item = document.getElementById(id)
  if (!item || item.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return item as HTMLElementTagNameMap[K]
}
// Resolved by mountResourceAdmin(). Declared here so the module can be imported without touching the
// DOM; a host that never mounts never triggers a lookup.
let list!: HTMLElement
let detail!: HTMLDialogElement
let notice!: HTMLElement
let dialog!: HTMLDialogElement
let form!: HTMLFormElement
let mcpTransport!: HTMLSelectElement
let mcpSecretKind!: HTMLSelectElement
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
}
export type ResourceScope = Readonly<{ tab: Tab; workspaceId?: string }>

function normalizeWorkspaceId(workspaceId?: string): string | undefined {
  return workspaceId && /^[a-f0-9]{64}$/.test(workspaceId) ? workspaceId : undefined
}
const errorOf = (error: unknown): ResourceAdminError =>
  error instanceof ResourceAdminApiError
    ? error.details
    : { code: 'RESOURCE_ADMIN_UNAVAILABLE', message: '资源管理后台暂时不可用，请稍后重试。' }
const text = (tag: keyof HTMLElementTagNameMap, value: string, className?: string): HTMLElement => {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = value
  return node
}
function emptyState(title: string, description: string, hints: readonly string[] = []): HTMLElement {
  const empty = document.createElement('div')
  empty.className = 'admin-empty-state resource-empty'
  const mark = document.createElement('span')
  mark.className = 'agnes-mark admin-empty-state-mark'
  mark.setAttribute('aria-hidden', 'true')
  const hintList = document.createElement('ul')
  hintList.className = 'admin-empty-state-hints'
  for (const hint of hints) hintList.append(text('li', hint))
  empty.append(mark, text('h2', title), text('p', description))
  if (hints.length) empty.append(hintList)
  return empty
}
function button(
  label: string,
  onClick: () => void | Promise<void>,
  className = 'secondary-button compact',
): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = label
  node.addEventListener('click', () => void Promise.resolve(onClick()).catch(showError))
  return node
}
function safeStatus(value: string): string {
  return (
    (
      {
        ready: '已就绪',
        disabled: '已停用',
        unavailable: '不可用',
        degraded: '异常',
        preparing: '准备中',
        connecting: '连接中',
        enabled: '已启用',
        untrusted: '未信任',
        trusted: '已信任',
        rejected: '已拒绝',
      } as Record<string, string>
    )[value] ?? value
  )
}
/**
 * 扫描失败的原因码 → 用户可读说明。只描述原因，**不含路径或目录名**（DTO 本身也只带原因码）。
 * 有了它，页面才能回答"为什么这个来源没有结果"，而不只是"刷新失败"。
 */
const ROOT_FAILURE_COPY: Record<NonNullable<SkillRootStatus['diagnostic']>['code'], string> = {
  'root-unreadable': '目录读不到',
  'root-unresolvable': '目录位置无法解析',
  'entry-limit': '目录里的条目数超过上限',
  'root-bytes-limit': '目录内容超过体积上限',
  'workspace-key-missing': '缺少工作区标识',
  'entry-outside-root': '有条目指向该来源之外',
  'skill-file-unreadable': 'SKILL.md 读不到或大小不合法',
  'skill-body-too-large': 'SKILL.md 正文超过体积上限',
  'invalid-frontmatter': '有 SKILL.md 的 frontmatter 不合法（常见：description 为空）',
  'entries-skipped': '部分条目不合规，已跳过',
}
/**
 * 信任 / 期望 / 实际三格各自的灯色。
 *
 * 三格回答的是三个不同问题，所以同一档颜色在三格里的含义必须一致：绿=这一格是"好的"、
 * 黄=还需要人看一眼、红=坏了、灰=正常的关闭态。未信任是黄而不是红——它只是还没被批准。
 */
const trustTone = (trust: string): StateTone =>
  trust === 'trusted' ? 'ok' : trust === 'rejected' ? 'bad' : 'warn'
const desiredTone = (desired: string): StateTone => (desired === 'enabled' ? 'ok' : 'off')
function actualTone(actual: string): StateTone {
  if (actual === 'ready' || actual === 'enabled') return 'ok'
  if (actual === 'disabled') return 'off'
  if (actual === 'preparing' || actual === 'connecting' || actual === 'degraded') return 'warn'
  if (actual === 'unavailable' || actual === 'rejected' || actual === 'failed') return 'bad'
  return 'unknown'
}

function showError(error: unknown): void {
  const value = errorOf(error)
  notice.textContent = value.message
  notice.dataset.kind = 'error'
}
let confirmController: ConfirmController | undefined
/**
 * 确认走共享弹窗（@agnes/web-admin-frame），不再用浏览器原生 confirm：原生弹窗无法跟随主题、
 * 无法展示结构化事实，也与插件页的确认体验不一致。
 */
async function confirmEffect(summary: string): Promise<boolean> {
  confirmController ??= createConfirmController()
  return confirmController.ask({
    title: '确认操作',
    description: `${summary}\n\n确认后将提交到本地后台；后台会按当前 revision、信任和策略再次校验。`,
  })
}

/** 详情三段式：头部固定 / 中段滚动 / 动作固定。操作按钮因此永远留在可视区内。 */
type DetailParts = Readonly<{ head: HTMLElement; body: HTMLElement; actions: HTMLElement }>

class ResourceAdminPage {
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

  constructor(workspaceId?: string, tab: Tab = 'skills') {
    this.#workspaceId = normalizeWorkspaceId(workspaceId)
    this.#tab = tab
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
      notice.textContent = '正在读取本地资源目录…'
      notice.dataset.kind = ''
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
        notice.textContent = context.readOnly ? '后台处于只读恢复模式；可以查看状态，不能更改资源。' : ''
        notice.dataset.kind = context.readOnly ? 'warning' : ''
      }
      this.render()
    } catch (error) {
      if (generation === this.#generation) {
        this.#loadState = 'error'
        showError(error)
        this.render()
      }
    }
  }
  api(): ResourceAdminApi {
    if (!this.#api) throw new Error('资源管理尚未连接')
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
      row.focus({ preventScroll: true })
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
        notice.textContent = '读取更多资源失败，可重试。'
        notice.dataset.kind = 'error'
        showError(error)
      } finally {
        this.#loadMorePromise = undefined
        this.render()
      }
    })()
    await this.#loadMorePromise
  }
  async track(receipt: { operationId: string }): Promise<void> {
    const api = this.api()
    this.#activeOperation = receipt.operationId
    notice.textContent = '操作已提交，正在等待后台确认…'
    notice.dataset.kind = ''
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const op = await api.operation(receipt.operationId)
      this.#operations.set(op.operationId, op)
      this.render()
      if (terminal.has(op.state)) {
        this.#activeOperation = undefined
        notice.textContent =
          op.state === 'succeeded'
            ? '控制面已更新。空闲会话的下一次请求会使用新快照；正在进行的回合会等到本回合结束后再切换，刷新成功不等于所有会话已经切换。'
            : (op.lastSafeError?.message ?? '操作未完成，请查看安全状态。')
        notice.dataset.kind = op.state === 'succeeded' ? 'success' : 'error'
        await this.reload(true)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    this.#activeOperation = undefined
    notice.textContent = '操作仍在后台运行；可稍后刷新状态。'
    notice.dataset.kind = 'warning'
  }
  render(): void {
    const skillTab = $('skills-tab', 'button')
    const mcpTab = $('mcp-tab', 'button')
    skillTab.setAttribute('aria-selected', String(this.#tab === 'skills'))
    mcpTab.setAttribute('aria-selected', String(this.#tab === 'mcp'))
    skillTab.tabIndex = this.#tab === 'skills' ? 0 : -1
    mcpTab.tabIndex = this.#tab === 'mcp' ? 0 : -1
    $('skill-refresh', 'button').hidden = this.#tab !== 'skills'
    const busy = this.#reloadPromise !== undefined || this.#loadMorePromise !== undefined
    $('skill-refresh', 'button').disabled = !this.writable() || busy
    $('mcp-create', 'button').hidden = true
    $('mcp-create', 'button').disabled = !this.writable() || busy
    list.dataset.state = this.#loadState
    list.setAttribute('aria-busy', String(this.#loadState === 'loading'))
    if (this.#loadState === 'error' && !notice.querySelector('[data-resource-retry]')) {
      const message = notice.textContent ?? '资源目录读取失败。'
      const retry = button('重试读取', () => this.reload())
      retry.dataset.resourceRetry = ''
      notice.replaceChildren(document.createTextNode(message), retry)
    }
    list.replaceChildren()
    detail.replaceChildren()
    if (this.#tab === 'skills' && this.#skillRoots.length) list.append(this.#renderRoots())
    if (!this.#items.length && this.#loadState !== 'loading' && this.#loadState !== 'error')
      list.append(
        this.#tab === 'skills'
          ? emptyState(SKILL_EMPTY_TITLE, SKILL_EMPTY_DESCRIPTION, SKILL_LOCATION_HINTS)
          : emptyState('还没有 MCP 服务', '添加一个 MCP 服务后，可以在这里查看连接、信任和启用状态。'),
      )
    for (const item of this.#items) {
      // 行不再是 <button>：行内现在有一颗 Switch，而交互式元素不能嵌在 button 里。
      // 与插件页一致，用 article + role="button" 承担"打开详情"。
      const row = document.createElement('article')
      row.className = 'plugin-row resource-row'
      row.dataset.resourceId = item.resourceId
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      const selected = item.resourceId === this.#selected
      row.dataset.selected = String(selected)
      row.setAttribute('aria-pressed', String(selected))
      row.setAttribute('aria-label', `查看 ${item.kind === 'skill' ? item.name : item.displayName} 的详情`)
      row.append(this.#renderRowContent(item), this.#renderRowStates(item), this.#renderRowSwitch(item))
      row.addEventListener('click', (event) => {
        // 行内 Switch 自己处理点击（并已 stopPropagation）；这里再挡一次，
        // 因为置灰的按钮在部分浏览器里不发 click，事件会落到行上。
        if (event.target instanceof Element && event.target.closest('.switch')) return
        this.select(item.resourceId, row)
      })
      row.addEventListener('keydown', (event) => {
        // 行内控件的按键会冒泡到行：焦点在 Switch 上按空格是拨开关，不是打开详情。
        if (event.target !== row) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.select(item.resourceId, row)
        }
      })
      list.append(row)
    }
    const selected = this.#items.find((item) => item.resourceId === this.#selected)
    if (this.#nextCursor) {
      const more = button('加载更多', () => this.loadMore())
      more.disabled = !this.writable() || busy
      more.setAttribute('aria-busy', String(this.#loadMorePromise !== undefined))
      list.append(more)
    }
    if (!selected) {
      this.#closeDetailDialog()
      return
    }
    const parts = selected.kind === 'skill' ? this.renderSkill(selected) : this.renderMcp(selected)
    detail.append(parts.head, parts.body, parts.actions)
    this.openDetail(selected.kind === 'skill' ? selected.name : selected.displayName)
    const operationId = this.#activeOperation
    if (operationId) {
      const current = this.#operations.get(operationId)
      const progress = current?.progress === undefined ? '正在等待后台…' : `正在执行 ${current.progress}%`
      const progressRow = document.createElement('div')
      progressRow.className = 'resource-operation'
      const cancel = button('取消操作', async () => {
        if (await confirmEffect(`取消正在执行的资源操作 ${operationId}`))
          await this.track(await this.api().cancel(operationId))
      })
      cancel.disabled = !this.writable() || current?.kind === '_agnes/v1/skills.remove'
      if (current?.kind === '_agnes/v1/skills.remove') cancel.title = '永久删除开始后不能取消'
      progressRow.append(text('span', progress), cancel)
      // 进度进滚动区，操作按钮永远留在吸底的动作区。
      parts.body.append(progressRow)
    }
  }

  /**
   * 来源扫描状态：默认只占一行摘要，展开才看每个来源。
   * 文案面向用户，不暴露实现视角的措辞（"没有可保留的目录"之类）。
   */
  #renderRoots(): HTMLElement {
    const counts = { ready: 0, empty: 0, failed: 0 }
    for (const root of this.#skillRoots) {
      if (root.state === 'ready') counts.ready += 1
      else if (root.state === 'empty') counts.empty += 1
      else counts.failed += 1
    }
    const details = document.createElement('details')
    details.className = 'resource-roots'
    const summary = document.createElement('summary')
    summary.textContent = [
      `技能来源 ${this.#skillRoots.length} 个`,
      `已扫描 ${counts.ready}`,
      `未发现技能 ${counts.empty}`,
      counts.failed ? `失败 ${counts.failed}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    details.append(summary)
    const labels: Record<SkillRootStatus['state'], string> = {
      ready: '已扫描',
      empty: '未发现技能',
      stale: '刷新失败 · 正在使用上次成功的结果',
      unavailable: '刷新失败 · 本次没有可用结果',
    }
    const listNode = document.createElement('ul')
    for (const root of this.#skillRoots) {
      const reason = root.diagnostic ? `（${ROOT_FAILURE_COPY[root.diagnostic.code]}）` : ''
      listNode.append(text('li', `${root.scope} · ${root.rootKey}：${labels[root.state]}${reason}`))
    }
    details.append(listNode)
    return details
  }

  /** 行骨架第一列：标题（单行截断 + title 全文）、说明、次要元信息。三类资源共用。 */
  #renderRowContent(item: Item): HTMLElement {
    const content = document.createElement('div')
    content.className = 'plugin-row-content'
    const title = document.createElement('h2')
    title.textContent = item.kind === 'skill' ? item.name : item.displayName
    title.title = title.textContent
    content.append(title)
    if (item.kind === 'skill') {
      content.append(text('p', item.description ?? '该 Skill 未提供说明。'))
      content.append(
        text(
          'p',
          `${item.sourceIdentity.rootKey} · 优先级 ${item.priority} · ${item.resolution.winner ? '当前 winner' : '非 winner'}`,
          'plugin-source',
        ),
      )
    } else {
      content.append(text('p', `${item.serverId} · ${item.transportKind.toUpperCase()}`))
      const allowed = item.definition.toolPolicy?.allow?.length ?? 0
      content.append(
        text(
          'p',
          `凭据 ${item.secretBindingKind} · ${allowed ? `允许 ${allowed} 个工具` : '未限制工具'}`,
          'plugin-source',
        ),
      )
    }
    return content
  }

  /**
   * 行骨架第二列：三颗红绿灯（信任 / 期望 / 实际）。
   * 此前是两枚文字 chip，长短不一、扫读要逐字读，期望状态还挤不进来。
   */
  #renderRowStates(item: Item): HTMLElement {
    return createStateLights([
      { label: '信任', value: safeStatus(item.trust), tone: trustTone(item.trust) },
      { label: '期望', value: safeStatus(item.desired), tone: desiredTone(item.desired) },
      { label: '实际', value: safeStatus(item.actual), tone: actualTone(item.actual) },
    ])
  }

  /** 行骨架第三列：Switch 拨的是「期望状态」；真实生效结果由本地后台回报。 */
  #renderRowSwitch(item: Item): HTMLElement {
    const enabled = item.desired === 'enabled'
    const name = this.#itemName(item)
    return createSwitch({
      label: enabled ? `请求停用 ${name}` : `请求启用 ${name}`,
      checked: enabled,
      disabled: !this.writable() || this.#activeOperation !== undefined,
      onToggle: (next) => void this.toggleDesired(item, next),
    })
  }

  #itemName(item: Item): string {
    return item.kind === 'skill' ? item.name : item.displayName
  }

  async toggleDesired(item: Item, next: boolean): Promise<void> {
    const kind = item.kind === 'skill' ? 'Skill' : 'MCP'
    const summary = `请求${next ? '启用' : '停用'} ${kind}「${this.#itemName(item)}」\n期望状态：${item.desired} → ${next ? 'enabled' : 'disabled'}\n版本：${item.revision.slice(0, 12)}…`
    if (!(await confirmEffect(summary))) return
    try {
      const receipt =
        item.kind === 'skill'
          ? await this.api().skillDesired(item.resourceId, item.revision, next ? 'enabled' : 'disabled')
          : next
            ? await this.api().mcpEnable(item.serverId, item.revision)
            : await this.api().mcpDisable(item.serverId, item.revision)
      await this.track(receipt)
    } catch (error) {
      showError(error)
      this.render()
    }
  }

  /** 详情头部：标题 + 关闭按钮，随后是说明。三段式的第一段，永远留在可视区。 */
  #detailHead(kindLabel: string, title: string, subtitle: string): HTMLElement {
    const head = document.createElement('div')
    head.className = 'admin-detail-head'
    const row = document.createElement('div')
    row.className = 'plugin-detail-heading'
    row.append(text('h2', title), this.#detailClose(title))
    head.append(text('p', kindLabel, 'eyebrow'), row, text('p', subtitle, 'dialog-intro'))
    return head
  }

  #detailClose(title: string): HTMLButtonElement {
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'secondary-button compact plugin-detail-close'
    close.textContent = '关闭详情'
    close.setAttribute('aria-label', `关闭 ${title} 的详情`)
    close.addEventListener('click', () => this.closeDetail())
    return close
  }

  renderSkill(skill: SkillDescriptor): DetailParts {
    const head = this.#detailHead('Skill 资源', skill.name, skill.description ?? '该 Skill 未提供说明。')
    const body = document.createElement('div')
    body.className = 'admin-detail-scroll'
    const facts = document.createElement('dl')
    facts.className = 'resource-facts'
    const skillFacts: ReadonlyArray<readonly [string, string]> = [
      ['来源', `${skill.sourceIdentity.scope} · ${skill.sourceIdentity.rootKey}`],
      ['优先级', String(skill.priority)],
      ['解析', skill.resolution.winner ? '当前 winner' : '非 winner'],
      ['信任', safeStatus(skill.trust)],
      ['期望状态', safeStatus(skill.desired)],
      ['实际状态', safeStatus(skill.actual)],
      ['版本', skill.revision],
      ['目录状态', skill.stale ? '使用最近一次安全目录（刷新失败）' : '最新目录'],
    ]
    for (const [label, value] of skillFacts) {
      facts.append(text('dt', label), text('dd', value))
    }
    body.append(facts)
    if (skill.resolution.shadowed.length) {
      const shadows = document.createElement('details')
      shadows.className = 'confirm-review-section'
      shadows.append(text('summary', `被遮蔽的候选（${skill.resolution.shadowed.length}）`))
      const values = document.createElement('ul')
      for (const candidate of skill.resolution.shadowed)
        values.append(
          text(
            'li',
            `${candidate.sourceIdentity.scope} · ${candidate.sourceIdentity.rootKey} · ${candidate.reason}`,
          ),
        )
      shadows.append(values)
      body.append(shadows)
    }
    if (skill.lastSafeError)
      body.append(
        text('p', `${skill.lastSafeError.code}：${skill.lastSafeError.message}`, 'resource-safe-error'),
      )
    const actions = document.createElement('div')
    actions.className = 'admin-detail-actions'
    const disabled = !this.writable() || this.#activeOperation !== undefined
    const removing = skill.lastSafeError?.code === 'SKILL_REMOVAL_PENDING'
    const add = (label: string, summary: string, action: () => Promise<{ operationId: string }>) => {
      const control = button(label, async () => {
        if (await confirmEffect(summary)) await this.track(await action())
      })
      control.disabled = disabled || (removing && label !== '永久删除')
      actions.append(control)
    }
    add('信任', `信任 Skill「${skill.name}」\n版本：${skill.revision.slice(0, 12)}…`, () =>
      this.api().skillTrust(skill.resourceId, skill.revision, 'trusted'),
    )
    add('拒绝', `拒绝 Skill「${skill.name}」\n版本：${skill.revision.slice(0, 12)}…`, () =>
      this.api().skillTrust(skill.resourceId, skill.revision, 'rejected'),
    )
    add(
      skill.desired === 'enabled' ? '停用' : '启用',
      `${skill.desired === 'enabled' ? '停用' : '启用'} Skill「${skill.name}」\n期望状态：${skill.desired} → ${skill.desired === 'enabled' ? 'disabled' : 'enabled'}\n版本：${skill.revision.slice(0, 12)}…`,
      () =>
        this.api().skillDesired(
          skill.resourceId,
          skill.revision,
          skill.desired === 'enabled' ? 'disabled' : 'enabled',
        ),
    )
    const managed = skill.sourceIdentity.scope === 'runtime'
    if (!managed && !removing) {
      const label = document.createElement('label')
      label.textContent = '同名覆盖优先级（50–500，越大越优先）'
      const priority = document.createElement('input')
      priority.type = 'number'
      priority.min = '50'
      priority.max = '500'
      priority.step = '1'
      priority.required = true
      priority.value = String(skill.priority)
      priority.disabled = disabled
      label.append(priority)
      body.append(label)
      const save = button('保存优先级', async () => {
        if (!priority.reportValidity()) return
        const next = priority.valueAsNumber
        if (!Number.isInteger(next) || next < 50 || next > 500) return
        if (
          await confirmEffect(
            '调整同名 Skill「' +
              skill.name +
              '」的覆盖优先级：' +
              skill.priority +
              ' → ' +
              next +
              '。不会改变信任或启用状态。',
          )
        )
          await this.track(
            await this.api().skillPriority(skill.resourceId, skill.revision, skill.priority, next),
          )
      })
      save.disabled = disabled
      actions.append(save)
      add('恢复默认优先级', `将「${skill.name}」恢复为来源默认优先级。`, () =>
        this.api().skillPriority(skill.resourceId, skill.revision, skill.priority, null),
      )
    }
    if (skill.sourceIdentity.scope === 'workspace' || skill.sourceIdentity.scope === 'user') {
      add(
        '永久删除',
        '永久删除 Skill「' +
          skill.name +
          '」及目录中的全部文件。不可恢复；同名的其他来源可能接替生效。用户目录中的 Skill 可能也被其他应用使用。',
        () => this.api().skillRemove(skill.resourceId, skill.revision),
      )
    } else body.append(text('p', '此 Skill 由插件提供，请通过插件管理移除，不能单独删除文件。'))
    return { head, body, actions }
  }
  renderMcp(server: McpServerDescriptor): DetailParts {
    const head = this.#detailHead(
      'MCP 服务',
      server.displayName,
      `${server.serverId} · ${server.transportKind.toUpperCase()} · 凭据：${server.secretBindingKind}`,
    )
    const body = document.createElement('div')
    body.className = 'admin-detail-scroll'
    const facts = document.createElement('dl')
    facts.className = 'resource-facts'
    const serverFacts: ReadonlyArray<readonly [string, string]> = [
      ['信任', safeStatus(server.trust)],
      ['期望状态', safeStatus(server.desired)],
      ['实际状态', safeStatus(server.actual)],
      ['来源', server.source],
    ]
    for (const [label, value] of serverFacts) facts.append(text('dt', label), text('dd', value))
    body.append(facts)
    if (server.lastSafeError)
      body.append(
        text('p', `${server.lastSafeError.code}：${server.lastSafeError.message}`, 'resource-safe-error'),
      )
    const actions = document.createElement('div')
    actions.className = 'admin-detail-actions'
    const disabled = !this.writable()
    const add = (label: string, summary: string, action: () => Promise<{ operationId: string }>) => {
      const control = button(label, async () => {
        if (await confirmEffect(summary)) await this.track(await action())
      })
      control.disabled = disabled
      actions.append(control)
    }
    const revision = `版本：${server.revision.slice(0, 12)}…`
    add('测试连接', `测试 MCP「${server.displayName}」\n${revision}\n测试不会启用服务或调用工具。`, () =>
      this.api().mcpTest(server.serverId, server.revision),
    )
    add('信任', `信任 MCP「${server.displayName}」\n${revision}`, () =>
      this.api().mcpTrust(server.serverId, server.revision, 'trusted'),
    )
    add('拒绝', `拒绝 MCP「${server.displayName}」\n${revision}`, () =>
      this.api().mcpTrust(server.serverId, server.revision, 'rejected'),
    )
    add(
      server.desired === 'enabled' ? '停用' : '启用',
      `${server.desired === 'enabled' ? '停用' : '启用'} MCP「${server.displayName}」\n期望状态：${server.desired} → ${server.desired === 'enabled' ? 'disabled' : 'enabled'}\n${revision}`,
      () =>
        server.desired === 'enabled'
          ? this.api().mcpDisable(server.serverId, server.revision)
          : this.api().mcpEnable(server.serverId, server.revision),
    )
    add('重连', `重连 MCP「${server.displayName}」\n${revision}\n失败会保留已生效的旧连接。`, () =>
      this.api().mcpReconnect(server.serverId, server.revision),
    )
    const edit = button('编辑', () => openMcpDialog(server))
    edit.disabled = disabled
    actions.append(edit)
    add(
      '移除',
      `移除 MCP「${server.displayName}」\n${revision}\n后台会阻断仍被使用或尚未安全退役的定义。`,
      () => this.api().mcpRemove(server.serverId, server.revision),
    )
    const status = button('查看连接状态', async () => {
      const value = await this.api().mcpStatus(server.serverId)
      const panel = document.createElement('dl')
      panel.className = 'resource-facts'
      for (const [label, content] of [
        ['连接', safeStatus(value.connectionState)],
        ['工具数', String(value.toolCount)],
        ['观察版本', value.observedRevision ?? '暂无'],
        ['目录版本', value.catalogRevision ?? '暂无'],
        ['更新时间', new Date(value.observedAt).toLocaleString()],
      ] as const)
        panel.append(text('dt', label), text('dd', content))
      if (value.lastSafeError)
        panel.append(
          text('dt', '安全错误'),
          text('dd', `${value.lastSafeError.code}：${value.lastSafeError.message}`),
        )
      status.replaceWith(panel)
    })
    body.append(status)
    const catalog = button('查看工具目录', async () => {
      const result = await this.api().mcpTools(server.serverId)
      const panel = document.createElement('details')
      panel.open = true
      panel.className = 'confirm-review-section'
      panel.append(text('summary', `工具目录（${result.items.length}）`))
      const content = document.createElement('div')
      const append = (page: Awaited<ReturnType<ResourceAdminApi['mcpTools']>>) => {
        for (const tool of page.items)
          content.append(text('p', tool.description ? `${tool.name} — ${tool.description}` : tool.name))
        if (page.nextCursor) {
          const more = button('加载更多工具', async () => {
            const next = await this.api().mcpTools(server.serverId, page.nextCursor)
            more.remove()
            append(next)
          })
          content.append(more)
        }
      }
      append(result)
      panel.append(content)
      body.append(panel)
      catalog.remove()
    })
    body.append(catalog)
    return { head, body, actions }
  }
}

let editing: McpServerDescriptor | undefined
function writeDefinition(definition: McpServerDefinitionInput): void {
  $('mcp-id', 'input').value = definition.serverId
  $('mcp-name', 'input').value = definition.displayName
  mcpTransport.value = definition.transport.kind
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
function openMcpDialog(server?: McpServerDescriptor): void {
  editing = server
  form.reset()
  if (server) writeDefinition(server.definition)
  syncTransport()
  $('mcp-dialog-title', 'h2').textContent = server ? `编辑 ${server.displayName}` : '添加 MCP 服务'
  $('mcp-id', 'input').disabled = !!server
  $('mcp-error', 'p').textContent = ''
  dialog.showModal()
  $('mcp-name', 'input').focus()
}
function syncTransport(): void {
  const stdio = mcpTransport.value === 'stdio'
  $('mcp-executable-row', 'label').hidden = !stdio
  $('mcp-args-row', 'label').hidden = !stdio
  $('mcp-url-row', 'label').hidden = stdio
  const allowed = stdio ? ['none', 'stdio-env'] : ['none', 'http-bearer', 'http-header']
  for (const option of mcpSecretKind.options) option.hidden = !allowed.includes(option.value)
  if (!allowed.includes(mcpSecretKind.value)) mcpSecretKind.value = 'none'
  $('mcp-secret-row', 'label').hidden = mcpSecretKind.value === 'none'
  $('mcp-header-row', 'label').hidden = mcpSecretKind.value !== 'http-header'
  $('mcp-secret', 'textarea').placeholder =
    mcpSecretKind.value === 'stdio-env'
      ? 'TOKEN=secret://namespace/name（每行一个）'
      : 'secret://namespace/name'
  for (const picker of mcpPickers) picker.sync()
  syncMcpFieldFeedback()
}

const MCP_FIELD_CONTROLS: ReadonlyArray<readonly [McpFormFieldId, 'input' | 'textarea']> = [
  ['mcp-id', 'input'],
  ['mcp-executable', 'input'],
  ['mcp-args', 'textarea'],
  ['mcp-url', 'input'],
  ['mcp-secret', 'textarea'],
  ['mcp-tools', 'textarea'],
]
function mcpFormSnapshot(): McpFormFieldSnapshot {
  return {
    transport: mcpTransport.value,
    secretKind: mcpSecretKind.value,
    serverId: $('mcp-id', 'input').value.trim(),
    executable: $('mcp-executable', 'input').value.trim(),
    argsText: $('mcp-args', 'textarea').value,
    url: $('mcp-url', 'input').value.trim(),
    secretText: $('mcp-secret', 'textarea').value.trim(),
    toolsText: $('mcp-tools', 'textarea').value,
  }
}
/**
 * 即时字段校验：正则与上限直接来自后台 schema（mcp-form-validation.ts），在输入阶段就把
 * 「工具名不合法」这类问题按字段标红提示，而不是等提交后收到笼统的 400「资源管理参数无效」。
 * 输入过程（requireFilled=false）只看非空值，不在用户还没填到时催促；提交前（true）把
 * 「必填但为空」也标出来。
 */
function syncMcpFieldFeedback(requireFilled = false): ReturnType<typeof mcpFormIssues> {
  const issues = mcpFormIssues(mcpFormSnapshot(), { requireFilled })
  for (const [id, tag] of MCP_FIELD_CONTROLS) $(id, tag).removeAttribute('aria-invalid')
  for (const issue of issues) {
    const control = MCP_FIELD_CONTROLS.find(([fieldId]) => fieldId === issue.field)
    if (control) $(control[0], control[1]).setAttribute('aria-invalid', 'true')
  }
  $('mcp-error', 'p').textContent = issues[0]?.message ?? ''
  return issues
}
function definitionFromForm(): McpServerDefinitionInput {
  const serverId = $('mcp-id', 'input').value.trim()
  const displayName = $('mcp-name', 'input').value.trim()
  const args = $('mcp-args', 'textarea')
    .value.split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  const allow = $('mcp-tools', 'textarea')
    .value.split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  const secretKind = mcpSecretKind.value
  const secret = $('mcp-secret', 'textarea').value.trim()
  if (!serverId || !displayName) throw new Error('请填写服务 ID 和显示名称。')
  if (mcpTransport.value === 'stdio') {
    const executable = $('mcp-executable', 'input').value.trim()
    if (!executable) throw new Error('请填写受允许的可执行文件。')
    const secretBinding =
      secretKind === 'none'
        ? { kind: 'none' as const }
        : (() => {
            const env: Record<string, string> = {}
            for (const line of secret
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean)) {
              const at = line.indexOf('=')
              const name = line.slice(0, at)
              const reference = line.slice(at + 1)
              if (at < 1 || !reference || Object.hasOwn(env, name))
                throw new Error('环境变量格式为 TOKEN=secret://namespace/name，每项只能出现一次。')
              env[name] = reference
            }
            if (!Object.keys(env).length) throw new Error('请填写至少一个环境变量 SecretRef。')
            return { kind: 'stdio-env' as const, env }
          })()
    return {
      serverId,
      displayName,
      transport: { kind: 'stdio', executable, args },
      secretBinding,
      ...(allow.length ? { toolPolicy: { allow } } : {}),
    }
  }
  const url = $('mcp-url', 'input').value.trim()
  if (!url) throw new Error('请填写 HTTPS 地址，或获本地策略允许的 loopback HTTP 地址。')
  if (secretKind !== 'none' && !secret) throw new Error('请填写已有的 SecretRef。')
  const secretBinding =
    secretKind === 'none'
      ? { kind: 'none' as const }
      : secretKind === 'http-bearer'
        ? { kind: 'http-bearer' as const, credentialRef: secret }
        : {
            kind: 'http-header' as const,
            headerName: $('mcp-header-name', 'select').value as 'x-api-key' | 'x-api-token',
            credentialRef: secret,
          }
  if (mcpTransport.value === 'http') {
    return {
      serverId,
      displayName,
      transport: { kind: 'http', url },
      secretBinding,
      ...(allow.length ? { toolPolicy: { allow } } : {}),
    }
  }
  if (mcpTransport.value === 'sse') {
    return {
      serverId,
      displayName,
      transport: { kind: 'sse', url },
      secretBinding,
      ...(allow.length ? { toolPolicy: { allow } } : {}),
    }
  }
  // The <select id="mcp-transport"> option set lives in packages/web/public/resources.html, a
  // different package than this dispatch -- nothing guarantees they stay in sync. Fail loudly on an
  // unrecognized value instead of silently falling through to an SSE-shaped definition.
  throw new Error(`未识别的传输方式：${mcpTransport.value}，请刷新页面后重试。`)
}

export type ResourceAdminMount = Readonly<{
  ready: Promise<void>
  reload(): Promise<void>
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
  list = $('resource-list', 'section')
  detail = $('resource-detail', 'dialog')
  notice = $('resource-notice', 'p')
  dialog = $('mcp-dialog', 'dialog')
  form = $('mcp-form', 'form')
  mcpTransport = $('mcp-transport', 'select')
  mcpSecretKind = $('mcp-secret-kind', 'select')
  for (const picker of mcpPickers) picker.destroy()
  mcpPickers = [
    createSelectPicker(mcpTransport, { label: '传输' }),
    createSelectPicker(mcpSecretKind, { label: '凭据方式' }),
    createSelectPicker($('mcp-header-name', 'select'), { label: 'HTTP Header' }),
  ]
  const page = new ResourceAdminPage(options.workspaceId, options.tab)

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
        if (
          await confirmEffect(
            '刷新 Skill 目录\n后台将重新扫描受控根目录，并保留最近一次安全目录直到新结果通过校验。',
          )
        )
          await page.track(await page.api().refresh())
      })().catch(showError),
  )
  $('mcp-create', 'button').addEventListener('click', () => openMcpDialog())
  $('mcp-cancel', 'button').addEventListener('click', () => dialog.close())
  mcpTransport.addEventListener('change', syncTransport)
  mcpSecretKind.addEventListener('change', syncTransport)
  // input/change 都在 form 上冒泡：文本框逐字触发 input，select 触发 change。
  // 必须包一层箭头函数——addEventListener 会把 Event 对象当第一个参数传进去。
  form.addEventListener('input', () => syncMcpFieldFeedback())
  form.addEventListener('change', () => syncMcpFieldFeedback())
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const error = $('mcp-error', 'p')
    error.textContent = ''
    void (async () => {
      if (syncMcpFieldFeedback(true).length) return
      const definition = definitionFromForm()
      const creating = !editing
      const summary = editing
        ? `更新 MCP「${editing.displayName}」\n版本：${editing.revision.slice(0, 12)}…\n更新会让现有信任重新接受审核。`
        : `创建 MCP「${definition.displayName}」\n它将以未信任、停用状态保存，需测试并明确启用。`
      if (!(await confirmEffect(summary))) return
      const receipt = editing
        ? await page.api().mcpUpdate(editing.serverId, editing.revision, definition)
        : await page.api().mcpCreate(definition)
      dialog.close()
      editing = undefined
      await page.track(receipt)
      // track() already reported success generically; a new server additionally needs trust and
      // enable before it can be used, so spell out the concrete next step in the same notice.
      if (creating && notice.dataset.kind === 'success')
        notice.textContent = `MCP「${definition.displayName}」已创建，但尚未可用：请在详情中依次点击「信任」和「启用」后才能使用。`
    })().catch((cause) => {
      if (dialog.open) error.textContent = errorOf(cause).message
      else showError(cause)
    })
  })
  syncTransport()
  stopMcpRefresh?.()
  stopMcpRefresh = watchMcpPanel({
    root: list,
    visible: () =>
      !list.closest('[hidden]') &&
      document.getElementById('mcp-tab')?.getAttribute('aria-selected') === 'true',
    refresh: () => page.refreshMcpIfChanged(),
  })
  const ready = page.start()
  return {
    ready,
    reload: () => page.reload(),
    setWorkspace: (id) => page.setWorkspace(id),
    setTab: (tab) => page.setTab(tab),
    sync: (scope, options) => page.sync(scope, options),
  }
}
