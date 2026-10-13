import { Button, Disclosure, Field, Icon, type IconName, icons, SettingsInput } from '@agnes/web-ui'
import { Fragment, useSyncExternalStore } from 'react'
import { type AdminPaneSnapshot, type AdminPaneStore, adminPaneControl } from './admin-pane-store.js'
import type { SettingsDshSlotName, SettingsNavigationEntry, SettingsPane } from './settings.js'
import { PANE_IDS, settingsDshSlotHostId, settingsPaneSlotHostId } from './settings.js'
import { advancedSettings, settingsGroup, settingsNavigationGroups } from './settings-navigation.js'

export function SettingsDshHost({ name }: { name: SettingsDshSlotName }) {
  return <div id={settingsDshSlotHostId(name)} data-agnes-dsh-slot={name} />
}

const noAdminPanes = () => () => {}
const noAdminPaneSnapshot = () => undefined
/** Load state of the plugin and Skill / MCP panes; hosts without those panes pass no store. */
export function useAdminPanes(store: AdminPaneStore | undefined): AdminPaneSnapshot | undefined {
  return useSyncExternalStore(store?.subscribe ?? noAdminPanes, store?.snapshot ?? noAdminPaneSnapshot)
}
/** Attributes a navigation control takes from the pane it opens. */
function adminControlProps(admin: AdminPaneSnapshot | undefined, id: string) {
  const control = adminPaneControl(admin, id)
  return { disabled: control.disabled, 'aria-busy': control.busy || undefined }
}

type NavigationSnapshot = { entries: readonly SettingsNavigationEntry[]; selected: string }
/** Render bridge for the existing navigation controller; subscribers never own route state. */
export function createSettingsNavigationStore(entries: readonly SettingsNavigationEntry[]) {
  let snapshot: NavigationSnapshot = { entries, selected: 'model' }
  const listeners = new Set<() => void>()
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(next: NavigationSnapshot) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}
export type SettingsNavigationStore = ReturnType<typeof createSettingsNavigationStore>
const navigationIcons: Record<string, IconName> = {
  accounts: 'list',
  agent: 'bot',
  plugins: 'plug',
  tools: 'sliders-horizontal',
  diagnostics: 'activity',
  automation: 'clock',
  security: 'shield-check',
  history: 'history',
  general: 'settings',
}
function NavigationIcon({ name }: { name: string }) {
  return <Icon name={navigationIcons[name] ?? (Object.hasOwn(icons, name) ? (name as IconName) : 'plug')} />
}

function SettingsRegistryNavigation({
  store,
  adminPanes,
  translate,
}: {
  store: SettingsNavigationStore
  adminPanes?: AdminPaneStore | undefined
  translate?: ((key: string) => string) | undefined
}) {
  const { entries } = useSyncExternalStore(store.subscribe, store.snapshot)
  const admin = useAdminPanes(adminPanes)
  const t = translate ?? ((key: string) => key)
  const groups = settingsNavigationGroups(entries)
  const renderGroup = (group: readonly SettingsNavigationEntry[]) => {
    const first = group[0]
    if (!first) return null
    const key = settingsGroup(first.group)
    return (
      <Fragment key={key}>
        {key === 'extensions' && <p className="settings-nav-label">{t('settings-shell.extensions')}</p>}
        {(key === 'extensions' ? group : [first]).map((entry) => {
          const id =
            group.length > 1 && entry.nativePane
              ? `settings-group-${key}`
              : (entry.navigationId ?? `runtime-settings-${entry.id}`)
          return (
            <Button
              key={entry.id}
              appearance="ghost"
              className="settings-nav-item"
              id={id}
              data-settings-section={entry.id}
              data-testid={`settings-nav-${entry.id}`}
              data-settings-group={key}
              {...adminControlProps(admin, id)}
            >
              <NavigationIcon name={entry.icon} />
              <span>{t(key === 'extensions' ? entry.titleKey : entry.groupTitleKey)}</span>
              {key === 'extensions' && <small>{t(entry.groupTitleKey)}</small>}
            </Button>
          )
        })}
      </Fragment>
    )
  }
  return (
    <>
      <Field
        className="settings-navigation-search"
        htmlFor="settings-search"
        label={<span className="visually-hidden">{t('settings-shell.findSettings')}</span>}
      >
        <SettingsInput
          id="settings-search"
          type="search"
          autoComplete="off"
          data-testid="settings-search"
          placeholder={t('settings-shell.findSettings')}
        />
      </Field>
      <nav className="settings-nav-group" aria-label={t('settings-shell.railAria')}>
        <div id="settings-everyday">
          <p className="settings-nav-label">{t('settings-shell.basicLabel')}</p>
          <SettingsDshHost name="settings.trigger" />
          <SettingsDshHost name="settings.onboarding" />
          <SettingsDshHost name="settings.action" />
          {groups.filter((group) => !advancedSettings(group[0]?.group ?? '')).map(renderGroup)}
        </div>
        <Disclosure
          id="settings-advanced"
          data-testid="settings-advanced"
          variant="plain"
          summary={t('settings-shell.advanced')}
        >
          {groups.filter((group) => advancedSettings(group[0]?.group ?? '')).map(renderGroup)}
        </Disclosure>
        <div id="settings-navigation-reserve" hidden>
          {['bundles', 'engines', 'system-prompt', 'memory', 'context', 'providers', 'examples', 'terminal']
            .filter((id) => !entries.some((entry) => entry.id === id))
            .map((id) => (
              <Button
                key={id}
                id={`runtime-settings-${id}`}
                appearance="ghost"
                data-settings-section={id}
                data-testid={`settings-nav-${id}`}
              />
            ))}
          {!entries.some((entry) => entry.id === 'computer-use') && (
            <Button id="computer-use-management" appearance="ghost" data-settings-section="computer-use" />
          )}
        </div>
      </nav>
      <p id="settings-search-empty" className="agnes-settings-state" role="status" hidden>
        {t('settings-shell.noSettings')}
      </p>
    </>
  )
}

