import {
  createSettingsButton,
  createSettingsControl,
  createSettingsIcon,
  materializeSettingsControls,
  mountSettingsSelectOptions,
  SettingsAccountDialog,
  SettingsModelPane,
  Toast,
} from '@agnes/web-ui'
import {
  createElement,
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import {
  advancedSettings,
  matchesSettings,
  revealSettingsAnchor,
  settingsGroup,
  settingsNavigationGroups,
  settingsRoute,
} from './settings-navigation.js'

export type SettingsPane = 'model' | 'plugin' | 'resources' | 'archived' | 'computer-use' | 'appearance'
export type SettingsResourceTab = 'skills' | 'mcp'
export type SettingsPaneChange = { pane: SettingsPane; tab?: SettingsResourceTab }

export type SettingsNavigationEntry = {
  id: string
  group: string
  titleKey: string
  groupTitleKey: string
  icon: string
  order: number
  nativePane?: string
  navigationId?: string
}
export interface SettingsRegionOptions {
  sections?: { entries(): readonly SettingsNavigationEntry[]; subscribe(listener: () => void): () => void }

  /** Host capability probe; a failed probe keeps the diagnostic entry available. */
  computerUseSupported?: () => Promise<boolean>
  onChange?: (change: SettingsPaneChange) => void
  onClose?: () => void
  /** Locale-bound translate for the static shell template; backfilled after mount. */
  translate?: (key: string) => string
}

export interface SettingsRegionHandle {
  open(pane: SettingsPane): void
  pane(pane: SettingsPane): HTMLElement | null
  form(): HTMLFormElement | null
}

const SETTINGS_MARKUP = `<form id="config-form" class="settings-shell" data-settings-view="list">
<aside data-testid="settings-navigation" class="settings-rail" aria-label="设置分类" data-i18n-aria="settings-shell.railAria"><div class="settings-rail-heading"><div><p class="eyebrow" data-i18n="settings-shell.workbenchBrand">Agnes Workbench</p><p class="settings-rail-title" data-i18n="settings-shell.railTitle">设置</p></div><button id="config-close" class="agh-btn agh-btn--ghost agh-btn--md" type="button" aria-label="关闭设置" data-i18n-aria="settings-shell.close"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div><div class="settings-nav-group"><p class="settings-nav-label" data-i18n="settings-shell.basicLabel">基础设置</p>
<button id="model-settings" class="settings-nav-item active" type="button" aria-current="page"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M7 12h10M7 16h6" /><rect x="3.5" y="4" width="17" height="16" rx="3" /></svg><span data-i18n="settings-shell.modelNav">模型与账户</span></button>
<button id="plugin-management" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v4M16 3v4M5 7h14v4a7 7 0 0 1-14 0V7ZM9 18v3M15 18v3" /></svg><span data-i18n="settings-shell.pluginNav">插件管理</span></button>
<div class="settings-nav-tabs" role="tablist" aria-orientation="vertical" aria-label="资源类型" data-i18n-aria="settings-shell.resourceTabsAria"><button id="skills-tab" class="settings-nav-item" type="button" role="tab" aria-selected="true" aria-controls="resource-list"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2Z" /></svg><span data-i18n="settings-shell.skillsNav">技能</span></button><button id="mcp-tab" class="settings-nav-item" type="button" role="tab" aria-selected="false" aria-controls="resource-list" tabindex="-1"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v4h4v6h-4v8H9v-8H5V7h4Z" /></svg><span data-i18n="settings-shell.mcpNav">MCP</span></button></div>
<button id="archived-settings" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16M6 7.5v11h12v-11M9 11h6M4 7.5l1.5-3h13l1.5 3" /></svg><span data-i18n="settings-shell.archivedNav">已归档会话</span></button><button id="computer-use-management" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg><span data-i18n="settings-shell.computerUseNav">Computer Use</span></button><button id="appearance-settings" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" /></svg><span data-i18n="settings-shell.appearanceNav">通用</span></button></div></aside>
<section id="model-settings-pane" class="settings-content agnes-settings-page" data-agnes-region="settings-pane"><header class="config-heading agnes-settings-page-heading"><div><p class="eyebrow" data-i18n="settings-shell.modelKicker">连接设置</p><h2 id="config-title" data-i18n="settings-shell.modelTitle">模型账户</h2><p data-i18n="settings-shell.modelIntro">管理 Provider 连接和默认模型。保存后，新建任务会使用更新后的配置。</p></div></header><div class="config-workspace"><section class="config-accounts-section config-card" aria-label="已保存的模型账户" data-i18n-aria="settings-shell.accountsAria"><div class="config-accounts-heading"><div><h3 data-i18n="settings-shell.accountsTitle">我的账户</h3><p data-i18n="settings-shell.accountsIntro">每个账户独立保存地址、密钥和模型。</p></div><button id="config-add-account" class="agh-btn agh-btn--primary agh-btn--md" type="button" aria-label="添加账户" data-i18n-aria="settings-shell.addAccount"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span data-i18n="settings-shell.addAccount">添加账户</span></button></div><div id="config-accounts"></div><p class="config-list-note" data-i18n="settings-shell.accountsNote">会话可在已启用账户提供的模型之间切换。</p></section></div></section>
<section id="plugin-settings-pane" class="settings-content admin-pane" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2 data-i18n="shell.embedded.heading">插件</h2><p data-i18n="shell.embedded.description">安装、启用和检查 Agnes 的本地插件。</p></div></header><div class="admin-pane-body"><section id="recovery-notice" class="recovery-notice" hidden aria-label="恢复模式" data-i18n-aria="shell.recovery.aria"><strong data-i18n="shell.recovery.title">只读恢复模式</strong><p data-i18n="shell.recovery.description">管理页仍可显示安全状态；恢复完成前，所有检查和变更操作均已停用。</p></section><section id="orphan-pins" class="orphan-pins" hidden aria-label="孤儿运行时 pin" data-i18n-aria="shell.orphan.aria"><div class="orphan-pins-heading"><strong data-i18n="shell.orphan.title">存在未释放的孤儿运行时 pin</strong><button id="orphan-pins-release-all" class="agh-btn agh-btn--secondary agh-btn--sm" type="button" data-i18n="shell.orphan.release-all">全部释放</button></div><p id="orphan-pins-status" class="orphan-pins-status" hidden></p><ul id="orphan-pins-list" class="orphan-pins-list"></ul></section><p id="admin-notice" class="admin-notice" role="status" aria-live="polite"></p><p id="plugin-tree-status" class="plugin-tree-status" role="status" aria-live="polite"></p><div class="plugin-toolbar"><div class="plugin-tabs" role="tablist" aria-label="插件视图" data-i18n-aria="shell.tabs.aria"><button id="installed-tab" type="button" role="tab" aria-selected="true" aria-controls="plugin-list" data-i18n="shell.tab.installed">已安装</button><button id="discover-tab" type="button" role="tab" aria-selected="false" aria-controls="plugin-list" data-i18n="shell.tab.discover">发现</button></div><div class="admin-toolbar-actions"><label class="plugin-search-field" for="plugin-search"><span class="visually-hidden" data-i18n="shell.search.aria">搜索插件</span><input id="plugin-search" type="search" autocomplete="off" placeholder="筛选当前已安装列表" / data-i18n-placeholder="search.installed"></label><button id="install-source" class="agh-btn agh-btn--primary agh-btn--sm" type="button" data-i18n="shell.install">从来源安装</button></div></div><div id="plugin-layout" class="plugin-layout"><section id="plugin-list" class="plugin-list" role="tabpanel" aria-live="polite"></section></div></div></section>
<section id="resource-settings-pane" class="settings-content admin-pane agnes-settings-page" data-agnes-region="settings-pane" hidden><header class="config-heading agnes-settings-page-heading"><div><h2 data-i18n="shell.heading">技能与 MCP</h2><p data-i18n="shell.embedded.description">查看来源、信任和运行状态；凭据只以 SecretRef 引用保存。</p><p data-i18n="shell.embedded.add-description">想添加 MCP？在聊天中说“帮我接入这个 MCP”，并提供服务地址或连接信息。</p></div></header><div class="admin-pane-body"><p id="resource-notice" class="admin-notice" role="status" aria-live="polite"></p><div class="resource-toolbar"><div class="resource-toolbar-actions"><button id="skill-refresh" class="agh-btn agh-btn--secondary agh-btn--sm" type="button" data-i18n="button.refresh">刷新技能目录</button><button id="mcp-create" class="agh-btn agh-btn--primary agh-btn--sm" type="button" hidden data-i18n="button.create">添加 MCP</button></div></div><div id="resource-layout" class="plugin-layout resource-layout"><section id="resource-list" class="plugin-list" aria-live="polite" aria-label="资源目录" data-i18n-aria="shell.list.aria"></section></div></div></section>
<section id="archived-settings-pane" class="settings-content agnes-settings-page" data-agnes-region="settings-pane" hidden><header class="config-heading archived-heading agnes-settings-page-heading"><div><h2 data-i18n="settings-shell.archivedTitle">已归档会话</h2><p data-i18n="settings-shell.archivedIntro">查看已暂时收起的会话，需要时可以恢复到工作区。</p></div><button id="archived-refresh" class="agh-btn agh-btn--secondary agh-btn--sm" type="button" data-i18n="settings-shell.refreshList">刷新列表</button></header><div class="archived-pane-body"><div class="archived-toolbar agnes-settings-toolbar"><label class="archived-search-field agnes-ui-field" for="archived-search"><span data-i18n="settings-shell.searchLabel">搜索名称或工作区</span><template data-agnes-control="input" id="archived-search" type="search" data-i18n-placeholder="settings-shell.searchPlaceholder" placeholder="搜索已归档会话" ></template></label></div><p id="archived-message" class="archived-message agnes-settings-state" data-tone="error" role="alert"></p><div class="archived-list-shell"><p id="archived-empty" class="archived-empty agnes-settings-state" data-tone="empty" role="status"></p><ul id="archived-list" class="archived-sessions"></ul></div></div></section>
<section id="computer-use-settings-pane" class="settings-content agnes-settings-page" data-agnes-region="settings-pane" hidden><header class="config-heading agnes-settings-page-heading"><div><h2 data-i18n="settings-shell.computerUseNav">Computer Use</h2><p data-i18n="computerUse.intro">让 Agnes 查看屏幕并操作应用。需要使用支持图片的模型。</p></div><button id="computer-use-refresh" class="agh-btn agh-btn--secondary agh-btn--sm" type="button"><span data-i18n="computerUse.action.refresh">刷新状态</span></button></header><div class="config-workspace"><section class="config-card" aria-labelledby="computer-use-state"><p class="eyebrow" data-i18n="computerUse.status.eyebrow">使用状态</p><strong id="computer-use-state" role="status" data-i18n="settings-shell.computerUseWaiting">等待检查</strong><p id="computer-use-summary" data-i18n="settings-shell.computerUseWaitingSummary">正在等待连接本地后台。</p><p id="computer-use-runtime"></p><ul id="computer-use-blockers"></ul></section><section class="config-card" aria-labelledby="computer-use-permission-state"><p class="eyebrow" data-i18n="computerUse.permissions.eyebrow">系统权限</p><strong id="computer-use-permission-state" data-i18n="settings-shell.computerUseWaiting">等待检查</strong><p id="computer-use-permission-summary" data-i18n="settings-shell.computerUsePermissionsSummary">驱动就绪后显示当前系统所需的权限。</p><button id="computer-use-permission-grant" class="agh-btn agh-btn--primary agh-btn--sm" type="button" hidden><span data-i18n="computerUse.permissions.grant">打开 macOS 授权</span></button></section><section class="config-card" aria-labelledby="computer-use-doctor-state"><p class="eyebrow" data-i18n="computerUse.doctor.eyebrow">驱动诊断</p><strong id="computer-use-doctor-state" data-i18n="settings-shell.computerUseWaiting">等待检查</strong><p id="computer-use-doctor-summary" data-i18n="settings-shell.computerUseDoctorSummary">检查本机驱动是否正常。</p><button id="computer-use-doctor-run" class="agh-btn agh-btn--secondary agh-btn--sm" type="button"><span data-i18n="computerUse.doctor.run">运行诊断</span></button></section><section class="config-card" aria-labelledby="computer-use-operation-state"><p class="eyebrow" data-i18n="computerUse.operation.eyebrow">安装与维护</p><strong id="computer-use-operation-state" data-i18n="settings-shell.computerUseNoRecord">没有记录</strong><p id="computer-use-operation-summary" data-i18n="settings-shell.computerUsePrepareSummary">首次使用会自动准备驱动；已有安装会先验证并复用。</p><div class="config-actions"><button id="computer-use-install" class="agh-btn agh-btn--secondary agh-btn--sm" type="button"><span data-i18n="computerUse.action.install">准备驱动</span></button><button id="computer-use-update" class="agh-btn agh-btn--secondary agh-btn--sm" type="button"><span data-i18n="computerUse.action.update">更新驱动</span></button><button id="computer-use-restart" class="agh-btn agh-btn--secondary agh-btn--sm" type="button"><span data-i18n="computerUse.action.restart">重启驱动</span></button><button id="computer-use-operation-refresh" class="agh-btn agh-btn--secondary agh-btn--sm" type="button"><span data-i18n="computerUse.action.operationRefresh">刷新进度</span></button><button id="computer-use-operation-cancel" class="agh-btn agh-btn--secondary agh-btn--sm" type="button" hidden><span data-i18n="computerUse.action.cancel">取消操作</span></button></div></section></div></section>
<section id="appearance-settings-pane" class="settings-content agnes-settings-page" data-agnes-region="settings-pane" hidden><header class="config-heading agnes-settings-page-heading"><div><h2 data-i18n="settings-shell.appearanceTitle">通用设置</h2><p data-i18n="settings-shell.appearanceIntro">调整界面配色与字号。设置只保存在本机浏览器中。</p></div></header><div class="config-workspace"><section class="config-card appearance-card" aria-label="配色" data-i18n-aria="settings-shell.palette"><fieldset class="appearance-options"><legend data-i18n="settings-shell.palette">配色</legend><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-theme" value="system" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.paletteSystem">跟随系统</span><span class="appearance-option-hint" data-i18n="settings-shell.paletteSystemHint">随操作系统的深浅色设置自动切换</span></span></label><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-theme" value="light" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.paletteLight">浅色</span><span class="appearance-option-hint" data-i18n="settings-shell.paletteLightHint">始终使用浅色界面</span></span></label><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-theme" value="dark" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.paletteDark">深色</span><span class="appearance-option-hint" data-i18n="settings-shell.paletteDarkHint">始终使用深色界面</span></span></label></fieldset></section><section class="config-card appearance-card" aria-label="皮肤" data-i18n-aria="settings-shell.skin"><fieldset class="appearance-options"><legend data-i18n="settings-shell.skin">皮肤</legend><div id="skin-option-items"></div></fieldset></section><section class="config-card appearance-card" aria-label="字号" data-i18n-aria="settings-shell.fontScale"><fieldset class="appearance-options"><legend data-i18n="settings-shell.fontScale">字号</legend><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-font-scale" value="small" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.fontSmall">小</span><span class="appearance-option-hint" data-i18n="settings-shell.fontSmallHint">界面整体缩小一档</span></span></label><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-font-scale" value="normal" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.fontNormal">标准</span><span class="appearance-option-hint" data-i18n="settings-shell.fontNormalHint">默认字号</span></span></label><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-font-scale" value="large" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.fontLarge">大</span><span class="appearance-option-hint" data-i18n="settings-shell.fontLargeHint">界面整体放大一档</span></span></label></fieldset></section><section class="config-card appearance-card" data-i18n-aria="settings.appearance.language" aria-label="语言"><fieldset class="appearance-options"><legend data-i18n="settings.appearance.language">语言</legend><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-locale" value="en" checked ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings.appearance.language.en">English</span><span class="appearance-option-hint" data-i18n="settings.appearance.language.en.hint">使用英文界面</span></span></label><label class="appearance-option"><template data-agnes-control="input" type="radio" name="agnes-locale" value="zh-CN" ></template><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings.appearance.language.zh-CN">简体中文</span><span class="appearance-option-hint" data-i18n="settings.appearance.language.zh-CN.hint">使用简体中文界面</span></span></label></fieldset></section></div></section></form>
<dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title"><button id="account-dialog-close" class="agh-btn agh-btn--ghost agh-btn--md account-dialog-close" type="button" aria-label="关闭账户详情" data-i18n-aria="settings-shell.close"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button><section class="account-dialog-body" aria-labelledby="config-detail-title"><div class="config-detail-heading"><div><h3 id="config-detail-title" data-i18n="settings-shell.accountTitle">账户详情</h3></div><p id="config-account-context" data-i18n="settings-shell.accountContext">编辑连接与默认模型</p></div><div class="config-detail-grid"><fieldset class="config-section account-provider-step"><legend data-i18n="settings-shell.connectionLegend">连接信息</legend><label class="form-field"><span data-i18n="settings-shell.providerLabel">Provider</span><template data-agnes-control="select" id="config-provider"></template></label></fieldset><div id="config-provider-choices"></div><div class="account-connection-step"><fieldset class="config-section"><label class="form-field form-field-wide"><span data-i18n="settings-shell.apiKeyLabel">API Key</span><template data-agnes-control="input" id="config-api-key" type="password" autocomplete="new-password" placeholder="输入新密钥或保留当前密钥" data-i18n-placeholder="settings-shell.keyPlaceholder" aria-describedby="config-key-hint" ></template></label><details class="account-key-help"><summary data-i18n="accounts.keyHelp">在哪里获取密钥？</summary><p data-i18n="accounts.keyHelpText">在提供商的账户控制台创建 API Key，然后粘贴到这里。</p></details><p id="config-key-hint" class="field-hint form-field-wide"></p><div id="config-oauth-controls" class="form-field-wide"></div></fieldset><details id="config-account-advanced"><summary data-i18n="accounts.advanced">高级选项</summary><fieldset class="config-section"><label class="form-field"><span data-i18n="settings-shell.accountNameLabel">账户名称</span><template data-agnes-control="input" id="config-account-name" maxlength="128" autocomplete="off" placeholder="例如：工作账户、本地模型" data-i18n-placeholder="settings-shell.accountNamePlaceholder" ></template></label><label class="form-field form-field-wide" id="config-auth-method-field"><span data-i18n="settings-shell.authMethodLabel">认证方式</span><template data-agnes-control="select" id="config-auth-method"></template></label><label class="form-field form-field-wide"><span data-i18n="settings-shell.baseUrlLabel">Base URL</span><template data-agnes-control="input" id="config-base-url" autocomplete="url" ></template></label></fieldset><fieldset class="config-section config-validation-section"><legend data-i18n="settings-shell.validationLegend">验证与默认模型</legend><div class="config-validation-controls"><label class="form-field"><span data-i18n="settings-shell.defaultModelLabel">默认模型</span><template data-agnes-control="select" id="config-model"></template></label><button id="config-test" class="agh-btn agh-btn--secondary agh-btn--md" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg><span data-i18n="settings-shell.testConnection">测试连接</span></button></div><label class="form-field"><span data-i18n="settings-shell.defaultThinkingLabel">默认思考强度</span><template data-agnes-control="select" id="config-thinking"></template></label><label class="form-field"><span data-i18n="settings-shell.contextBudgetLabel">默认上下文预算（Token）</span><template data-agnes-control="input" id="config-context-window" type="text" maxlength="32" placeholder="自动（模型目录默认值）" data-i18n-placeholder="settings-shell.contextBudgetPlaceholder" aria-describedby="config-model-settings-hint config-error" ></template></label><p id="config-model-settings-hint" class="field-hint" data-i18n="settings-shell.modelSettingsHint">支持 K/M 单位，如 100K 表示 100,000 Token。新会话继承这些默认值；已有会话保留自己的配置。</p></fieldset><div id="config-account-network"></div><p id="config-account-guard" data-i18n="settings-shell.accountGuard">默认账户不可停用或删除；如需调整，请先将其他已启用账户设为默认。</p></details><p id="config-state" aria-live="polite"></p><button id="config-retry" class="agh-btn agh-btn--secondary agh-btn--sm" type="button" hidden data-i18n="settings-shell.retryRead">重试读取配置</button><p id="config-error" role="alert"></p></div></div><div class="config-detail-footer"><div id="config-account-discard" hidden role="alert"><p data-i18n="accounts.discard">放弃未保存的更改？</p><button id="config-account-keep" class="agh-btn agh-btn--secondary agh-btn--md" type="button" data-i18n="accounts.keepEditing">继续编辑</button><button id="config-account-discard-confirm" class="agh-btn agh-btn--danger agh-btn--md" type="button" data-i18n="accounts.discardAction">放弃更改</button></div><div id="config-account-footer-actions" class="agnes-settings-actions"><button id="config-account-back" class="agh-btn agh-btn--ghost agh-btn--md" type="button" data-i18n="accounts.back">上一步</button><button id="config-account-cancel" class="agh-btn agh-btn--secondary agh-btn--md" type="button" data-i18n="accounts.cancel">取消</button><button id="config-save" class="agh-btn agh-btn--primary agh-btn--md" type="submit" form="config-form" disabled data-i18n="settings-shell.saveAccount">保存账户</button></div></div></section></dialog>`

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

function templateFromSettingsMarkup(entries?: readonly SettingsNavigationEntry[]): HTMLTemplateElement {
  const template = document.createElement('template')
  template.innerHTML = SETTINGS_MARKUP
  materializeSettingsControls(template.content)
  const rail = template.content.querySelector<HTMLElement>('.settings-rail')
  if (entries && rail) {
    buildNavigation(rail, entries)
    const tabs = document.createElement('div')
    tabs.id = 'settings-section-tabs'
    tabs.className = 'agnes-settings-section-tabs'
    tabs.setAttribute('role', 'tablist')
    tabs.hidden = true
    template.content.querySelector('#config-form')?.appendChild(tabs)
  }

  return template
}

function buildNavigation(rail: HTMLElement, entries: readonly SettingsNavigationEntry[]): void {
  rail.querySelector('.eyebrow')?.remove()
  const old = rail.querySelector('.settings-nav-group')
  const nav = document.createElement('nav')
  nav.className = 'settings-nav-group'
  nav.dataset.i18nAria = 'settings-shell.railAria'
  const searchLabel = document.createElement('label')
  searchLabel.className = 'settings-navigation-search agnes-ui-field'
  searchLabel.htmlFor = 'settings-search'
  const label = document.createElement('span')
  label.className = 'visually-hidden'
  label.dataset.i18n = 'settings-shell.findSettings'
  const search = createSettingsControl(document, 'input')
  search.id = 'settings-search'
  search.type = 'search'
  search.autocomplete = 'off'
  search.dataset.testid = 'settings-search'
  search.dataset.i18nPlaceholder = 'settings-shell.findSettings'
  searchLabel.append(label, search)
  const everyday = document.createElement('div')
  everyday.id = 'settings-everyday'
  const heading = document.createElement('p')
  heading.className = 'settings-nav-label'
  heading.dataset.i18n = 'settings-shell.basicLabel'
  everyday.append(heading)
  const advanced = document.createElement('details')
  advanced.id = 'settings-advanced'
  advanced.dataset.testid = 'settings-advanced'
  const summary = document.createElement('summary')
  summary.dataset.i18n = 'settings-shell.advanced'
  advanced.append(summary)
  const reserve = document.createElement('div')
  reserve.id = 'settings-navigation-reserve'
  reserve.hidden = true
  for (const group of settingsNavigationGroups(entries)) {
    const first = group[0]
    if (!first) continue
    const key = settingsGroup(first.group)
    const parent = advancedSettings(key) ? advanced : everyday
    const button = createSettingsButton(document, 'ghost')
    button.classList.add('settings-nav-item')
    // Native IDs remain on their real tabs for controller lookups.
    button.id =
      group.length > 1 && first.nativePane
        ? `settings-group-${key}`
        : (first.navigationId ?? `runtime-settings-${first.id}`)
    button.dataset.settingsSection = first.id
    button.dataset.testid = `settings-nav-${first.id}`
    button.dataset.settingsGroup = key
    const title = document.createElement('span')
    title.dataset.i18n = key === 'extensions' ? first.titleKey : first.groupTitleKey
    title.textContent = title.dataset.i18n
    button.append(createSettingsIcon(document, first.icon), title)
    if (key === 'extensions') {
      const caption = document.createElement('p')
      caption.className = 'settings-nav-label'
      caption.dataset.i18n = 'settings-shell.extensions'
      if (!parent.querySelector('[data-i18n="settings-shell.extensions"]')) parent.append(caption)
      // Each unknown plugin section stays reachable, with the author's group label.
      for (const entry of group) {
        const item = entry === first ? button : createSettingsButton(document, 'ghost')
        item.classList.add('settings-nav-item')
        item.dataset.settingsSection = entry.id
        item.dataset.testid = `settings-nav-${entry.id}`
        item.dataset.settingsGroup = key
        if (entry !== first) {
          item.id = entry.navigationId ?? `runtime-settings-${entry.id}`
          const text = document.createElement('span')
          text.dataset.i18n = entry.titleKey
          text.textContent = entry.titleKey
          item.append(createSettingsIcon(document, entry.icon), text)
        }
        const owner = document.createElement('small')
        owner.dataset.i18n = entry.groupTitleKey
        owner.textContent = entry.groupTitleKey
        item.append(owner)
        parent.append(item)
      }
    } else parent.append(button)
    for (const entry of group) {
      if (key === 'extensions') continue
      if (entry === first && (group.length === 1 || !entry.nativePane)) continue
      const item = createSettingsButton(document, 'ghost')
      item.id = entry.navigationId ?? `runtime-settings-${entry.id}`
      item.dataset.settingsSection = entry.id
      item.dataset.testid = `settings-nav-${entry.id}${entry.nativePane ? '-tab' : ''}`
      reserve.append(item)
    }
  }
  for (const id of [
    'bundles',
    'engines',
    'system-prompt',
    'memory',
    'context',
    'providers',
    'examples',
    'terminal',
  ]) {
    const legacy = createSettingsButton(document, 'ghost')
    legacy.id = `runtime-settings-${id}`
    legacy.dataset.settingsSection = id
    legacy.dataset.testid = `settings-nav-${id}`
    reserve.append(legacy)
  }
  if (!entries.some((entry) => entry.id === 'computer-use')) {
    const native = createSettingsButton(document, 'ghost')
    native.id = 'computer-use-management'
    native.dataset.settingsSection = 'computer-use'
    reserve.append(native)
  }
  nav.append(everyday, advanced, reserve)
  const empty = document.createElement('p')
  empty.id = 'settings-search-empty'
  empty.className = 'agnes-settings-state'
  empty.setAttribute('role', 'status')
  empty.dataset.i18n = 'settings-shell.noSettings'
  empty.hidden = true
  old?.replaceWith(searchLabel, nav, empty)
  if (!old) rail.append(searchLabel, nav, empty)
}

function applySettingsLocale(root: ParentNode, translate: (key: string) => string): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.getAttribute('data-i18n')
    if (key) {
      const value = translate(key)
      if (value !== key) node.textContent = value
    }
  }
  for (const [marker, attribute] of [
    ['data-i18n-aria', 'aria-label'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
  ] as const) {
    for (const node of root.querySelectorAll<HTMLElement>(`[${marker}]`)) {
      const key = node.getAttribute(marker)
      if (key) {
        const value = translate(key)
        if (value !== key) node.setAttribute(attribute, value)
      }
    }
  }
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
function settingsShellMarkup(
  translate?: (key: string) => string,
  entries?: readonly SettingsNavigationEntry[],
): string {
  const template = templateFromSettingsMarkup(entries)
  const form = template.content.querySelector<HTMLFormElement>('#config-form')
  if (!form) throw new Error('settings markup is missing #config-form')
  // This modal is an overlay owned by the settings shell, rather than a child of the replaceable
  // model pane. Keeping it stable means an account edit can finish even while that pane is
  // reconciled or hot-reloaded.
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
  if (translate) applySettingsLocale(form, translate)
  return form.outerHTML
}

/** Render exactly one pane, rather than cloning the complete settings tree into every web row. */
function settingsPaneMarkup(pane: SettingsPane, translate?: (key: string) => string): string {
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
  if (translate) applySettingsLocale(section, translate)
  return section.outerHTML
}

function SettingsBuiltinImpl(
  { options }: { options: SettingsRegionOptions },
  ref: React.ForwardedRef<SettingsRegionHandle>,
) {
  const host = useRef<HTMLDivElement>(null)
  const activePane = useRef<SettingsPane>('model')
  const navigateRef = useRef<(id: string, notify?: boolean) => void>()
  const [terminalNotice, setTerminalNotice] = useState<'moved' | 'needs-session' | false>(false)
  const form = useCallback(() => host.current?.querySelector<HTMLFormElement>('#config-form') ?? null, [])
  const open = useCallback(
    (pane: SettingsPane): void => {
      activePane.current = pane
      const shell = form()
      if (shell && !shell.dataset.settingsNavigating) {
        const selected = shell.dataset.settingsSection
        const entry = options.sections?.entries().find((entry) => entry.id === selected)
        if ((entry?.nativePane ?? 'plugin') !== pane || !selected) {
          const first = options.sections?.entries().find((entry) => (entry.nativePane ?? 'plugin') === pane)
          if (first) navigateRef.current?.(first.id, false)
        }
      }
      const root = host.current
      if (!root) return
      for (const id of Object.values(PANE_IDS))
        root.querySelector<HTMLElement>(`#${id}`)?.toggleAttribute('hidden', id !== PANE_IDS[pane])
      for (const [name, ids] of Object.entries(NAV_IDS) as [SettingsPane, string[]][])
        for (const id of ids) {
          const item = root.querySelector<HTMLElement>(`#${id}`)
          if (!item) continue
          const active =
            name === pane &&
            (pane !== 'resources' || item.getAttribute('aria-selected') === 'true') &&
            (pane !== 'plugin' || (root.dataset.runtimePage ?? 'plugins') === 'plugins')
          item.classList.toggle('active', active)
          if (active) item.setAttribute('aria-current', 'page')
          else item.removeAttribute('aria-current')
        }
      for (const item of root.querySelectorAll<HTMLElement>('[data-runtime-page]')) {
        const active =
          pane === 'plugin' && item.dataset.runtimePage === (root.dataset.runtimePage ?? 'plugins')
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
    },
    [form, options.sections],
  )
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
    // The shell owns visibility. A replacement Computer Use row starts hidden, so restore
    // the current navigation choice when that row returns without another navigation click.
    let computerUsePane = root.querySelector('#computer-use-settings-pane')
    const observer = new MutationObserver(() => {
      const next = root.querySelector('#computer-use-settings-pane')
      if (next === computerUsePane) return
      computerUsePane = next
      open(activePane.current)
    })
    observer.observe(root, { childList: true, subtree: true })
    listeners.push(() => observer.disconnect())
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
    if (options.sections) {
      let computerUseSupported = true
      const navigationEntries = () =>
        (options.sections?.entries() ?? []).filter(
          (entry) => entry.id !== 'computer-use' || computerUseSupported,
        )
      const tabs = root.querySelector<HTMLElement>('#settings-section-tabs')
      const content = root.querySelector<HTMLElement>('#settings-content-slots')
      if (tabs && content) content.prepend(tabs)
      const search = root.querySelector<HTMLInputElement>('#settings-search')
      let advanced = root.querySelector<HTMLDetailsElement>('#settings-advanced')
      let searchWasAdvanced = false
      const filter = () => {
        const query = search?.value.trim() ?? ''
        if (query && !root.dataset.settingsSearching) searchWasAdvanced = advanced?.open ?? false
        const wasSearching = !!root.dataset.settingsSearching
        root.dataset.settingsSearching = query ? 'true' : ''
        let count = 0
        const entries = navigationEntries()
        for (const button of root.querySelectorAll<HTMLButtonElement>(
          '.settings-nav-group button[data-settings-group]',
        )) {
          const group = entries.filter((entry) => settingsGroup(entry.group) === button.dataset.settingsGroup)
          const choices =
            button.dataset.settingsGroup === 'extensions'
              ? group.filter((entry) => entry.id === button.dataset.settingsSection)
              : group
          const match = choices.find((entry) =>
            matchesSettings(
              query,
              [entry.titleKey, entry.groupTitleKey, `settings-shell.keywords.${settingsGroup(entry.group)}`]
                .map((key) => options.translate?.(key) ?? key)
                .join(' '),
            ),
          )
          button.hidden = !match
          if (match) count++
        }
        if (advanced) {
          if (query) advanced.open = true
          else if (wasSearching) advanced.open = searchWasAdvanced
          advanced.hidden = ![...advanced.querySelectorAll<HTMLButtonElement>('button')].some(
            (button) => !button.hidden,
          )
        }
        root.querySelector('#settings-search-empty')?.toggleAttribute('hidden', count > 0)
      }
      const navigate = (requested: string, notify = true) => {
        const route = settingsRoute(requested)
        let id = route.id
        const tabFocused = tabs?.contains(document.activeElement)
        const entries = navigationEntries()
        const selected =
          entries.find((entry) => entry.id === id) ??
          (id === 'computer-use' ? entries.find((entry) => entry.id === 'mcp') : undefined)
        if (!selected) return
        id = selected.id
        if (route.terminal) {
          options.onClose?.()
          // Preventing the default acknowledges that the workbench opened the terminal.
          const opened = !root.dispatchEvent(
            new CustomEvent('agnes:settings-terminal', { bubbles: true, cancelable: true }),
          )
          setTerminalNotice(opened ? 'moved' : 'needs-session')
          const url = new URL(location.href)
          url.searchParams.delete('settings')
          history.replaceState(history.state, '', url)
          return
        }
        const pane = (selected.nativePane ?? 'plugin') as SettingsPane
        root.dataset.settingsSection = id
        const shell = form()
        if (shell) {
          shell.dataset.settingsSection = id
          shell.dataset.settingsView = notify ? 'detail' : (shell.dataset.settingsView ?? 'list')
          shell.dataset.settingsNavigating = 'true'
        }
        if (!selected.nativePane) {
          root.dataset.runtimePage = id
          if (shell) shell.dataset.runtimePage = id
        }
        open(pane)
        if (shell) delete shell.dataset.settingsNavigating
        const group = entries.filter((entry) => settingsGroup(entry.group) === settingsGroup(selected.group))
        const panel = root.querySelector(`#${PANE_IDS[pane]}`)
        const pageTabs = group.length > 1 && settingsGroup(selected.group) !== 'extensions'
        panel?.toggleAttribute('role', false)
        if (pageTabs) {
          panel?.setAttribute('role', 'tabpanel')
          panel?.setAttribute(
            'aria-labelledby',
            selected.nativePane
              ? (selected.navigationId ?? `settings-section-tab-${id}`)
              : `settings-section-tab-${id}`,
          )
        } else panel?.removeAttribute('aria-labelledby')
        for (const button of root.querySelectorAll<HTMLElement>(
          '.settings-nav-group button[data-settings-group]',
        )) {
          const active =
            button.dataset.settingsGroup === settingsGroup(selected.group) &&
            (button.dataset.settingsGroup !== 'extensions' || button.dataset.settingsSection === id)
          button.classList.toggle('active', active)
          if (active) button.setAttribute('aria-current', 'page')
          else button.removeAttribute('aria-current')
        }
        if (notify && advancedSettings(selected.group) && advanced) advanced.open = true
        if (tabs) {
          const reserve = root.querySelector('#settings-navigation-reserve')
          for (const tab of [...tabs.children]) {
            const entry = entries.find((entry) => entry.id === (tab as HTMLElement).dataset.settingsSection)
            if (entry?.nativePane) {
              tab.removeAttribute('role')
              tab.removeAttribute('aria-selected')
              reserve?.appendChild(tab)
            }
          }
          tabs.replaceChildren()
          tabs.hidden = !pageTabs
          tabs.dataset.i18nAria = selected.groupTitleKey
          tabs.setAttribute(
            'aria-label',
            options.translate?.(selected.groupTitleKey) ?? selected.groupTitleKey,
          )
          for (const entry of pageTabs ? group : []) {
            const native = entry.nativePane
              ? root.querySelector<HTMLButtonElement>(`#${entry.navigationId}`)
              : null
            const tab = native ?? createSettingsButton(document, 'ghost')
            tab.id = entry.nativePane
              ? (entry.navigationId ?? `settings-section-tab-${entry.id}`)
              : `settings-section-tab-${entry.id}`
            tab.dataset.settingsSection = entry.id
            tab.dataset.testid = `settings-nav-${entry.id}-tab`
            tab.setAttribute('role', 'tab')
            tab.setAttribute('aria-controls', PANE_IDS[(entry.nativePane ?? 'plugin') as SettingsPane])
            tab.setAttribute('aria-selected', String(entry.id === id))
            tab.tabIndex = entry.id === id ? 0 : -1
            tab.dataset.i18n = entry.titleKey
            tab.textContent = options.translate?.(entry.titleKey) ?? entry.titleKey
            tabs.appendChild(tab)
          }
        }
        if (pane === 'resources')
          root
            .querySelector('#resource-list')
            ?.setAttribute('aria-labelledby', selected.navigationId ?? `${id}-tab`)
        if (notify) {
          options.onChange?.({ pane, ...(pane === 'resources' ? { tab: id as SettingsResourceTab } : {}) })
          if (!selected.nativePane)
            root.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: id, bubbles: true }))
          const url = new URL(location.href)
          url.searchParams.set('settings', id)
          url.hash = route.anchor ?? ''
          history.replaceState(history.state, '', url)
        }
        if (route.anchor) requestAnimationFrame(() => revealSettingsAnchor(route.anchor ?? ''))
        if (notify && !tabFocused && window.matchMedia('(max-width: 767px)').matches)
          root.querySelector<HTMLButtonElement>('#settings-back')?.focus({ preventScroll: true })
        if (tabFocused)
          tabs?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
      }
      navigateRef.current = navigate
      const onSearch = () => filter()
      search?.addEventListener('input', onSearch)
      listeners.push(() => search?.removeEventListener('input', onSearch))
      const back = createSettingsButton(document, 'ghost')
      back.id = 'settings-back'
      back.dataset.testid = 'settings-back'
      back.dataset.i18n = 'settings-shell.back'
      back.textContent = options.translate?.('settings-shell.back') ?? 'Settings'
      content?.prepend(back)
      const onBack = () => {
        const shell = form()
        if (shell) shell.dataset.settingsView = 'list'
        root
          .querySelector<HTMLButtonElement>('.settings-nav-group [aria-current="page"]')
          ?.focus({ preventScroll: true })
      }
      back.addEventListener('click', onBack)
      listeners.push(() => {
        back.removeEventListener('click', onBack)
        back.remove()
        navigateRef.current = undefined
      })
      const onClick = (event: Event) => {
        const target = (event.target as Element | null)?.closest<HTMLElement>(
          'button[data-settings-section], a[href]',
        )
        if (target?.dataset.settingsSection) {
          const entry = options.sections
            ?.entries()
            .find((entry) => entry.id === target.dataset.settingsSection)
          navigate(
            entry && search?.value && target.dataset.settingsGroup
              ? (options.sections
                  ?.entries()
                  .find(
                    (item) =>
                      settingsGroup(item.group) === settingsGroup(entry.group) &&
                      matchesSettings(search.value, options.translate?.(item.titleKey) ?? item.titleKey),
                  )?.id ?? entry.id)
              : target.dataset.settingsSection,
          )
          return
        }
        if (!(target instanceof HTMLAnchorElement) || !(event instanceof MouseEvent)) return
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.defaultPrevented ||
          (target.target !== '' && target.target !== '_self')
        )
          return
        const url = new URL(target.href, location.href)
        if (url.origin !== location.origin) return
        const id = url.searchParams.get('settings')
        if (!id) return
        event.preventDefault()
        navigate(id)
        if (url.hash.length <= 1) return
        const next = new URL(location.href)
        next.hash = url.hash
        history.replaceState(history.state, '', next)
        let fragment: string
        try {
          fragment = decodeURIComponent(url.hash.slice(1))
        } catch {
          return
        }
        requestAnimationFrame(() => {
          const section = document.getElementById(fragment)
          section?.scrollIntoView({ block: 'start' })
          section?.focus()
        })
      }
      const onRoute = (event: Event) => {
        const id = String((event as CustomEvent).detail)
        // The embedded hub echoes its canonical page after mounting. Keep the
        // requested subsection through that echo, including before startup routing.
        const url = new URL(location.href)
        const requested = url.searchParams.get('settings') ?? ''
        const linked = settingsRoute(requested)
        const fragment = url.hash.slice(1)
        const anchoredId = fragment.replace(/^settings-subsection-/, '')
        const anchored = settingsRoute(anchoredId)
        navigate(
          linked.id === id && linked.anchor
            ? requested
            : requested === id && anchored.id === id && anchored.anchor === fragment
              ? anchoredId
              : id,
        )
      }
      const onKeys = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement
        const modal = root.closest<HTMLDialogElement>('dialog')
        if (!root.contains(target) && !modal?.open) return
        if (target.closest?.('dialog') && target.closest('dialog') !== modal) return
        if (
          event.key === '/' &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !target.closest('input, textarea, select, [contenteditable=true]')
        ) {
          event.preventDefault()
          if (form() && window.matchMedia('(max-width: 767px)').matches) form()!.dataset.settingsView = 'list'
          search?.focus()
          return
        }
        if (target.getAttribute('role') !== 'tab' || !tabs?.contains(target)) return
        const choices = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const index = choices.indexOf(target as HTMLButtonElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? choices.length - 1
              : ['ArrowRight', 'ArrowDown'].includes(event.key)
                ? (index + 1) % choices.length
                : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                  ? (index - 1 + choices.length) % choices.length
                  : -1
        if (next < 0) return
        event.preventDefault()
        const id = choices[next]?.dataset.settingsSection
        if (id) {
          navigate(id)
          tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
        }
      }
      root.addEventListener('click', onClick)
      root.addEventListener('agnes:settings-route', onRoute)
      document.addEventListener('keydown', onKeys)
      listeners.push(() => {
        root.removeEventListener('click', onClick)
        root.removeEventListener('agnes:settings-route', onRoute)
        document.removeEventListener('keydown', onKeys)
      })
      const syncEntries = () => {
        const rail = root.querySelector<HTMLElement>('.settings-rail')
        if (!rail) return
        const focused = root.querySelector<HTMLButtonElement>('button[data-settings-section]:focus')
        const focusedSection = focused?.dataset.settingsSection
        const tabFocused = focused && tabs?.contains(focused)
        const entries = navigationEntries()
        const query = search?.value ?? ''
        const wasAdvanced = advanced?.open ?? false
        // Reconcile registry contributions without replacing the stable search input or tabs.
        const temp = document.createElement('aside')
        buildNavigation(temp, entries)
        const nextNav = temp.querySelector('.settings-nav-group')
        const oldNav = rail.querySelector('.settings-nav-group')
        // Controllers and DSH outlets bind to these nodes, so registry refreshes retain them.
        for (const entry of options.sections?.entries() ?? []) {
          if (!entry.nativePane || !entry.navigationId) continue
          const native = root.querySelector<HTMLButtonElement>(`#${entry.navigationId}`)
          const replacement = nextNav?.querySelector<HTMLButtonElement>(`#${entry.navigationId}`)
          if (!native || !replacement) continue
          for (const attribute of [...native.attributes]) native.removeAttribute(attribute.name)
          for (const attribute of [...replacement.attributes])
            native.setAttribute(attribute.name, attribute.value)
          native.replaceChildren(...replacement.childNodes)
          replacement.replaceWith(native)
        }
        const outlets = [...(oldNav?.querySelectorAll<HTMLElement>('[data-agnes-dsh-slot]') ?? [])]
        nextNav?.querySelector('.settings-nav-label')?.after(...outlets)
        tabs?.replaceChildren()
        if (nextNav) oldNav?.replaceWith(nextNav)
        const nextAdvanced = rail.querySelector<HTMLDetailsElement>('#settings-advanced')
        if (nextAdvanced) nextAdvanced.open = wasAdvanced
        advanced = nextAdvanced
        if (options.translate) applySettingsLocale(rail, options.translate)
        if (search) search.value = query
        const selected = root.dataset.settingsSection ?? 'model'
        const present = entries.some((entry) => entry.id === selected)
        navigate(present ? selected : (entries[0]?.id ?? 'model'), !present)
        filter()
        if (focused) {
          const target = tabFocused
            ? tabs?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
            : rail.querySelector<HTMLButtonElement>(`button[data-settings-section="${focusedSection}"]`)
          ;(target ?? rail.querySelector<HTMLButtonElement>('[aria-current="page"]'))?.focus({
            preventScroll: true,
          })
        }
      }
      listeners.push(options.sections.subscribe(syncEntries))
      navigate('model', false)
      filter()
      let alive = true
      if (options.computerUseSupported)
        void options
          .computerUseSupported()
          .then((supported) => {
            if (!alive || computerUseSupported === supported) return
            computerUseSupported = supported
            syncEntries()
          })
          .catch(() => undefined)
      listeners.push(() => {
        alive = false
      })
    } else {
      bind('model-settings', { pane: 'model' })
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-runtime-page]')) {
        const listener = () => {
          root.dataset.runtimePage = button.dataset.runtimePage
          const shell = root.querySelector<HTMLElement>('#config-form')
          if (shell) shell.dataset.runtimePage = button.dataset.runtimePage
          open('plugin')
          options.onChange?.({ pane: 'plugin' })
          root.dispatchEvent(
            new CustomEvent('agnes:settings-page', { detail: button.dataset.runtimePage, bubbles: true }),
          )
        }
        button.addEventListener('click', listener)
        listeners.push(() => button.removeEventListener('click', listener))
      }
      bind('skills-tab', { pane: 'resources', tab: 'skills' })
      bind('mcp-tab', { pane: 'resources', tab: 'mcp' })
      bind('archived-settings', { pane: 'archived' })
      bind('computer-use-management', { pane: 'computer-use' })
      bind('appearance-settings', { pane: 'appearance' })
    }
    const close = root.querySelector<HTMLButtonElement>('#config-close')
    if (close) {
      const listener = () => options.onClose?.()
      close.addEventListener('click', listener)
      listeners.push(() => close.removeEventListener('click', listener))
    }
    return () => {
      for (const dispose of listeners) dispose()
    }
  }, [form, open, options])
  return createElement(
    'div',
    { ref: host },
    createElement('div', {
      // biome-ignore lint/security/noDangerouslySetInnerHtml: this is the fixed in-module template that creates row mount points.
      dangerouslySetInnerHTML: {
        __html: settingsShellMarkup(options.translate, options.sections?.entries()),
      },
    }),
    createElement(SettingsAccountDialog, options.translate ? { t: options.translate } : {}),
    createPortal(
      createElement(
        Toast,
        { open: !!terminalNotice, onDismiss: () => setTerminalNotice(false) },
        terminalNotice === 'needs-session'
          ? (options.translate?.('settings-shell.terminalNeedsSession') ??
              'Open a session to use the terminal.')
          : (options.translate?.('settings-shell.terminalMoved') ??
              'The terminal is now in the session workbench.'),
      ),
      document.body,
    ),
  )
}

