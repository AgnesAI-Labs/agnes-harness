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
  IconButton,
  type IconName,
  SettingsDetails,
  SettingsFooter,
  SettingsPageDescription,
  SettingsState,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { BundlesPanel, SessionDefaultsPanel } from '../admin/plugins/control-panel.js'
import { AutoReviewPanel } from './auto-review.js'
import { ContextPanel } from './context.js'
import { DiagnosticsPanel } from './diagnostics.js'
import { ExamplesPanel } from './examples.js'
import { PermissionDefaults } from './permission-defaults.js'
import { PinsPanel } from './pins.js'
import {
  GenerationsPanel,
  IsolationDetailsPanel,
  LocalPluginsPanel,
  ProvidersPanel,
  PublicationPanel,
} from './runtime-panels.js'
import type { SchedulesApi } from './schedules.js'
import { SecurityStatusPanel } from './security-status.js'
import { PromptRows } from './system-prompt.js'

export type RuntimeSettingsContext = {
  api: PluginAdminApi | undefined
  canSave: boolean
  /** Whether leftover plugin files may be released (the plugin removal permission). */
  canRelease?: boolean
  /** Whether workspace plugins may be trusted (the package trust permission). */
  canTrust?: boolean
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
  // The dialog lists three pages: General, Models & accounts, Permissions & security.
  ['general', 'general', 'appearance', 'appearance-settings', 'appearanceNav', 0],
  ['model', 'accounts', 'model', 'model-settings', 'modelNav', 10],
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
      icon="code"
      description={t('runtimeDetailsHelp')}
      data-testid="plugin-diagnostics"
      onOpenChange={setOpen}
    >
      <PinsPanel api={c.api} canRelease={!!c.canRelease} t={t} />
      {busy && !snapshot && <SettingsState tone="loading" />}
      {failed && (
        <Banner
          tone="error"
          action={
            <Button size="small" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
              {t('retry')}
            </Button>
          }
        >
          {t('unavailable')}
        </Banner>
      )}
      {snapshot && (
        <>
          <Subsection id="isolation" title={t('isolationDetails')}>
            <IsolationDetailsPanel snapshot={snapshot} t={t} />
          </Subsection>
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
              canTrust={!!c.canTrust}
              t={t}
              onRefresh={c.onRefresh}
            />
          )}
        </>
      )}
      <SettingsFooter>
        <IconButton
          name="refresh-cw"
          label={t('retry')}
          data-testid="settings-refresh"
          disabled={!c.api || busy}
          aria-busy={busy}
          onClick={() => setRevision((value) => value + 1)}
        />
      </SettingsFooter>
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
        {c.snapshot && (
          <>
            {/* What a new session may do comes first; review and isolation qualify it. The preset
             is chosen here only. */}
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
  [
    'advanced',
    'models',
    80,
    (c, t) => (
      <>
        <SettingsPageDescription>{t('runConfigIntro')}</SettingsPageDescription>
        <div id="settings-subsection-models" tabIndex={-1} className="agnes-settings-anchor">
          <SessionDefaultsPanel
            api={c.api}
            canSave={c.canSave}
            t={c.pluginText}
            providers={c.snapshot?.providers}
          />
        </div>
        <BundlesPanel api={c.api} canSave={c.canSave} t={c.pluginText} presets={c.snapshot?.presets ?? []} />
        <div id="settings-subsection-context" tabIndex={-1} className="agnes-settings-anchor">
          <ContextPanel canSave={c.canSave} />
        </div>
        <PromptRows canSave={c.canSave} />
      </>
    ),
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

/**
 * The plugin admin's own two pages. They are not settings sections: the workbench shows plugins on
 * a page of their own, and only the standalone admin page lists them beside the settings sections.
 */
export const PLUGIN_ADMIN_PAGES: readonly SettingsSection[] = (
  [
    ['plugins', 'settings-shell.page.installed', 10, (c) => c.children],
    [
      'discover',
      'settings-shell.page.discover',
      11,
      (c, t) => (
        <>
          <ExamplesPanel
            api={c.api}
            canInstall={c.canInstall}
            installed={c.installed}
            t={t}
            onReview={c.onReview}
            onBundles={() => c.navigate('bundles')}
          />
          {c.children}
        </>
      ),
    ],
  ] as const satisfies readonly (readonly [
    string,
    string,
    number,
    (c: RuntimeSettingsContext, t: UiExtensionContext['t']) => ReactNode,
  ])[]
).map(([id, titleKey, order, render]) => ({
  id,
  group: 'plugins',
  order,
  icon: 'plugins',
  titleKey,
  groupTitleKey: 'settings-shell.group.plugins',
  runtimeCatalog: false,
  component: ({ context }) => render(context.data as RuntimeSettingsContext, context.t),
}))
