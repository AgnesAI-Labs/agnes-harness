import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { CredentialsPage } from '@agnes/resource-control-web/credentials'
import { type SettingsSection, settingsSections, type UiExtensionContext } from '@agnes/web-client'
import { Banner, Button, type IconName, SettingsDetails, SettingsState } from '@agnes/web-ui'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { BundlesPanel, SessionDefaultsPanel } from '../admin/plugins/control-panel.js'
import { AutoReviewPanel } from './auto-review.js'
import { ChildEnginesPanel } from './child-engines.js'
import { ContextPanel } from './context.js'
import { DiagnosticsPanel } from './diagnostics.js'
import { ExamplesPanel } from './examples.js'
import { HistorySearchPanel } from './history.js'
import { JobsPanel } from './jobs-panel.js'
import { MemoryPanel } from './memory.js'
import { PermissionDefaults } from './permission-defaults.js'
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
// Native account/resource panes keep their stable IDs and controller lifetime.
const NativePaneBridge = () => null
for (const [id, group, pane, navigationId, key, order] of [
  ['model', 'accounts', 'model', 'model-settings', 'modelNav', 0],
  ['skills', 'skills', 'resources', 'skills-tab', 'skillsNav', 20],
  ['mcp', 'tools', 'resources', 'mcp-tab', 'toolsNav', 30],
  ['computer-use', 'tools', 'computer-use', 'computer-use-management', 'toolsNav', 32],
  ['archived', 'history', 'archived', 'archived-settings', 'historyNav', 61],
  ['general', 'general', 'appearance', 'appearance-settings', 'appearanceNav', 70],
] as const) {
  if (!settingsSections.get(id))
    settingsSections.register({
      id,
      group,
      nativePane: pane,
      navigationId,
      titleKey:
        id === 'mcp'
          ? 'settings-shell.mcpNav'
          : id === 'computer-use'
            ? 'settings-shell.computerUseNav'
            : id === 'archived'
              ? 'settings-shell.archivedNav'
              : `settings-shell.${key}`,
      groupTitleKey: `settings-shell.${key}`,
      icon: group === 'skills' ? 'sparkles' : group,
      order,
      component: NativePaneBridge,
    })
}

function Subsection({
  id,
  title,
  children,
  defer = false,
  icon,
  description,
  summary,
}: {
  id: string
  title: string
  children: ReactNode
  defer?: boolean
  icon?: IconName
  description?: string
  summary?: string | undefined
}) {
  const [visited, setVisited] = useState(!defer)
  return (
    <SettingsDetails
      id={`settings-subsection-${id}`}
      title={title}
      icon={icon}
      description={description}
      summary={summary}
      data-testid={`settings-subsection-${id}`}
      onOpenChange={(open) => {
        if (open) setVisited(true)
      }}
    >
      {visited && children}
    </SettingsDetails>
  )
}

/** The existing native pin controller keeps ownership of its host and all release actions. */
function RuntimeOccupancy() {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = document.getElementById('orphan-pins')
    const parent = node?.parentNode
    if (!node || !parent || !host.current) return
    const sibling = node.nextSibling
    host.current.appendChild(node)
    return () => {
      parent.insertBefore(node, sibling?.parentNode === parent ? sibling : null)
    }
  }, [])
  return <div ref={host} data-testid="runtime-occupancy" />
}

