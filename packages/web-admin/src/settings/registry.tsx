import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { CredentialsPage } from '@agnes/resource-control-web/credentials'
import { type SettingsSection, settingsSections, type UiExtensionContext } from '@agnes/web-client'
import {
  Banner,
  Button,
  type IconName,
  SettingsDetails,
  SettingsPageDescription,
  SettingsState,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { BundlesPanel, SessionDefaultsPanel } from '../admin/plugins/control-panel.js'
import { AutoReviewPanel } from './auto-review.js'
import { ChildEnginesPanel } from './child-engines.js'
import { ContextPanel } from './context.js'
import { DiagnosticsPanel } from './diagnostics.js'
import { ExamplesPanel } from './examples.js'
import { MemoryPanel } from './memory.js'
import { PermissionDefaults } from './permission-defaults.js'
import {
  GenerationsPanel,
  LocalPluginsPanel,
  PresetsPanel,
  ProvidersPanel,
  PublicationPanel,
} from './runtime-panels.js'
import type { SchedulesApi } from './schedules.js'
import { SearchPanel } from './search.js'
import { SecurityStatusPanel } from './security-status.js'
import { SystemPromptPanel } from './system-prompt.js'
import { systemPromptApi } from './system-prompt-api.js'

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
const promptSummaryApi = systemPromptApi()
// Native account/resource panes keep their stable IDs and controller lifetime.
const NativePaneBridge = () => null
for (const [id, group, pane, navigationId, key, order] of [
  // The dialog lists three pages: General, Models & accounts, Permissions & security.
  ['general', 'general', 'appearance', 'appearance-settings', 'appearanceNav', 0],
  ['model', 'accounts', 'model', 'model-settings', 'modelNav', 10],
  // Moved to the plugins page (see SETTINGS_MOVED); registered until that page hosts them.
  ['skills', 'skills', 'resources', 'skills-tab', 'skillsNav', 120],
  ['mcp', 'tools', 'resources', 'mcp-tab', 'toolsNav', 130],
  ['computer-use', 'tools', 'computer-use', 'computer-use-management', 'toolsNav', 132],
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
            : id === 'skills'
              ? 'settings-shell.skillsNav'
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

/** The system prompt section states whether the default is in effect: one small read on open. */
function PromptSubsection({ canSave, t }: { canSave: boolean; t: UiExtensionContext['t'] }) {
  const [customized, setCustomized] = useState<boolean>()
  useEffect(() => {
    const pending = new AbortController()
    void promptSummaryApi
      .get(pending.signal)
      .then((value) => {
        if (pending.signal.aborted) return
        setCustomized(
          Object.values(value.config).some((entry) => typeof entry === 'string' && entry.trim() !== ''),
        )
      })
      // The summary is optional: the section itself reports a failed read when it is opened.
      .catch(() => {})
    return () => pending.abort()
  }, [])
  return (
    <Subsection
      defer
      id="system-prompt"
      icon="file-text"
      title={t('system-prompt')}
      description={t('agentPromptHelp')}
      summary={
        customized === undefined ? undefined : t(customized ? 'agentPromptCustom' : 'agentPromptDefault')
      }
    >
      <SystemPromptPanel canSave={canSave} />
    </Subsection>
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
  [
    'security',
    'security',
    20,
    (c, t) => (
      <>
        <SettingsPageDescription>{t('securityIntro')}</SettingsPageDescription>
        {c.snapshot && (
          <>
            {/* What a new session may do comes first; review and isolation qualify it. */}
            <PermissionDefaults available={c.snapshot.presets.map((preset) => preset.id)} />
            <AutoReviewPanel canSave={c.canSave} />
            <SecurityStatusPanel status={c.snapshot.security} t={t} />
          </>
        )}
        {/* Keys are part of what the agent may use; they need no runtime catalog to list. */}
        <div id="settings-subsection-credentials" tabIndex={-1}>
          <CredentialsPage section />
        </div>
      </>
    ),
  ],
  // Moved to the plugins page (see SETTINGS_MOVED). They stay registered, unlisted, until that page
  // hosts the same panels; a page that still links here by name keeps working meanwhile.
  ['plugins', 'plugins', 110, (c) => c.children],
  [
    'plugins',
    'discover',
    111,
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
  ['tools', 'search', 131, (c, t) => <SearchPanel canSave={c.canSave} t={t} />],
  [
    'advanced',
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
          <SettingsPageDescription>{t('runConfigIntro')}</SettingsPageDescription>
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
          <PromptSubsection canSave={c.canSave} t={t} />
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
    'advanced',
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
    icon: id === 'models' ? 'agent' : id === 'diagnostics' ? 'diagnostics' : group,
    titleKey: id === 'plugins' ? 'settings-shell.page.installed' : `settings-shell.page.${id}`,
    groupTitleKey: group === 'advanced' ? 'settings-shell.advanced' : `settings-shell.group.${group}`,
    navigationId: id === 'plugins' ? 'plugin-management' : `runtime-settings-${id}`,
    component: ({ context }) => render(context.data as RuntimeSettingsContext, context.t),
    runtimeCatalog: ['models', 'security'].includes(id),
  }
  if (!settingsSections.get(id)) settingsSections.register(entry)
}