function SettingsSectionTabs({
  store,
  adminPanes,
  translate,
}: {
  store: SettingsNavigationStore
  adminPanes?: AdminPaneStore | undefined
  translate?: ((key: string) => string) | undefined
}) {
  const { entries, selected } = useSyncExternalStore(store.subscribe, store.snapshot)
  const admin = useAdminPanes(adminPanes)
  const t = translate ?? ((key: string) => key)
  const selectedEntry = entries.find((entry) => entry.id === selected)
  const groupKey = settingsGroup(selectedEntry?.group ?? '')
  const groups = settingsNavigationGroups(entries).filter(
    (group) => group.length > 1 && settingsGroup(group[0]?.group ?? '') !== 'extensions',
  )
  const activeGroup = groups.find((group) => settingsGroup(group[0]?.group ?? '') === groupKey)
  // Keep native tab buttons at stable positions: resource controllers bind their IDs once.
  return (
    <>
      {/* A group of pages is named once, above its tabs; the pages do not repeat a title. */}
      <h2 id="settings-group-title" className="agnes-settings-group-title" hidden={!activeGroup}>
        {/* The group is named as the navigation names it: by its first page. */}
        {activeGroup?.[0] ? t(activeGroup[0].groupTitleKey) : null}
      </h2>
      <div
        id="settings-section-tabs"
        className="agnes-settings-section-tabs"
        role="tablist"
        hidden={!activeGroup}
        aria-labelledby="settings-group-title"
      >
        {groups.flat().map((entry) => {
          const visible = settingsGroup(entry.group) === groupKey
          const id = entry.nativePane
            ? (entry.navigationId ?? `settings-section-tab-${entry.id}`)
            : `settings-section-tab-${entry.id}`
          return (
            <Button
              key={entry.id}
              appearance="ghost"
              id={id}
              data-settings-section={entry.id}
              data-testid={`settings-nav-${entry.id}-tab`}
              role={visible ? 'tab' : undefined}
              hidden={!visible}
              aria-controls={PANE_IDS[(entry.nativePane ?? 'plugin') as SettingsPane]}
              aria-selected={visible ? entry.id === selected : undefined}
              tabIndex={entry.id === selected ? 0 : -1}
              {...adminControlProps(admin, id)}
            >
              <span>{t(entry.titleKey)}</span>
            </Button>
          )
        })}
      </div>
    </>
  )
}

export function SettingsShell({
  store,
  adminPanes,
  translate,
}: {
  store?: SettingsNavigationStore | undefined
  adminPanes?: AdminPaneStore | undefined
  translate?: ((key: string) => string) | undefined
}) {
  const t = translate ?? ((key: string) => key)
  return (
    <form id="config-form" className="settings-shell" data-settings-view="list">
      {store ? (
        <aside
          data-testid="settings-navigation"
          className="settings-rail"
          aria-label={t('settings-shell.railAria')}
        >
          <div className="settings-rail-heading">
            <div>
              <p className="settings-rail-title">{t('settings-shell.railTitle')}</p>
            </div>
            <Button id="config-close" appearance="ghost" aria-label={t('settings-shell.close')}>
              <Icon name="x" />
            </Button>
            <SettingsDshHost name="settings.close" />
          </div>
          <SettingsRegistryNavigation store={store} adminPanes={adminPanes} translate={translate} />
        </aside>
      ) : (
        <SettingsLegacyRail adminPanes={adminPanes} translate={translate} slots />
      )}
      <div id="settings-content-slots">
        {store && (
          <>
            <Button id="settings-back" appearance="ghost" data-testid="settings-back">
              <span>{t('settings-shell.back')}</span>
            </Button>
            <SettingsSectionTabs store={store} adminPanes={adminPanes} translate={translate} />
          </>
        )}
        <div id="settings-dsh-shell-slots">
          <SettingsDshHost name="settings.header" />
          <SettingsDshHost name="settings.section" />
        </div>
        <div id="settings-pane-slots">
          {(Object.keys(PANE_IDS) as SettingsPane[]).map((pane) => (
            <div key={pane} id={settingsPaneSlotHostId(pane)} data-agnes-settings-pane-slot={pane} />
          ))}
        </div>
      </div>
    </form>
  )
}

