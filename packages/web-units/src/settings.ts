import { mountSettingsSelectOptions, SettingsAccountDialog, SettingsModelPane } from '@agnes/web-ui'
import {
  createElement,
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'

export type SettingsPane = 'model' | 'plugin' | 'resources' | 'archived' | 'computer-use' | 'appearance'
export type SettingsResourceTab = 'skills' | 'mcp'
export type SettingsPaneChange = { pane: SettingsPane; tab?: SettingsResourceTab }

export interface SettingsRegionOptions {
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

const SETTINGS_MARKUP = `<form id="config-form">
<aside class="settings-rail" aria-label="Settings categories" data-i18n-aria="settings-shell.railAria"><div class="settings-rail-heading"><div><p class="eyebrow">Agnes Workbench</p><p class="settings-rail-title" data-i18n="settings-shell.railTitle">Settings</p></div><button id="config-close" class="icon-button" type="button" aria-label="Close settings" data-i18n-aria="settings-shell.close"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div><div class="settings-nav-group"><p class="settings-nav-label" data-i18n="settings-shell.basicLabel">General</p>
<button id="model-settings" class="settings-nav-item active" type="button" aria-current="page"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10M7 12h10M7 16h6" /><rect x="3.5" y="4" width="17" height="16" rx="3" /></svg><span data-i18n="settings-shell.modelNav">Models & accounts</span></button>
<button id="plugin-management" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v4M16 3v4M5 7h14v4a7 7 0 0 1-14 0V7ZM9 18v3M15 18v3" /></svg><span data-i18n="settings-shell.pluginNav">Plugin management</span></button>
<div class="settings-nav-tabs" role="tablist" aria-orientation="vertical" aria-label="Resource types" data-i18n-aria="settings-shell.resourceTabsAria"><button id="skills-tab" class="settings-nav-item" type="button" role="tab" aria-selected="true" aria-controls="resource-list"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2Z" /></svg><span data-i18n="settings-shell.skillsNav">Skills</span></button><button id="mcp-tab" class="settings-nav-item" type="button" role="tab" aria-selected="false" aria-controls="resource-list" tabindex="-1"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v4h4v6h-4v8H9v-8H5V7h4Z" /></svg><span>MCP</span></button></div>
<button id="archived-settings" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h16M6 7.5v11h12v-11M9 11h6M4 7.5l1.5-3h13l1.5 3" /></svg><span data-i18n="settings-shell.archivedNav">Archived sessions</span></button><button id="computer-use-management" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg><span>Computer Use</span></button><button id="appearance-settings" class="settings-nav-item" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" /></svg><span data-i18n="settings-shell.appearanceNav">General</span></button></div></aside>
<section id="model-settings-pane" class="settings-content" data-agnes-region="settings-pane"><header class="config-heading"><div><p class="eyebrow" data-i18n="settings-shell.modelKicker">Connection settings</p><h2 id="config-title" data-i18n="settings-shell.modelTitle">Model accounts</h2><p data-i18n="settings-shell.modelIntro">Manage provider connections and the default model. New tasks use the updated configuration after saving.</p></div></header><div class="config-workspace"><section class="config-accounts-section config-card" aria-label="Saved model accounts" data-i18n-aria="settings-shell.accountsAria"><div class="config-accounts-heading"><div><h3 data-i18n="settings-shell.accountsTitle">My accounts</h3><p data-i18n="settings-shell.accountsIntro">Each account stores its own address, key and model.</p></div><button id="config-add-account" class="secondary-button compact" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span data-i18n="settings-shell.addAccount">Add account</span></button></div><div id="config-accounts"></div><p class="config-list-note" data-i18n="settings-shell.accountsNote">Sessions can switch between models offered by enabled accounts.</p></section></div></section>
<section id="plugin-settings-pane" class="settings-content admin-pane" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2 data-i18n="shell.embedded.heading">Plugins</h2><p data-i18n="shell.embedded.description">Install, enable, and inspect local Agnes plugins.</p></div></header><div class="admin-pane-body"><section id="recovery-notice" class="recovery-notice" hidden data-i18n-aria="shell.recovery.aria" aria-label="Recovery mode"><strong data-i18n="shell.recovery.title">Read-only recovery mode</strong><p data-i18n="shell.recovery.description">The admin page can show security status. Checks and changes are disabled until recovery is complete.</p></section><section id="orphan-pins" class="orphan-pins" hidden data-i18n-aria="shell.orphan.aria" aria-label="Orphan runtime pins"><div class="orphan-pins-heading"><strong data-i18n="shell.orphan.title">Orphan runtime pins need to be released</strong><button id="orphan-pins-release-all" class="secondary-button compact" type="button" data-i18n="shell.orphan.release-all">Release all</button></div><p id="orphan-pins-status" class="orphan-pins-status" hidden></p><ul id="orphan-pins-list" class="orphan-pins-list"></ul></section><p id="admin-notice" class="admin-notice" role="status" aria-live="polite"></p><p id="plugin-tree-status" class="plugin-tree-status" role="status" aria-live="polite"></p><div class="plugin-toolbar"><div class="plugin-tabs" role="tablist" data-i18n-aria="shell.tabs.aria" aria-label="Plugin views"><button id="installed-tab" type="button" role="tab" aria-selected="true" aria-controls="plugin-list" data-i18n="shell.tab.installed">Installed</button><button id="discover-tab" type="button" role="tab" aria-selected="false" aria-controls="plugin-list" data-i18n="shell.tab.discover">Discover</button></div><div class="admin-toolbar-actions"><label class="plugin-search-field" for="plugin-search"><span class="visually-hidden" data-i18n="shell.search.aria">Search plugins</span><input id="plugin-search" type="search" autocomplete="off" data-i18n-placeholder="search.installed" placeholder="Filter installed plugins" /></label><button id="install-source" class="primary-button compact" type="button" data-i18n="shell.install">Install from source</button></div></div><div id="plugin-layout" class="plugin-layout"><section id="plugin-list" class="plugin-list" role="tabpanel" aria-live="polite"></section></div></div></section>
<section id="resource-settings-pane" class="settings-content admin-pane" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2 data-i18n="shell.heading">Skills and MCP</h2><p data-i18n="shell.embedded.description">Review source, trust, and runtime state. Credentials are stored only as SecretRef references.</p><p data-i18n="shell.embedded.add-description">Want to add MCP? In chat, ask Agnes to connect it and provide the service address or connection details.</p></div></header><div class="admin-pane-body"><p id="resource-notice" class="admin-notice" role="status" aria-live="polite"></p><div class="resource-toolbar"><div class="resource-toolbar-actions"><button id="skill-refresh" class="secondary-button compact" type="button" data-i18n="button.refresh">Refresh Skill catalog</button><button id="mcp-create" class="primary-button compact" type="button" hidden data-i18n="button.create">Add MCP service</button></div></div><div id="resource-layout" class="plugin-layout resource-layout"><section id="resource-list" class="plugin-list" aria-live="polite" data-i18n-aria="shell.list.aria" aria-label="Resource catalog"></section></div></div></section>
<section id="archived-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden><header class="config-heading archived-heading"><div><h2 data-i18n="settings-shell.archivedTitle">Archived sessions</h2><p data-i18n="settings-shell.archivedIntro">View sessions parked for later and restore them to the workspace when needed.</p></div><button id="archived-refresh" class="secondary-button compact" type="button" data-i18n="settings-shell.refreshList">Refresh list</button></header><div class="archived-pane-body"><div class="archived-toolbar"><label class="archived-search-field" for="archived-search"><span data-i18n="settings-shell.searchLabel">Search by name or workspace</span><input id="archived-search" type="search" data-i18n-placeholder="settings-shell.searchPlaceholder" placeholder="Search archived sessions" /></label></div><p id="archived-message" class="archived-message" role="alert"></p><div class="archived-list-shell"><p id="archived-empty" class="archived-empty" role="status"></p><ul id="archived-list" class="archived-sessions"></ul></div></div></section>
<section id="computer-use-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2>Computer Use</h2><p data-i18n="computerUse.intro">Let Agnes see the screen and operate apps. This needs a model that accepts images.</p></div><button id="computer-use-refresh" class="secondary-button compact" type="button"><span data-i18n="computerUse.action.refresh">Refresh status</span></button></header><div class="config-workspace"><section class="config-card" aria-labelledby="computer-use-state"><p class="eyebrow" data-i18n="computerUse.status.eyebrow">Status</p><strong id="computer-use-state" role="status">Waiting for a check</strong><p id="computer-use-summary">The pane reads this computer's status when it opens.</p><p id="computer-use-runtime"></p><ul id="computer-use-blockers"></ul></section><section class="config-card" aria-labelledby="computer-use-permission-state"><p class="eyebrow" data-i18n="computerUse.permissions.eyebrow">System permissions</p><strong id="computer-use-permission-state">Waiting for a check</strong><p id="computer-use-permission-summary">Required system permissions appear after the driver is ready.</p><button id="computer-use-permission-grant" class="primary-button compact" type="button" hidden><span data-i18n="computerUse.permissions.grant">Open macOS authorization</span></button></section><section class="config-card" aria-labelledby="computer-use-doctor-state"><p class="eyebrow" data-i18n="computerUse.doctor.eyebrow">Driver diagnostics</p><strong id="computer-use-doctor-state">Waiting for a check</strong><p id="computer-use-doctor-summary">Checks whether the local driver is healthy.</p><button id="computer-use-doctor-run" class="secondary-button compact" type="button"><span data-i18n="computerUse.doctor.run">Run diagnostics</span></button></section><section class="config-card" aria-labelledby="computer-use-operation-state"><p class="eyebrow" data-i18n="computerUse.operation.eyebrow">Install and maintenance</p><strong id="computer-use-operation-state">No record</strong><p id="computer-use-operation-summary">The first use prepares the driver automatically. An existing install is verified and reused.</p><div class="config-actions"><button id="computer-use-install" class="secondary-button compact" type="button"><span data-i18n="computerUse.action.install">Prepare driver</span></button><button id="computer-use-update" class="secondary-button compact" type="button"><span data-i18n="computerUse.action.update">Update driver</span></button><button id="computer-use-restart" class="secondary-button compact" type="button"><span data-i18n="computerUse.action.restart">Restart driver</span></button><button id="computer-use-operation-refresh" class="secondary-button compact" type="button"><span data-i18n="computerUse.action.operationRefresh">Refresh progress</span></button><button id="computer-use-operation-cancel" class="secondary-button compact" type="button" hidden><span data-i18n="computerUse.action.cancel">Cancel operation</span></button></div></section></div></section>
<section id="appearance-settings-pane" class="settings-content" data-agnes-region="settings-pane" hidden><header class="config-heading"><div><h2 data-i18n="settings-shell.appearanceTitle">General</h2><p data-i18n="settings-shell.appearanceIntro">Adjust interface language, palette and font size. Settings stay in this browser.</p></div></header><div class="config-workspace"><section class="config-card appearance-card" data-i18n-aria="settings.appearance.language" aria-label="Language"><fieldset class="appearance-options"><legend data-i18n="settings.appearance.language">Language</legend><label class="appearance-option"><input type="radio" name="agnes-locale" value="en" checked /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings.appearance.language.en">English</span><span class="appearance-option-hint" data-i18n="settings.appearance.language.en.hint">Show the workbench in English</span></span></label><label class="appearance-option"><input type="radio" name="agnes-locale" value="zh-CN" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings.appearance.language.zh-CN">简体中文</span><span class="appearance-option-hint" data-i18n="settings.appearance.language.zh-CN.hint">Show the workbench in Simplified Chinese</span></span></label></fieldset></section><section class="config-card appearance-card" aria-label="Palette" data-i18n-aria="settings-shell.palette"><fieldset class="appearance-options"><legend data-i18n="settings-shell.palette">Palette</legend><label class="appearance-option"><input type="radio" name="agnes-theme" value="system" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.paletteSystem">Follow system</span><span class="appearance-option-hint" data-i18n="settings-shell.paletteSystemHint">Switch with the operating system light/dark setting</span></span></label><label class="appearance-option"><input type="radio" name="agnes-theme" value="light" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.paletteLight">Light</span><span class="appearance-option-hint" data-i18n="settings-shell.paletteLightHint">Always use the light interface</span></span></label><label class="appearance-option"><input type="radio" name="agnes-theme" value="dark" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.paletteDark">Dark</span><span class="appearance-option-hint" data-i18n="settings-shell.paletteDarkHint">Always use the dark interface</span></span></label></fieldset></section><section class="config-card appearance-card" aria-label="Skin" data-i18n-aria="settings-shell.skin"><fieldset class="appearance-options"><legend data-i18n="settings-shell.skin">Skin</legend><div id="skin-option-items"></div></fieldset></section><section class="config-card appearance-card" aria-label="Font size" data-i18n-aria="settings-shell.fontScale"><fieldset class="appearance-options"><legend data-i18n="settings-shell.fontScale">Font size</legend><label class="appearance-option"><input type="radio" name="agnes-font-scale" value="small" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.fontSmall">Small</span><span class="appearance-option-hint" data-i18n="settings-shell.fontSmallHint">Shrink the interface one step</span></span></label><label class="appearance-option"><input type="radio" name="agnes-font-scale" value="normal" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.fontNormal">Standard</span><span class="appearance-option-hint" data-i18n="settings-shell.fontNormalHint">Default font size</span></span></label><label class="appearance-option"><input type="radio" name="agnes-font-scale" value="large" /><span class="appearance-option-copy"><span class="appearance-option-name" data-i18n="settings-shell.fontLarge">Large</span><span class="appearance-option-hint" data-i18n="settings-shell.fontLargeHint">Grow the interface one step</span></span></label></fieldset></section></div></section></form>
<dialog data-agnes-region="dialog" id="account-dialog" aria-labelledby="config-detail-title"><button id="account-dialog-close" class="icon-button account-dialog-close" type="button" aria-label="Close account details" data-i18n-aria="settings-shell.close"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button><section class="account-dialog-body" aria-labelledby="config-detail-title"><div class="config-detail-heading"><div><p class="eyebrow" data-i18n="settings-shell.accountKicker">Account configuration</p><h3 id="config-detail-title" data-i18n="settings-shell.accountTitle">Account details</h3></div><p id="config-account-context" data-i18n="settings-shell.accountContext">Edit the connection and default model</p></div><div class="config-detail-grid"><fieldset class="config-section"><legend data-i18n="settings-shell.connectionLegend">Connection</legend><label class="form-field"><span data-i18n="settings-shell.accountNameLabel">Account name</span><input id="config-account-name" maxlength="128" autocomplete="off" data-i18n-placeholder="settings-shell.accountNamePlaceholder" placeholder="e.g. work account, local model" /></label><label class="form-field"><span data-i18n="settings-shell.providerLabel">Provider</span><select id="config-provider"></select></label><label class="form-field form-field-wide" id="config-auth-method-field"><span data-i18n="settings-shell.authMethodLabel">Auth method</span><select id="config-auth-method"></select></label><label class="form-field form-field-wide"><span data-i18n="settings-shell.baseUrlLabel">Base URL</span><input id="config-base-url" autocomplete="url" /></label><label class="form-field form-field-wide"><span data-i18n="settings-shell.apiKeyLabel">API Key</span><input id="config-api-key" type="password" autocomplete="new-password" data-i18n-placeholder="settings-shell.keyPlaceholder" placeholder="Enter a new key or keep the current one" aria-describedby="config-key-hint" /></label><p id="config-key-hint" class="field-hint form-field-wide"></p><div id="config-oauth-controls" class="form-field-wide"></div></fieldset><fieldset class="config-section config-validation-section"><legend data-i18n="settings-shell.validationLegend">Validation & default model</legend><div class="config-validation-controls"><label class="form-field"><span data-i18n="settings-shell.defaultModelLabel">Default model</span><select id="config-model"></select></label><button id="config-test" class="secondary-button" type="button"><svg class="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg><span data-i18n="settings-shell.testConnection">Test connection</span></button></div><p id="config-state" aria-live="polite"></p><button id="config-retry" class="secondary-button compact" type="button" hidden data-i18n="settings-shell.retryRead">Retry reading the configuration</button><p id="config-error" role="alert"></p></fieldset></div><div class="config-detail-footer"><p id="config-account-guard" data-i18n="settings-shell.accountGuard">The default account cannot be disabled or deleted; set another enabled account as default first.</p><button id="config-save" class="primary-button" type="submit" form="config-form" disabled data-i18n="settings-shell.saveAccount">Save account</button></div></section></dialog>`

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
function settingsShellMarkup(translate?: (key: string) => string): string {
  const template = templateFromSettingsMarkup()
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
  const form = useCallback(() => host.current?.querySelector<HTMLFormElement>('#config-form') ?? null, [])
  const open = useCallback((pane: SettingsPane): void => {
    activePane.current = pane
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
  return createElement(
    'div',
    { ref: host },
    createElement('div', {
      // biome-ignore lint/security/noDangerouslySetInnerHtml: this is the fixed in-module template that creates row mount points.
      dangerouslySetInnerHTML: { __html: settingsShellMarkup(options.translate) },
    }),
    createElement(SettingsAccountDialog, options.translate ? { t: options.translate } : {}),
  )
}

/** Used by DOM-contract tests and non-React fixtures; production mounts the same markup through React. */
export function renderSettingsMarkup(container: HTMLElement): () => void {
  container.innerHTML = SETTINGS_MARKUP
  const dispose: Array<() => void> = []
  for (const id of ['config-provider', 'config-auth-method', 'config-model']) {
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
