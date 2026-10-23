import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { CredentialsPage } from '@agnes/resource-control-web/credentials'
import { type SettingsSection, settingsSections, type UiExtensionContext } from '@agnes/web-client'
import {
  Button,
  Icon,
  SettingsBlock,
  SettingsDrill,
  SettingsExpand,
  SettingsGroup,
  SettingsItem,
  SettingsTechnicalDetails,
  scopedResourceKey,
  useResource,
} from '@agnes/web-ui'
import { type ReactNode, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { BundlesPanel, SessionDefaultsPanel } from '../admin/plugins/control-panel.js'
import { ApplicationPanel } from './application.js'
import { AutoReviewPanel } from './auto-review.js'
import { ContextPanel } from './context.js'
import { DiagnosticsPanel } from './diagnostics.js'
import { ExamplesPanel } from './examples.js'
import { JobsPanel } from './jobs-panel.js'
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
  // Native everyday pages share the registry with application adoption.
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

/**
 * Runtime details under Integrations: a subpage of technical records, each opening in place. The runtime catalog is
 * cached when the subpage opens and revalidated on window focus.
 */
function RuntimeDetails({ c, t }: { c: RuntimeSettingsContext; t: UiExtensionContext['t'] }) {
  const [open, setOpen] = useState(false)
  const resource = useResource(
    open && c.api ? scopedResourceKey(c.api, 'settings:runtime:details') : undefined,
    () => {
      if (!c.api) throw new Error('Admin unavailable')
      return c.api.runtime()
    },
  )
  const snapshot = resource.data
  const busy = resource.loading
  const failed = !!resource.error
  const providers = snapshot?.providers ?? []
  // A mutation in here (trust, rescan, migration) changes what this subpage shows: re-read its own
  // runtime snapshot as well as the page's.
  const refresh = async () => {
    resource.reload()
    await c.onRefresh()
  }
  const generations = c.generations?.generations ?? []
  return (
    <SettingsDrill
      id="runtime-details"
      data-testid="plugin-diagnostics"
      label={t('technicalDetails')}
      description={t('runtimeDetailsHelp')}
      onClick={() => setOpen(true)}
    >
      <SettingsBlock
        state={failed ? 'error' : busy && !snapshot ? 'loading' : undefined}
        onReload={resource.reload}
        data-testid="runtime-details"
      >
        {snapshot && (
          <>
            <SettingsExpand
              label={t('presetRequirements')}
              value={t('presetCount', {
                count: snapshot.security?.presetPolicies.length ?? snapshot.presets.length,
              })}
              data-testid="settings-subsection-isolation"
            >
              <IsolationDetailsPanel snapshot={snapshot} t={t} />
            </SettingsExpand>
            <SettingsExpand
              label={t('providerTypes')}
              value={t('providerCount', {
                kinds: new Set(providers.map((entry) => entry.kind)).size,
                count: providers.length,
              })}
              data-testid="settings-subsection-provider-types"
            >
              <ProvidersPanel snapshot={snapshot} t={t} />
            </SettingsExpand>
          </>
        )}
        <SettingsExpand
          label={t('generation')}
          hint={t('generationHelp')}
          value={generations.length ? t('generationCount', { count: generations.length }) : undefined}
          data-testid="runtime-generations"
        >
          <GenerationsPanel
            status={c.generations}
            api={c.api}
            canSave={c.canSave}
            t={t}
            onRefresh={refresh}
          />
        </SettingsExpand>
        {snapshot && (
          <SettingsExpand label={t('publication')} data-testid="runtime-publication">
            <PublicationPanel snapshot={snapshot} t={t} />
          </SettingsExpand>
        )}
        {snapshot && c.api && (
          <SettingsExpand label={t('local')} hint={t('localShort')} data-testid="runtime-local">
            <LocalPluginsPanel
              api={c.api}
              snapshot={snapshot}
              canSave={c.canSave}
              canTrust={!!c.canTrust}
              t={t}
              onRefresh={refresh}
            />
          </SettingsExpand>
        )}
      </SettingsBlock>
    </SettingsDrill>
  )
}
const definitions: readonly [
  string,
  string,
  number,
  (c: RuntimeSettingsContext, t: UiExtensionContext['t']) => ReactNode,
][] = [
  ['application', 'application', 30, (c) => <ApplicationPanel api={c.api} canSave={c.canSave} />],
  [
    'security',
    'security',
    20,
    (c, t) => (
      <>
        {c.snapshot && (
          <>
            {/* What a new session may do comes first; review and isolation qualify it. The default
             permission and preset are chosen here only. */}
            <PermissionDefaults
              presets={c.snapshot.presets}
              permissions={c.snapshot.permissions}
              security={c.snapshot.security}
            />
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
    'accounts',
    'models',
    11,
    (c, t) => (
      <>
        <p className="agnes-settings-note">{t('runConfigIntro')}</p>
        <SettingsGroup>
          <SettingsItem icon="bot" label={t('agentGallery')}>
            <Button appearance="link" onClick={() => c.navigate('examples')}>
              {t('open')} <Icon name="chevron-right" />
            </Button>
          </SettingsItem>
        </SettingsGroup>
        <div id="settings-subsection-models" tabIndex={-1} className="agnes-settings-anchor">
          <SessionDefaultsPanel
            api={c.api}
            canSave={c.canSave}
            t={c.pluginText}
            providers={c.snapshot?.providers}
          />
        </div>
        <SettingsTechnicalDetails title={t('technicalDetails')} data-testid="run-config-technical">
          <p>{t('compositionDetailsHelp')}</p>
          <BundlesPanel
            api={c.api}
            canSave={c.canSave}
            t={c.pluginText}
            presets={c.snapshot?.presets ?? []}
          />
        </SettingsTechnicalDetails>
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
      <DiagnosticsPanel
        maintenance={
          <SettingsDrill
            id="plugin-file-cleanup"
            data-testid="runtime-pins"
            label={t('pinsTitle')}
            description={t('pinsHelp')}
          >
            <PinsPanel api={c.api} canRelease={!!c.canRelease} t={t} />
          </SettingsDrill>
        }
        integrations={<RuntimeDetails c={c} t={t} />}
      />
    ),
  ],
]
for (const [group, id, order, render] of definitions) {
  const entry: SettingsSection = {
    group,
    id,
    order,
    icon:
      id === 'application'
        ? 'puzzle'
        : id === 'models'
          ? 'agent'
          : id === 'diagnostics'
            ? 'diagnostics'
            : group,
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

/** Installed by the provider-independent jobs client contribution. */
export function registerJobsSettingsContribution(): () => void {
  if (settingsSections.get('background-jobs')) return () => undefined
  return settingsSections.register({
    id: 'background-jobs',
    group: 'advanced',
    order: 80,
    icon: 'terminal',
    runtimeCatalog: false,
    titleKey: 'settings-shell.jobs',
    groupTitleKey: 'settings-shell.advanced',
    component: () => <JobsPanel />,
  })
}