/** Runtime developer data is loaded on demand; doctor checks stay independent of this catalog. */
function RuntimeDetails({ c, t }: { c: RuntimeSettingsContext; t: UiExtensionContext['t'] }) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<RuntimeAdminSnapshot>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit refresh.
  useEffect(() => {
    let current = true
    if (!open || !c.api) return
    setBusy(true)
    setFailed(false)
    void c.api
      .runtime()
      .then((value) => {
        if (current) setSnapshot(value)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [open, c.api, revision])
  return (
    <SettingsDetails
      id="settings-subsection-providers"
      title={t('runtimeDetails')}
      data-testid="plugin-diagnostics"
      onOpenChange={setOpen}
    >
      <RuntimeOccupancy />
      <Button
        appearance="ghost"
        data-testid="settings-refresh"
        disabled={!c.api || busy}
        aria-busy={busy}
        loading={busy}
        {...(!c.api ? { disabledReason: t('unavailable') } : {})}
        onClick={() => setRevision((value) => value + 1)}
      >
        {t('retry')}
      </Button>
      {busy && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {failed && <Banner tone="error">{t('unavailable')}</Banner>}
      {snapshot && (
        <>
          <Subsection id="provider-types" title={t('providerTypes')}>
            <ProvidersPanel snapshot={snapshot} t={t} />
          </Subsection>
          <GenerationsPanel
            status={c.generations}
            api={c.api}
            canSave={c.canSave}
            t={t}
            onRefresh={c.onRefresh}
          />
          <PublicationPanel snapshot={snapshot} t={t} />
          {c.api && (
            <LocalPluginsPanel
              api={c.api}
              snapshot={snapshot}
              canSave={c.canSave}
              t={t}
              onRefresh={c.onRefresh}
            />
          )}
        </>
      )}
    </SettingsDetails>
  )
}
const definitions: readonly [
  string,
  string,
  number,
  (c: RuntimeSettingsContext, t: UiExtensionContext['t']) => ReactNode,
][] = [
  ['plugins', 'plugins', 10, (c) => c.children],
  [
    'plugins',
    'discover',
    11,
    (c, t) => (
      <>
        <div id="settings-subsection-examples" tabIndex={-1}>
          <ExamplesPanel
            api={c.api}
            canInstall={c.canInstall}
            installed={c.installed}
            t={t}
            onReview={c.onReview}
            onBundles={() => c.navigate('bundles')}
          />
        </div>
        {c.children}
      </>
    ),
  ],
  ['tools', 'credentials', 33, () => <CredentialsPage />],
  ['tools', 'search', 31, (c, t) => <SearchPanel canSave={c.canSave} t={t} />],
  ['automation', 'schedules', 40, (c, t) => <SchedulesPage api={c.schedules} t={t} />],
  ['automation', 'triggers', 41, (c) => <TriggersPanel canSave={c.canSave} />],
  ['automation', 'jobs', 42, () => <JobsPanel />],
  [
    'security',
    'security',
    50,
    (c, t) =>
      c.snapshot && (
        <>
          {/* What a new session may do comes first; review and isolation qualify it. */}
          <PermissionDefaults available={c.snapshot.presets.map((preset) => preset.id)} />
          <AutoReviewPanel canSave={c.canSave} />
          <SecurityPanel snapshot={c.snapshot} t={t} />
        </>
      ),
  ],
  ['history', 'history', 60, (_, t) => <HistorySearchPanel t={t} />],
  [
    'agent',
    'models',
    80,
    (c, t) => {
      // What is in effect, read from the runtime catalog the page already holds.
      const active = (kind: string) => {
        const provider = c.snapshot?.providers.find((entry) => entry.kind === kind && entry.active)
        if (!provider) return undefined
        const name = t(`providerName.${provider.id}`)
        return name === `providerName.${provider.id}` ? provider.id : name
      }
      const engines = c.snapshot?.providers.filter((entry) => entry.kind === 'child-agent').length
      const preset = c.snapshot?.presets.find((entry) => entry.isDefault)?.id
      const presetName =
        preset && t(`choice.${preset}`) !== `choice.${preset}` ? t(`choice.${preset}`) : preset
      return (
        <>
          <Subsection
            defer
            id="models"
            icon="bot"
            title={t('agentExecution')}
            description={t('agentExecutionHelp')}
            summary={active('loop')}
          >
            <p>{t('modelsHelp')}</p>
            <SessionDefaultsPanel api={c.api} canSave={c.canSave} t={c.pluginText} />
          </Subsection>
          <Subsection
            defer
            id="system-prompt"
            icon="file-text"
            title={t('system-prompt')}
            description={t('agentPromptHelp')}
          >
            <SystemPromptPanel canSave={c.canSave} />
          </Subsection>
          <Subsection
            defer
            id="memory"
            icon="history"
            title={t('agentMemory')}
            description={t('agentMemoryHelp')}
            summary={active('memory')}
          >
            <MemoryPanel canSave={c.canSave} />
          </Subsection>
          <Subsection
            defer
            id="context"
            icon="sliders-horizontal"
            title={t('agentContext')}
            description={t('agentContextHelp')}
            summary={active('compaction')}
          >
            <ContextPanel canSave={c.canSave} />
          </Subsection>
          <Subsection
            defer
            id="engines"
            icon="git-branch"
            title={t('agentEngines')}
            description={t('agentEnginesHelp')}
            summary={engines ? t('agentEnginesCount', { count: engines }) : undefined}
          >
            <ChildEnginesPanel api={c.api} canSave={c.canSave} t={t} />
          </Subsection>
          <Subsection
            defer
            id="bundles"
            icon="folder"
            title={t('bundles')}
            description={t('agentBundlesHelp')}
            summary={presetName ? t('agentPresetDefault', { name: presetName }) : undefined}
          >
            <BundlesPanel
              api={c.api}
              canSave={c.canSave}
              t={c.pluginText}
              presets={c.snapshot?.presets ?? []}
            />
            {c.snapshot && <PresetsPanel snapshot={c.snapshot} t={t} />}
          </Subsection>
        </>
      )
    },
  ],
  [
    'diagnostics',
    'diagnostics',
    81,
    (c, t) => (
      <>
        <DiagnosticsPanel />
        <RuntimeDetails c={c} t={t} />
      </>
    ),
  ],
]
for (const [group, id, order, render] of definitions) {
  const entry: SettingsSection = {
    group,
    id,
    order,
    icon: group,
    titleKey: id === 'plugins' ? 'settings-shell.page.installed' : `settings-shell.page.${id}`,
    groupTitleKey: `settings-shell.group.${group}`,
    navigationId: id === 'plugins' ? 'plugin-management' : `runtime-settings-${id}`,
    component: ({ context }) => render(context.data as RuntimeSettingsContext, context.t),
    runtimeCatalog: ['models', 'security'].includes(id),
  }
  if (!settingsSections.get(id)) settingsSections.register(entry)
}
