import { FeedbackAdminPanel } from './feedback.js'
import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { type SettingsSection, settingsSections, type UiExtensionContext } from '@agnes/web-client'
import { SettingsCard, SettingsDetails } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { BundlesPanel, SessionDefaultsPanel } from '../admin/plugins/control-panel.js'
import { ChildEnginesPanel } from './child-engines.js'
import { ContextPanel } from './context.js'
import { DiagnosticsPanel } from './diagnostics.js'
import { ExamplesPanel } from './examples.js'
import { HistorySearchPanel } from './history.js'
import { JobsPanel } from './jobs-panel.js'
import { MemoryPanel } from './memory.js'
import {
  GenerationsPanel,
  LocalPluginsPanel,
  PresetsPanel,
  ProvidersPanel,
  PublicationPanel,
  SecurityPanel,
} from './runtime-panels.js'
import { type SchedulesApi, SchedulesPage } from './schedules.js'
import { SearchPanel } from './search.js'
import { SystemPromptPanel } from './system-prompt.js'
import { TriggersPanel } from './triggers.js'

export type RuntimeSettingsContext = {
  api: PluginAdminApi | undefined
  canSave: boolean
  canInstall: boolean
  pluginText(key: string): string
  installed: readonly PackageInstalledDescriptor[]
  generations: PluginGenerationStatus | undefined
  children?: ReactNode
  onRefresh(): Promise<void>
  onReview(item: PackageCatalogDescriptor): void
  navigate(id: string): void
  schedules?: SchedulesApi | undefined
  snapshot: RuntimeAdminSnapshot | undefined
}
// Native account/resource panes retain their public DOM and controller lifetime under this shell.
const NativePaneBridge = () => null
for (const [id, group, pane, navigationId, key, order] of [
  ['model', 'accounts', 'model', 'model-settings', 'modelNav', 0],
  ['skills', 'skills', 'resources', 'skills-tab', 'skillsNav', 30],
  ['mcp', 'mcp', 'resources', 'mcp-tab', 'mcpNav', 40],
  ['archived', 'history', 'archived', 'archived-settings', 'archivedNav', 81],
  ['computer-use', 'computer-use', 'computer-use', 'computer-use-management', 'computerUseNav', 90],
  ['general', 'general', 'appearance', 'appearance-settings', 'appearanceNav', 100],
] as const) {
  if (!settingsSections.get(id))
    settingsSections.register({
      id,
      group,
      nativePane: pane,
      navigationId,
      titleKey: `settings-shell.${key}`,
      groupTitleKey: `settings-shell.${key}`,
      icon: group,
      order,
      component: NativePaneBridge,
    })
}
const definitions: readonly [
  string,
  string,
  number,
  (context: RuntimeSettingsContext, t: UiExtensionContext['t']) => ReactNode,
][] = [
  [
    'agent',
    'models',
    10,
    (c, t) => (
      <>
        <SettingsCard>
          <p>{t('modelsHelp')}</p>
        </SettingsCard>
        <SessionDefaultsPanel api={c.api} canSave={c.canSave} t={c.pluginText} />
      </>
    ),
  ],
  [
    'agent',
    'bundles',
    11,
    (c, t) => (
      <>
        <BundlesPanel api={c.api} canSave={c.canSave} t={c.pluginText} presets={c.snapshot?.presets ?? []} />
        {c.snapshot && <PresetsPanel snapshot={c.snapshot} t={t} />}
      </>
    ),
  ],
  ['history', 'feedback', 82, () => <FeedbackAdminPanel />],
  ['agent', 'memory', 14, (c) => <MemoryPanel canSave={c.canSave} />],
  ['agent', 'system-prompt', 13, (c) => <SystemPromptPanel canSave={c.canSave} />],
  ['agent', 'engines', 12, (c, t) => <ChildEnginesPanel api={c.api} canSave={c.canSave} t={t} />],
  [
    'plugins',
    'plugins',
    20,
    (c, t) => (
      <>
        {c.children}
        <SettingsDetails title={t('diagnostics')} data-testid="plugin-diagnostics">
          <GenerationsPanel
            status={c.generations}
            api={c.api}
            canSave={c.canSave}
            t={t}
            onRefresh={c.onRefresh}
          />
          {c.snapshot && <PublicationPanel snapshot={c.snapshot} t={t} />}
          {c.api && c.snapshot && (
            <LocalPluginsPanel
              api={c.api}
              snapshot={c.snapshot}
              canSave={c.canSave}
              t={t}
              onRefresh={c.onRefresh}
            />
          )}
        </SettingsDetails>
      </>
    ),
  ],
  ['plugins', 'discover', 20.5, (c) => c.children],
  ['plugins', 'providers', 21, (c, t) => c.snapshot && <ProvidersPanel snapshot={c.snapshot} t={t} />],
  [
    'plugins',
    'examples',
    22,
    (c, t) => (
      <ExamplesPanel
        api={c.api}
        canInstall={c.canInstall}
        installed={c.installed}
        t={t}
        onReview={c.onReview}
        onBundles={() => c.navigate('bundles')}
      />
    ),
  ],
  ['tools', 'search', 50, (c, t) => <SearchPanel canSave={c.canSave} t={t} />],
  ['tools', 'context', 51, (c) => <ContextPanel canSave={c.canSave} />],
  ['automation', 'jobs', 60, () => <JobsPanel />],
  ['automation', 'schedules', 61, (c, t) => <SchedulesPage api={c.schedules} t={t} />],
  ['automation', 'triggers', 61.5, (c) => <TriggersPanel canSave={c.canSave} />],
  ['automation', 'terminal', 62, () => <JobsPanel terminal />],
  ['security', 'security', 70, (c, t) => c.snapshot && <SecurityPanel snapshot={c.snapshot} t={t} />],
  ['diagnostics', 'diagnostics', 75, () => <DiagnosticsPanel />],
  ['history', 'history', 80, (_, t) => <HistorySearchPanel t={t} />],
]
for (const [group, id, order, render] of definitions) {
  const entry: SettingsSection = {
    group,
    id,
    order,
    icon: group,
    titleKey:
      id === 'plugins'
        ? 'settings-shell.page.installed'
        : id === 'providers'
          ? 'settings.pluginKinds.title'
          : `settings-shell.page.${id}`,
    groupTitleKey:
      group === 'general'
        ? 'settings-shell.appearanceNav'
        : group === 'diagnostics'
          ? 'settings-shell.page.diagnostics'
          : `settings-shell.group.${group}`,
    navigationId: id === 'plugins' ? 'plugin-management' : `runtime-settings-${id}`,
    component: ({ context }) => render(context.data as RuntimeSettingsContext, context.t),
    runtimeCatalog: ['bundles', 'plugins', 'providers', 'security'].includes(id),
  }
  if (!settingsSections.get(id)) settingsSections.register(entry)
}