/** Used by DOM-contract tests and non-React fixtures; production mounts the same markup through React. */
export function renderSettingsMarkup(container: HTMLElement): () => void {
  container.innerHTML = SETTINGS_MARKUP
  materializeSettingsControls(container)
  const dispose: Array<() => void> = []
  for (const id of ['config-provider', 'config-auth-method', 'config-model', 'config-thinking']) {
    const select = container.querySelector<HTMLSelectElement>(`#${id}`)
    if (!select) throw new Error(`missing settings select #${id}`)
    dispose.push(mountSettingsSelectOptions(select))
  }
  return () => {
    for (const unmount of dispose) unmount()
  }
}

export const SettingsBuiltin = forwardRef(SettingsBuiltinImpl)

/** One independently mounted settings contribution. Its lifetime is owned by the corresponding row. */
export function SettingsPaneBuiltin({
  pane,
  computerUse,
  translate,
}: {
  translate?: (key: string) => string
  pane: SettingsPane
  computerUse?: ReactNode
}): ReturnType<typeof createElement> {
  if (pane === 'computer-use' && computerUse)
    return createElement(
      'div',
      {
        'data-agnes-region-owner': 'builtin',
        'data-agnes-region-unit': 'settings-computer-use',
      },
      computerUse,
    )
  if (pane === 'model')
    return createElement(
      'div',
      { 'data-agnes-region-owner': 'builtin', 'data-agnes-region-unit': 'settings-model' },
      createElement(SettingsModelPane, {
        ...(translate ? { t: translate } : {}),
        beforeAccounts: createElement('div', {
          id: settingsDshSlotHostId('settings.models.provider-card'),
          'data-agnes-dsh-slot': 'settings.models.provider-card',
        }),
        afterAccounts: createElement('div', {
          id: settingsDshSlotHostId('settings.models.footer'),
          'data-agnes-dsh-slot': 'settings.models.footer',
        }),
      }),
    )
  return createElement('div', {
    'data-agnes-region-owner': 'builtin',
    'data-agnes-region-unit': `settings-${pane}`,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: this selects a fixed in-module pane template by closed union key.
    dangerouslySetInnerHTML: { __html: settingsPaneMarkup(pane, translate) },
  })
}