export function SettingsLegacyRail({
  adminPanes,
  translate,
  slots = false,
}: {
  adminPanes?: AdminPaneStore | undefined
  translate?: ((key: string) => string) | undefined
  slots?: boolean
}) {
  const admin = useAdminPanes(adminPanes)
  const resourceTab = admin?.resources.tab ?? 'skills'
  const text = (key: string, fallback: string) => {
    const value = translate?.(key) ?? key
    return value === key ? fallback : value
  }
  return (
    <aside
      data-testid="settings-navigation"
      className="settings-rail"
      aria-label={text('settings-shell.railAria', '设置分类')}
    >
      <div className="settings-rail-heading">
        <div>
          <p className="eyebrow">{text('settings-shell.workbenchBrand', 'Agnes Workbench')}</p>
          <p className="settings-rail-title">{text('settings-shell.railTitle', '设置')}</p>
        </div>
        <Button
          id="config-close"
          aria-label={text('settings-shell.close', '关闭设置')}
          htmlType="button"
          appearance="ghost"
        >
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </Button>
        {slots && <SettingsDshHost name="settings.close" />}
      </div>
      <div className="settings-nav-group">
        <p className="settings-nav-label">{text('settings-shell.basicLabel', '基础设置')}</p>
        {slots && (
          <>
            <SettingsDshHost name="settings.trigger" />
            <SettingsDshHost name="settings.onboarding" />
            <SettingsDshHost name="settings.action" />
          </>
        )}
        <Button
          id="model-settings"
          className="settings-nav-item active"
          aria-current="page"
          htmlType="button"
          appearance="ghost"
        >
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 8h10M7 12h10M7 16h6" />
            <rect x="3.5" y="4" width="17" height="16" rx="3" />
          </svg>
          <span>{text('settings-shell.modelNav', '模型与账户')}</span>
        </Button>
        <Button
          id="plugin-management"
          className="settings-nav-item"
          htmlType="button"
          appearance="ghost"
          {...adminControlProps(admin, 'plugin-management')}
        >
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 3v4M16 3v4M5 7h14v4a7 7 0 0 1-14 0V7ZM9 18v3M15 18v3" />
          </svg>
          <span>{text('settings-shell.pluginNav', '插件管理')}</span>
        </Button>
        <div
          className="settings-nav-tabs"
          role="tablist"
          aria-orientation="vertical"
          aria-label={text('settings-shell.resourceTabsAria', '资源类型')}
        >
          <Button
            id="skills-tab"
            className="settings-nav-item"
            role="tab"
            aria-selected={resourceTab === 'skills'}
            aria-controls="resource-list"
            tabIndex={resourceTab === 'skills' ? 0 : -1}
            htmlType="button"
            appearance="ghost"
            {...adminControlProps(admin, 'skills-tab')}
          >
            <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2Z" />
            </svg>
            <span>{text('settings-shell.skillsNav', '技能')}</span>
          </Button>
          <Button
            id="mcp-tab"
            className="settings-nav-item"
            role="tab"
            aria-selected={resourceTab === 'mcp'}
            aria-controls="resource-list"
            tabIndex={resourceTab === 'mcp' ? 0 : -1}
            htmlType="button"
            appearance="ghost"
            {...adminControlProps(admin, 'mcp-tab')}
          >
            <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6v4h4v6h-4v8H9v-8H5V7h4Z" />
            </svg>
            <span>{text('settings-shell.mcpNav', 'MCP')}</span>
          </Button>
        </div>
        <Button id="archived-settings" className="settings-nav-item" htmlType="button" appearance="ghost">
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7.5h16M6 7.5v11h12v-11M9 11h6M4 7.5l1.5-3h13l1.5 3" />
          </svg>
          <span>{text('settings-shell.archivedNav', '已归档会话')}</span>
        </Button>
        <Button
          id="computer-use-management"
          className="settings-nav-item"
          htmlType="button"
          appearance="ghost"
        >
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="4" width="17" height="13" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          <span>{text('settings-shell.computerUseNav', 'Computer Use')}</span>
        </Button>
        <Button id="appearance-settings" className="settings-nav-item" htmlType="button" appearance="ghost">
          <svg className="icon" data-agnes-region="icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 4a8 8 0 0 1 0 16Z" />
          </svg>
          <span>{text('settings-shell.appearanceNav', '通用')}</span>
        </Button>
      </div>
    </aside>
  )
}
