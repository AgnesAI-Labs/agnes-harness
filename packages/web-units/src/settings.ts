import { createElement, forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react'

export type SettingsPane = 'model' | 'plugin' | 'resources' | 'archived' | 'computer-use' | 'appearance'
export type SettingsResourceTab = 'skills' | 'mcp'
export type SettingsPaneChange = { pane: SettingsPane; tab?: SettingsResourceTab }

export interface SettingsRegionOptions {
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
}

export interface SettingsRegionHandle {
  open(pane: SettingsPane): void
  pane(pane: SettingsPane): HTMLElement | null
  form(): HTMLFormElement | null
}

const SETTINGS_MARKUP = `<form id="config-form">
<aside class="settings-rail" aria-label="设置分类"><div class="settings-rail-heading"><div><p class="eyebrow">Agnes Workbench</p><p class="settings-rail-title">设置</p></div><button id="config-close" class="icon-button" type="button" aria-label="关闭设置"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div><div class="settings-nav-group"><p class="settings-nav-label">基础设置</p>
<button id="model-settings" class="settings-nav-item active" type="button" aria-current="page"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M7 12h10M7 16h6" /><rect x="3.5" y="4" width="17" height="16" rx="3" /></svg><span>模型与账户</span></button>
<button id="plugin-management" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v4M16 3v4M5 7h14v4a7 7 0 0 1-14 0V7ZM9 18v3M15 18v3" /></svg><span>插件管理</span></button>
<div class="settings-nav-tabs" role="tablist" aria-orientation="vertical" aria-label="资源类型"><button id="skills-tab" class="settings-nav-item" type="button" role="tab" aria-selected="true" aria-controls="resource-list"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2Z" /></svg><span>技能</span></button><button id="mcp-tab" class="settings-nav-item" type="button" role="tab" aria-selected="false" aria-controls="resource-list" tabindex="-1"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v4h4v6h-4v8H9v-8H5V7h4Z" /></svg><span>MCP</span></button></div>
<button id="archived-settings" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16M6 7.5v11h12v-11M9 11h6M4 7.5l1.5-3h13l1.5 3" /></svg><span>已归档会话</span></button><button id="computer-use-management" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg><span>Computer Use</span></button><button id="appearance-settings" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" /></svg><span>通用</span></button></div></aside>
<section id="model-settings-pane" class="settings-content" data-agnes-region="settings-pane"><header class="config-heading"><div><p class="eyebrow">连接设置</p><h2 id="config-title">模型账户</h2><p>管理 Provider 连接和默认模型。保存后，新建任务会使用更新后的配置。</p></div></header><div class="config-workspace"><section class="config-accounts-section config-card" aria-label="已保存的模型账户"><div class="config-accounts-heading"><div><h3>我的账户</h3><p>每个账户独立保存地址、密钥和模型。</p></div><button id="config-add-account" class="secondary-button compact" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span>添加账户</span></button></div><div id="config-accounts"></div><p class="config-list-note">会话可在已启用账户提供的模型之间切换。</p></section></div></section>
<section id="plugin-settings-pane" class="settings-content admin-pane" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2>插件</h2><p>安装、启用和检查 Agnes 的本地插件。</p></div></header><div class="admin-pane-body"><section id="recovery-notice" class="recovery-notice" hidden aria-label="恢复模式"><strong>只读恢复模式</strong><p>管理页仍可显示安全状态；恢复完成前，所有检查和变更操作均已停用。</p></section><section id="orphan-pins" class="orphan-pins" hidden aria-label="孤儿运行时 pin"><div class="orphan-pins-heading"><strong>存在未释放的孤儿运行时 pin</strong><button id="orphan-pins-release-all" class="secondary-button compact" type="button">全部释放</button></div><p id="orphan-pins-status" class="orphan-pins-status" hidden></p><ul id="orphan-pins-list" class="orphan-pins-list"></ul></section><p id="admin-notice" class="admin-notice" role="status" aria-live="polite"></p><p id="plugin-tree-status" class="plugin-tree-status" role="status" aria-live="polite"></p><div class="plugin-toolbar"><div class="plugin-tabs" role="tablist" aria-label="插件视图"><button id="installed-tab" type="button" role="tab" aria-selected="true" aria-controls="plugin-list">已安装</button><button id="discover-tab" type="button" role="tab" aria-selected="false" aria-controls="plugin-list">发现</button></div><div class="admin-toolbar-actions"><label class="plugin-search-field" for="plugin-search"><span class="visually-hidden">搜索插件</span><input id="plugin-search" type="search" autocomplete="off" placeholder="筛选当前已安装列表" /></label><button id="install-source" class="primary-button compact" type="button">从来源安装</button></div></div><div id="plugin-layout" class="plugin-layout"><section id="plugin-list" class="plugin-list" role="tabpanel" aria-live="polite"></section></div></div></section>
<section id="resource-settings-pane" class="settings-content admin-pane" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2>技能与 MCP</h2><p>查看来源、信任和运行状态；凭据只以 SecretRef 引用保存。</p><p>想添加 MCP？在聊天中说“帮我接入这个 MCP”，并提供服务地址或连接信息。</p></div></header><div class="admin-pane-body"><p id="resource-notice" class="admin-notice" role="status" aria-live="polite"></p><div class="resource-toolbar"><div class="resource-toolbar-actions"><button id="skill-refresh" class="secondary-button compact" type="button">刷新技能目录</button><button id="mcp-create" class="primary-button compact" type="button" hidden>添加 MCP</button></div></div><div id="resource-layout" class="plugin-layout resource-layout"><section id="resource-list" class="plugin-list" aria-live="polite" aria-label="资源目录"></section></div></div></section>
<section id="archived-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden><header class="config-heading archived-heading"><div><h2>已归档会话</h2><p>查看已暂时收起的会话，需要时可以恢复到工作区。</p></div><button id="archived-refresh" class="secondary-button compact" type="button">刷新列表</button></header><div class="archived-pane-body"><div class="archived-toolbar"><label class="archived-search-field" for="archived-search"><span>搜索名称或工作区</span><input id="archived-search" type="search" placeholder="搜索已归档会话" /></label></div><p id="archived-message" class="archived-message" role="alert"></p><div class="archived-list-shell"><p id="archived-empty" class="archived-empty" role="status"></p><ul id="archived-list" class="archived-sessions"></ul></div></div></section>
<section id="computer-use-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2>Computer Use</h2><p>让 Agnes 查看屏幕并操作应用。需要使用支持图片的模型。</p></div><button id="computer-use-refresh" class="secondary-button compact" type="button">刷新状态</button></header><div class="config-workspace"><section class="config-card" aria-labelledby="computer-use-state"><p class="eyebrow">使用状态</p><strong id="computer-use-state" role="status">等待检查</strong><p id="computer-use-summary">正在等待连接本地后台。</p><p id="computer-use-runtime"></p><ul id="computer-use-blockers"></ul></section><section class="config-card" aria-labelledby="computer-use-permission-state"><p class="eyebrow">系统权限</p><strong id="computer-use-permission-state">等待检查</strong><p id="computer-use-permission-summary">驱动就绪后显示当前系统所需的权限。</p><button id="computer-use-permission-grant" class="primary-button compact" type="button" hidden>打开 macOS 授权</button></section><section class="config-card" aria-labelledby="computer-use-doctor-state"><p class="eyebrow">驱动诊断</p><strong id="computer-use-doctor-state">等待检查</strong><p id="computer-use-doctor-summary">检查本机驱动是否正常。</p><button id="computer-use-doctor-run" class="secondary-button compact" type="button">运行诊断</button></section><section class="config-card" aria-labelledby="computer-use-operation-state"><p class="eyebrow">安装与维护</p><strong id="computer-use-operation-state">没有记录</strong><p id="computer-use-operation-summary">首次使用会自动准备驱动；已有安装会先验证并复用。</p><div class="config-actions"><button id="computer-use-install" class="secondary-button compact" type="button">准备驱动</button><button id="computer-use-update" class="secondary-button compact" type="button">更新驱动</button><button id="computer-use-restart" class="secondary-button compact" type="button">重启驱动</button><button id="computer-use-operation-refresh" class="secondary-button compact" type="button">刷新进度</button><button id="computer-use-operation-cancel" class="secondary-button compact" type="button" hidden>取消操作</button></div></section></div></section>
<section id="appearance-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2>通用设置</h2><p>调整界面配色与字号。设置只保存在本机浏览器中。</p></div></header><div class="config-workspace"><section class="config-card appearance-card" aria-label="配色"><fieldset class="appearance-options"><legend>配色</legend><label class="appearance-option"><input type="radio" name="agnes-theme" value="system" /><span class="appearance-option-copy"><span class="appearance-option-name">跟随系统</span><span class="appearance-option-hint">随操作系统的深浅色设置自动切换</span></span></label><label class="appearance-option"><input type="radio" name="agnes-theme" value="light" /><span class="appearance-option-copy"><span class="appearance-option-name">浅色</span><span class="appearance-option-hint">始终使用浅色界面</span></span></label><label class="appearance-option"><input type="radio" name="agnes-theme" value="dark" /><span class="appearance-option-copy"><span class="appearance-option-name">深色</span><span class="appearance-option-hint">始终使用深色界面</span></span></label></fieldset></section><section class="config-card appearance-card" aria-label="皮肤"><fieldset class="appearance-options"><legend>皮肤</legend><div id="skin-option-items"></div></fieldset></section><section class="config-card appearance-card" aria-label="字号"><fieldset class="appearance-options"><legend>字号</legend><label class="appearance-option"><input type="radio" name="agnes-font-scale" value="small" /><span class="appearance-option-copy"><span class="appearance-option-name">小</span><span class="appearance-option-hint">界面整体缩小一档</span></span></label><label class="appearance-option"><input type="radio" name="agnes-font-scale" value="normal" /><span class="appearance-option-copy"><span class="appearance-option-name">标准</span><span class="appearance-option-hint">默认字号</span></span></label><label class="appearance-option"><input type="radio" name="agnes-font-scale" value="large" /><span class="appearance-option-copy"><span class="appearance-option-name">大</span><span class="appearance-option-hint">界面整体放大一档</span></span></label></fieldset></section></div></section></form>
<dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title"><button id="account-dialog-close" class="icon-button account-dialog-close" type="button" aria-label="关闭账户详情"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button><section class="account-dialog-body" aria-labelledby="config-detail-title"><div class="config-detail-heading"><div><p class="eyebrow">账户配置</p><h3 id="config-detail-title">账户详情</h3></div><p id="config-account-context">编辑连接与默认模型</p></div><div class="config-detail-grid"><fieldset class="config-section"><legend>连接信息</legend><label class="form-field">账户名称<input id="config-account-name" maxlength="128" autocomplete="off" placeholder="例如：工作账户、本地模型" /></label><label class="form-field">Provider<select id="config-provider"></select></label><label class="form-field form-field-wide" id="config-auth-method-field">认证方式<select id="config-auth-method"></select></label><label class="form-field form-field-wide">Base URL<input id="config-base-url" autocomplete="url" /></label><label class="form-field form-field-wide">API Key<input id="config-api-key" type="password" autocomplete="new-password" placeholder="输入新密钥或保留当前密钥" aria-describedby="config-key-hint" /></label><p id="config-key-hint" class="field-hint form-field-wide"></p><div id="config-oauth-controls" class="form-field-wide"></div></fieldset><fieldset class="config-section config-validation-section"><legend>验证与默认模型</legend><div class="config-validation-controls"><label class="form-field">默认模型<select id="config-model"></select></label><button id="config-test" class="secondary-button" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg><span>测试连接</span></button></div><p id="config-state" aria-live="polite"></p><button id="config-retry" class="secondary-button compact" type="button" hidden>重试读取配置</button><p id="config-error" role="alert"></p></fieldset></div><div class="config-detail-footer"><p id="config-account-guard">默认账户不可停用或删除；如需调整，请先将其他已启用账户设为默认。</p><button id="config-save" class="primary-button" type="submit" form="config-form" disabled>保存账户</button></div></section></dialog>`

export const PANE_IDS: Record<SettingsPane, string> = {
  model: 'model-settings-pane',
  plugin: 'plugin-settings-pane',
  resources: 'resource-settings-pane',
  archived: 'archived-settings-pane',
  'computer-use': 'computer-use-settings-pane',
  appearance: 'appearance-settings-pane',
}

export const SETTINGS_DSH_SLOT_NAMES = Object.freeze([
  'settings.trigger',
  'settings.header',
  'settings.action',
  'settings.close',
  'settings.onboarding',
  'settings.section',
  'settings.general.item',
  'settings.models.provider-card',
  'settings.models.footer',
  'settings.plugins.tab',
  'settings.plugin.item',
] as const)
export type SettingsDshSlotName = (typeof SETTINGS_DSH_SLOT_NAMES)[number]

export const settingsDshSlotHostId = (name: SettingsDshSlotName): string =>
  `settings-dsh-slot-${name.replaceAll('.', '-')}`
const NAV_IDS: Record<SettingsPane, string[]> = {
  model: ['model-settings'],
  plugin: ['plugin-management'],
  resources: ['skills-tab', 'mcp-tab'],
  archived: ['archived-settings'],
  'computer-use': ['computer-use-management'],
  appearance: ['appearance-settings'],
}

/** Stable mount point left in the settings shell for one independently replaceable pane row. */
export const settingsPaneSlotHostId = (pane: SettingsPane) => `settings-pane-slot-${pane}`

function templateFromSettingsMarkup(): HTMLTemplateElement {
  const template = document.createElement('template')
  template.innerHTML = SETTINGS_MARKUP
  return template
}

function createSettingsDshSlotHost(name: SettingsDshSlotName): HTMLDivElement {
  const host = document.createElement('div')
  host.id = settingsDshSlotHostId(name)
  host.dataset.agnesDshSlot = name
  return host
}

/**
 * The shell owns only the form, rail and pane mount points.  Content is deliberately removed
 * before React mounts so each pane can be registered by its own `web:` row below.
 */
function settingsShellMarkup(): string {
  const template = templateFromSettingsMarkup()
  const form = template.content.querySelector<HTMLFormElement>('#config-form')
  if (!form) throw new Error('settings markup is missing #config-form')
  // This modal is an overlay owned by the settings shell, rather than a child of the replaceable
  // model pane. Keeping it stable means an account edit can finish even while that pane is
  // reconciled or hot-reloaded.
  const accountDialog = template.content.getElementById('account-dialog')
  if (!accountDialog) throw new Error('settings markup is missing #account-dialog')
  const railHeading = form.querySelector('.settings-rail-heading')
  railHeading?.appendChild(createSettingsDshSlotHost('settings.close'))
  const navGroup = form.querySelector('.settings-nav-group')
  if (navGroup) {
    const navLabel = navGroup.querySelector('.settings-nav-label')
    navLabel?.after(
      createSettingsDshSlotHost('settings.trigger'),
      createSettingsDshSlotHost('settings.onboarding'),
      createSettingsDshSlotHost('settings.action'),
    )
  }
  for (const section of form.querySelectorAll('section[data-agnes-region="settings-pane"]')) section.remove()
  const dshShellSlots = document.createElement('div')
  dshShellSlots.id = 'settings-dsh-shell-slots'
  dshShellSlots.append(
    createSettingsDshSlotHost('settings.header'),
    createSettingsDshSlotHost('settings.section'),
  )
  const host = document.createElement('div')
  host.id = 'settings-pane-slots'
  for (const pane of Object.keys(PANE_IDS) as SettingsPane[]) {
    const slot = document.createElement('div')
    slot.id = settingsPaneSlotHostId(pane)
    slot.dataset.agnesSettingsPaneSlot = pane
    host.appendChild(slot)
  }
  // Keep every content-side mount point inside one grid item.  Appending the DSH shell and pane
  // hosts directly to the form makes each wrapper participate in #config-form's two-column grid;
  // the second wrapper then auto-places into a new row and the visible pane collapses under the rail.
  const content = document.createElement('div')
  content.id = 'settings-content-slots'
  content.append(dshShellSlots, host)
  form.appendChild(content)
  return `${form.outerHTML}${accountDialog.outerHTML}`
}

/** Render exactly one pane, rather than cloning the complete settings tree into every web row. */
function settingsPaneMarkup(pane: SettingsPane): string {
  const template = templateFromSettingsMarkup()
  const section = template.content.getElementById(PANE_IDS[pane])
  if (!section) throw new Error(`settings markup is missing ${PANE_IDS[pane]}`)
  if (pane === 'model') {
    const workspace = section.querySelector('.config-workspace')
    const accounts = section.querySelector('.config-accounts-section')
    if (workspace && accounts) {
      workspace.insertBefore(createSettingsDshSlotHost('settings.models.provider-card'), accounts)
      accounts.after(createSettingsDshSlotHost('settings.models.footer'))
    }
  }
  if (pane === 'plugin') {
    section.querySelector('.plugin-tabs')?.appendChild(createSettingsDshSlotHost('settings.plugins.tab'))
    section.querySelector('#plugin-list')?.appendChild(createSettingsDshSlotHost('settings.plugin.item'))
  }
  if (pane === 'appearance') {
    section.querySelector('.config-workspace')?.prepend(createSettingsDshSlotHost('settings.general.item'))
  }
  return section.outerHTML
}

function SettingsBuiltinImpl(
  { options }: { options: SettingsRegionOptions },
  ref: React.ForwardedRef<SettingsRegionHandle>,
) {
  const host = useRef<HTMLDivElement>(null)
  const form = useCallback(() => host.current?.querySelector<HTMLFormElement>('#config-form') ?? null, [])
  const open = useCallback((pane: SettingsPane): void => {
    const root = host.current
    if (!root) return
    for (const id of Object.values(PANE_IDS))
      root.querySelector<HTMLElement>(`#${id}`)?.toggleAttribute('hidden', id !== PANE_IDS[pane])
    for (const [name, ids] of Object.entries(NAV_IDS) as [SettingsPane, string[]][])
      for (const id of ids) {
        const item = root.querySelector<HTMLElement>(`#${id}`)
        if (!item) continue
        const active =
          name === pane && (pane !== 'resources' || item.getAttribute('aria-selected') === 'true')
        item.classList.toggle('active', active)
        if (active) item.setAttribute('aria-current', 'page')
        else item.removeAttribute('aria-current')
      }
    if (pane === 'resources') {
      const list = root.querySelector<HTMLElement>('#resource-list')
      const selected = root.querySelector<HTMLButtonElement>('.settings-nav-tabs [aria-selected="true"]')
      list?.setAttribute('role', 'tabpanel')
      if (selected) list?.setAttribute('aria-labelledby', selected.id)
    }
  }, [])
  useImperativeHandle(
    ref,
    () => ({ open, pane: (pane) => host.current?.querySelector(`#${PANE_IDS[pane]}`) ?? null, form }),
    [form, open],
  )
  useLayoutEffect(() => {
    const root = host.current
    if (!root) return
    open('model')
    const listeners: Array<() => void> = []
    const bind = (id: string, change: SettingsPaneChange) => {
      const button = root.querySelector<HTMLButtonElement>(`#${id}`)
      if (!button) return
      const listener = () => {
        open(change.pane)
        options.onChange?.(change)
      }
      button.addEventListener('click', listener)
      listeners.push(() => button.removeEventListener('click', listener))
      if (change.tab) {
        const onKeydown = (event: KeyboardEvent) => {
          let next: SettingsResourceTab | undefined
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
            next = change.tab === 'skills' ? 'mcp' : 'skills'
          if (event.key === 'Home') next = 'skills'
          if (event.key === 'End') next = 'mcp'
          if (!next) return
          const target = root.querySelector<HTMLButtonElement>(`#${next}-tab`)
          if (!target || target.disabled) return
          event.preventDefault()
          target.focus({ preventScroll: true })
          if (next !== change.tab) target.click()
        }
        button.addEventListener('keydown', onKeydown)
        listeners.push(() => button.removeEventListener('keydown', onKeydown))
      }
    }
    bind('model-settings', { pane: 'model' })
    bind('plugin-management', { pane: 'plugin' })
    bind('skills-tab', { pane: 'resources', tab: 'skills' })
    bind('mcp-tab', { pane: 'resources', tab: 'mcp' })
    bind('archived-settings', { pane: 'archived' })
    bind('computer-use-management', { pane: 'computer-use' })
    bind('appearance-settings', { pane: 'appearance' })
    const close = root.querySelector<HTMLButtonElement>('#config-close')
    if (close) {
      const listener = () => options.onClose?.()
      close.addEventListener('click', listener)
      listeners.push(() => close.removeEventListener('click', listener))
    }
    return () => {
      for (const dispose of listeners) dispose()
    }
  }, [open, options])
  return createElement('div', {
    ref: host,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: this is the fixed in-module template that creates row mount points.
    dangerouslySetInnerHTML: { __html: settingsShellMarkup() },
  })
}

/** Used by DOM-contract tests and non-React fixtures; production mounts the same markup through React. */
export function renderSettingsMarkup(container: HTMLElement): void {
  container.innerHTML = SETTINGS_MARKUP
}

export const SettingsBuiltin = forwardRef(SettingsBuiltinImpl)

/** One independently mounted settings contribution. Its lifetime is owned by the corresponding row. */
export function SettingsPaneBuiltin({ pane }: { pane: SettingsPane }): ReturnType<typeof createElement> {
  return createElement('div', {
    'data-agnes-region-owner': 'builtin',
    'data-agnes-region-unit': `settings-${pane}`,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: this selects a fixed in-module pane template by closed union key.
    dangerouslySetInnerHTML: { __html: settingsPaneMarkup(pane) },
  })
}
