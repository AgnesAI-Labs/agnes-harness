import type { PackageInstalledDescriptor, PluginGenerationStatus } from '@agnes/protocol'
import type { PluginRuntimeState } from '@agnes/web-foundation/client-modules/runtime-status'
import {
  Disclosure,
  Field,
  Select,
  SettingsTechnicalDetails,
  Tag,
  type TagTone,
  Tooltip,
} from '@agnes/web-ui'
import type { Plugin, Text } from './control-panel-types.js'
import { PluginDetailCopy } from './detail-copy.js'

export const PLUGIN_KINDS = [
  'tool',
  'loop',
  'model-adapter',
  'mcp',
  'skills',
  'ui',
  'bundle',
  'service',
] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

/** Keep author declarations and host/browser observations separate. */
export function pluginStates(
  item: Plugin,
  runtime?: PluginRuntimeState,
  status?: PluginGenerationStatus,
): readonly { key: string; tone: TagTone }[] {
  if (!('desired' in item))
    return item.compatibility === 'unsupported' ? [{ key: 'unsupported', tone: 'bad' }] : []
  if (item.actual === 'failed' || runtime?.phase === 'failed') return [{ key: 'failed', tone: 'bad' }]
  if (item.actual === 'restart-required') return [{ key: 'restart-required', tone: 'warn' }]
  if (item.draining === true) {
    const plugin = status?.plugins.find((plugin) => plugin.id === item.id)
    return [
      {
        key:
          plugin && plugin.drainingSessions > 0 && plugin.drainingSessions === plugin.historicalSessions
            ? 'historical'
            : 'draining',
        tone: 'info',
      },
    ]
  }
  return []
}
export function PluginBadges({
  item,
  runtime,
  status,
  t,
}: {
  item: Plugin
  runtime?: PluginRuntimeState | undefined
  status?: PluginGenerationStatus | undefined
  t: Text
}) {
  return (
    <>
      {pluginStates(item, runtime, status).map(({ key, tone }) =>
        key === 'draining' || key === 'historical' ? (
          <Tooltip key={key} title={t(key === 'historical' ? 'drain.historicalTooltip' : 'drain.tooltip')}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus exposes the update explanation. */}
            <Tag
              tone={tone}
              tabIndex={0}
              role="note"
              aria-label={
                t(`state.${key}`) +
                '. ' +
                t(key === 'historical' ? 'drain.historicalTooltip' : 'drain.tooltip')
              }
            >
              {t(`state.${key}`)}
            </Tag>
          </Tooltip>
        ) : (
          <Tag key={key} tone={tone}>
            {t(`state.${key}`)}
          </Tag>
        ),
      )}
    </>
  )
}
/** Runtime defaults/development packages have no inventory row; their pins belong in diagnostics. */
export function GenerationDrainSummary({
  status,
  installed,
  t,
  nameOf,
}: {
  status: PluginGenerationStatus | undefined
  installed: readonly PackageInstalledDescriptor[]
  t: Text
  nameOf?: (id: string) => string
}) {
  const displayName = (id: string) => nameOf?.(id) ?? id
  const plugins =
    status?.plugins.filter(
      (plugin) => plugin.drainingSessions > 0 && installed.some((item) => item.id === plugin.id),
    ) ?? []
  if (!plugins.length) return null
  const generations =
    status?.generations.filter(
      (generation) =>
        !(generation.current ?? generation.id === status.currentGenerationId) &&
        (generation.state === 'draining' ||
          generation.state === 'historical' ||
          generation.state === 'failed') &&
        generation.boundSessions > 0 &&
        generation.packages.some((item) => plugins.some((plugin) => plugin.id === item.id)),
    ) ?? []
  // A session binds one generation; summing per-plugin counts would count it repeatedly.
  const sessions = generations.reduce((sum, generation) => sum + generation.openSessions, 0)
  const historical = generations.reduce(
    (sum, generation) => sum + Math.max(0, generation.boundSessions - generation.openSessions),
    0,
  )
  const failed = generations.filter((generation) => generation.state === 'failed')
  return (
    <div className="plugin-drain-notice">
      <p data-testid="plugin-drain-summary">
        {t(
          sessions
            ? installed.some((item) => item.desired !== 'enabled')
              ? 'status.retainedSummary'
              : 'drain.summary'
            : historical
              ? 'state.historical'
              : 'drain.summaryUnknown',
          {
            plugins: plugins.length,
            sessions,
            pluginNoun: t(plugins.length === 1 ? 'drain.pluginOne' : 'drain.pluginMany'),
            sessionNoun: t(sessions === 1 ? 'drain.sessionOne' : 'drain.sessionMany'),
          },
        )}
      </p>
      {historical > 0 && (
        <p data-testid="plugin-historical-summary">
          {t('drain.historicalSummary', { sessions: historical })}
        </p>
      )}
      {failed.length > 0 && (
        <p role="status" data-testid="plugin-retained-failures">
          {t('drain.failedSummary', { versions: failed.length })}
        </p>
      )}
      <Disclosure
        variant="plain"
        data-testid="plugin-drain-details"
        summary={t(historical && !sessions ? 'drain.historicalDetails' : 'drain.details')}
      >
        <ul>
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <strong>{displayName(plugin.id)}</strong>
              <ul>
                {generations.flatMap((generation) =>
                  generation.packages
                    .filter((item) => item.id === plugin.id)
                    .map((item) => (
                      <li key={generation.id}>
                        {t(generation.openSessions === 0 ? 'drain.historicalVersion' : 'drain.version', {
                          version: item.version,
                          sessions:
                            generation.openSessions === 0
                              ? generation.boundSessions
                              : generation.openSessions,
                        })}
                        {generation.state === 'failed' && <Tag tone="bad">{t('drain.failedVersion')}</Tag>}
                        <SettingsTechnicalDetails>
                          <code>
                            {plugin.id} · {generation.id}
                            {generation.error ? ` · ${generation.error}` : ''}
                          </code>
                          <PluginDetailCopy
                            value={JSON.stringify({ packageId: plugin.id, generationId: generation.id })}
                          />
                        </SettingsTechnicalDetails>
                      </li>
                    )),
                )}
              </ul>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  )
}

export function KindFilter({
  value,
  onChange,
  t,
}: {
  value: PluginKind | ''
  onChange(value: PluginKind | ''): void
  t: Text
}) {
  return (
    <Field label={t('kind.filter')}>
      <Select<PluginKind | 'all'>
        virtual={false}
        aria-label={t('kind.filter')}
        value={value || 'all'}
        onChange={(kind) => onChange(kind === 'all' ? '' : kind)}
        options={[
          { value: 'all', label: t('kind.all') },
          ...PLUGIN_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) })),
        ]}
      />
    </Field>
  )
}
export function pluginFailureMessage(message: string, t: Text, code?: string): string {
  const keys: Record<string, string> = {
    'Plugin export is missing.': 'failure.missing-export',
    'Plugin API range is incompatible.': 'failure.api-range',
    'A required plugin service is missing.': 'failure.missing-inject',
    'Plugin configuration schema is invalid.': 'failure.schema',
    'Plugin frontend could not be loaded.': 'failure.frontend',
    'Plugin capability policy blocked activation.': 'failure.capability',
    'Runtime activation failed.': 'failure.activation',
  }
  const reason = t(
    code?.startsWith('CLIENT_MODULE_') ? 'failure.frontend' : (keys[message] ?? 'failure.activation'),
  )
  return `${reason} ${t('failure.repair')}`
}
