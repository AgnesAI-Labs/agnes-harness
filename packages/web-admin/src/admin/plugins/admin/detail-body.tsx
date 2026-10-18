import {
  type PackageCatalogDescriptor,
  type PackageInstalledDescriptor,
  type PackageSource,
  resolvePluginMetadata,
} from '@agnes/protocol'
import {
  Badge,
  Button,
  type DetailActionSpec,
  integrityLabel,
  isBuiltinPlugin,
  PluginPrimaryStatus,
  PluginPurposeSections,
  SettingsState,
  SettingsTechnicalDetails,
  sourceLabel,
  Tag,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { CapabilityReview, FailureHelp, ProvenanceReview } from '../capability-review.js'
import { PluginConfigTab } from '../config-tab.js'
import { GenerationDrainSummary, pluginFailureMessage } from '../control-panel.js'
import { PluginDetailCopy } from '../detail-copy.js'
import type { PluginAdminViewContext } from './page.js'

type Item = PackageInstalledDescriptor | PackageCatalogDescriptor

function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="plugin-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Actions({ actions }: { actions: readonly DetailActionSpec[] }) {
  if (!actions.length) return null
  return (
    <div className="plugin-detail-actions">
      {actions.map((action) => (
        <Button
          key={action.label}
          size="small"
          appearance={action.danger ? 'danger' : 'secondary'}
          disabled={action.disabled ?? false}
          {...(action.title ? { disabledReason: action.title, title: action.title } : {})}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * The tabs of one plugin's detail: what it is, its settings, what it may do, its versions and its
 * own documentation. Actions sit on the tab they belong to instead of one menu at the bottom.
 */
export function PluginDetailBody({
  view,
  item,
  actions,
}: {
  view: PluginAdminViewContext
  item: Item
  actions: readonly DetailActionSpec[]
}) {
  const { t, adminT } = view
  const locale = view.locale.getSnapshot()
  const purpose = resolvePluginMetadata(item.metadata, locale)
  const installed = 'desired' in item ? item : undefined
  const update = installed ? view.availableBundledUpdate(installed) : undefined
  const runtime = view.runtimeState(item.id)
  const failureReason =
    runtime?.error?.message ??
    (installed && installed.actual !== 'running' ? installed.actualReason : undefined)
  const uiRetry =
    installed?.trusted &&
    runtime?.phase === 'failed' &&
    (!installed.primaryStatus || installed.primaryStatus.nextAction === 'none')
      ? view.primaryAction(installed)
      : undefined
  const presentation = view.presentationOf(item)
  const generation = view.state.generations?.plugins.find((plugin) => plugin.id === item.id)
  const slots = installed ? (view.actualSlots?.(item.id) ?? []) : []
  const grouped = (group: DetailActionSpec['group']) => actions.filter((action) => action.group === group)
  const technical: (readonly [string, ReactNode])[] = [
    [t('fact.integrity'), integrityLabel(item.integrity)],
    ...('license' in item ? [[t('fact.license'), item.license] as const] : []),
    ...(installed
      ? ([
          [
            t('fact.browser-slots'),
            slots.length ? slots.join(locale === 'en' ? ', ' : '、') : t('fact.no-browser-slots'),
          ],
          [t('fact.cleanup'), t(installed.cleanupPending ? 'fact.cleanup-pending' : 'fact.cleanup-none')],
        ] as const)
      : []),
  ]
  return (
    <PluginConfigTab
      key={item.id}
      // biome-ignore lint/style/noNonNullAssertion: a detail only opens once the admin context is known.
      context={view.state.context!}
      id={item.id}
      installed={!!installed}
      onClose={() => view.closeDetail()}
      settingsSummary={
        <PluginPurposeSections
          item={item}
          value={presentation}
          section="settings"
          permissions={null}
          versions={null}
        />
      }
      permissions={
        <section data-testid="plugin-permissions-detail" className="agnes-settings-stack">
          {installed && (
            <Facts
              rows={[
                [
                  t('detail.trust'),
                  installed.trusted ? (
                    <Badge key="trust" tone="ok">
                      {t('detail.trusted')}
                    </Badge>
                  ) : (
                    <Tag key="trust" tone="warn">
                      {t('detail.untrusted')}
                    </Tag>
                  ),
                ],
                // A built-in's path is not a source anyone chose; it stays in the technical details.
                ...(isBuiltinPlugin(item)
                  ? []
                  : [[t('fact.source'), sourceLabel(item.source as PackageSource, adminT)] as const]),
              ]}
            />
          )}
          {installed && (
            <>
              <ProvenanceReview value={installed.provenance} t={t} />
              <CapabilityReview value={installed.declaredCapabilities} t={t} />
            </>
          )}
          {installed &&
          (installed.actual === 'failed' || installed.blockers.length || runtime?.phase === 'failed') ? (
            <FailureHelp
              reason={
                installed.blockers.length
                  ? 'capability blocked'
                  : (runtime?.error?.message ?? installed.actualReason ?? '')
              }
              t={t}
            />
          ) : undefined}
          <Actions actions={grouped('trust')} />
        </section>
      }
      versions={
        <section data-testid="plugin-versions-detail" className="agnes-settings-stack">
          <Facts
            rows={[
              [t('detail.version'), item.version],
              ...(update
                ? [[t('detail.bundled-update'), `${item.version} → ${update.version}`] as const]
                : []),
              ...(installed
                ? [
                    [
                      t('fact.rollback-target'),
                      installed.rollbackTarget ? installed.rollbackTarget.version : t('fact.unavailable'),
                    ] as const,
                  ]
                : []),
            ]}
          />
          <GenerationDrainSummary
            status={view.state.generations}
            installed={view.state.installed.filter((row) => row.id === item.id)}
            t={t}
            nameOf={() => purpose?.displayName ?? item.id}
          />
          <Actions actions={grouped('versions')} />
          <SettingsTechnicalDetails data-testid="plugin-technical">
            <code translate="no">{item.id}</code>
            <PluginDetailCopy
              value={JSON.stringify(
                { id: item.id, version: item.version, source: item.source, integrity: item.integrity },
                null,
                2,
              )}
            />
            <Facts rows={technical} />
          </SettingsTechnicalDetails>
        </section>
      }
      docs={
        purpose?.description || purpose?.docsUrl ? (
          <section data-testid="plugin-docs-detail" className="agnes-settings-stack">
            {purpose.description && <p>{purpose.description}</p>}
            {purpose.docsUrl && (
              <a href={purpose.docsUrl} target="_blank" rel="noopener noreferrer">
                {t('detail.openDocs')}
              </a>
            )}
          </section>
        ) : undefined
      }
    >
      {update && (
        <SettingsState>
          {t('detail.bundled-update')}: {item.version} → {update.version}
        </SettingsState>
      )}
      {failureReason && (
        <SettingsState tone="error">
          {pluginFailureMessage(failureReason, t, runtime?.error?.code)}
          {runtime?.error && (
            <span>{` · ${runtime.error.code} · ${runtime.error.phase ?? runtime.phase}${
              runtime.error.roles?.length ? ` · ${runtime.error.roles.join(', ')}` : ''
            }`}</span>
          )}
          {uiRetry && (
            <Button disabled={uiRetry.disabled} onClick={() => void uiRetry.run()}>
              {uiRetry.label}
            </Button>
          )}
        </SettingsState>
      )}
      <PluginPurposeSections
        item={item}
        value={presentation}
        section="overview"
        permissions={null}
        versions={null}
      />
      <Facts
        rows={[
          ...(installed
            ? ([
                [
                  t('detail.state'),
                  <PluginPrimaryStatus
                    key="state"
                    status={installed.primaryStatus}
                    action={view.primaryAction(installed)}
                  />,
                ],
                [t('detail.trust'), t(installed.trusted ? 'detail.trusted' : 'detail.untrusted')],
              ] as const)
            : ([
                [
                  t('detail.compatibility'),
                  t(
                    (item as PackageCatalogDescriptor).compatibility === 'unsupported'
                      ? 'state.unsupported'
                      : 'detail.compatible',
                  ),
                ],
              ] as const)),
          [t('fact.source'), sourceLabel(item.source as PackageSource, adminT)],
        ]}
      />
      {installed && (
        <SettingsTechnicalDetails data-testid="plugin-runtime-technical">
          <p>{t('status.dimensions')}</p>
          <Facts
            rows={[
              [t('status.installed'), item.version],
              [t('detail.trust'), t(installed.trusted ? 'detail.trusted' : 'detail.untrusted')],
              [
                t('status.desired'),
                adminT(installed.desired === 'enabled' ? 'desired.enabled' : 'desired.disabled'),
              ],
              [t('status.actual'), adminT(`actual.${installed.actual}`)],
              [t('status.actualVersion'), installed.actualVersion ?? t('fact.unavailable')],
              [
                t('status.actualIntegrity'),
                installed.actualIntegrity ? integrityLabel(installed.actualIntegrity) : t('fact.unavailable'),
              ],
              [
                t('status.currentGeneration'),
                view.state.generations?.currentGenerationId ?? t('fact.unavailable'),
              ],
              [t('status.browser'), runtime?.phase ?? t('fact.unavailable')],
              [t('status.generation'), generation?.state ?? t('fact.unavailable')],
              [t('status.bound'), installed.boundSessions ?? t('fact.unavailable')],
              [t('status.draining'), installed.drainingSessions ?? t('fact.unavailable')],
              [t('status.historical'), generation?.historicalSessions ?? t('fact.unavailable')],
              [t('fact.cleanup'), t(installed.cleanupPending ? 'fact.cleanup-pending' : 'fact.cleanup-none')],
              [t('status.reasonCode'), installed.primaryStatus?.reasonCode ?? t('fact.unavailable')],
            ]}
          />
          <PluginDetailCopy
            value={JSON.stringify(
              {
                packageId: item.id,
                integrity: item.integrity,
                actualIntegrity: installed.actualIntegrity,
                currentGenerationId: view.state.generations?.currentGenerationId,
                generation: generation?.state,
              },
              null,
              2,
            )}
          />
        </SettingsTechnicalDetails>
      )}
      <Actions actions={grouped('overview')} />
    </PluginConfigTab>
  )
}
