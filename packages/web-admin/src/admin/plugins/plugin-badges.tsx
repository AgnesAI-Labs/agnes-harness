import type { PackageInstalledDescriptor, PluginGenerationStatus } from '@agnes/protocol'
import type { PluginRuntimeState } from '@agnes/web-foundation/client-modules/runtime-status'
import {
  ADMIN_LIST_LOCALE_NAMESPACE,
  adminListLocaleCatalog,
  Badge,
  Field,
  Popover,
  Select,
  type StateTone,
  useUiText,
} from '@agnes/web-ui'
import type { Plugin, Text } from './control-panel-types.js'

export const PLUGIN_KINDS = ['tool', 'loop', 'model-adapter', 'mcp', 'skills', 'ui', 'bundle'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

/** Keep author declarations and host/browser observations separate. */
export function pluginStates(
  item: Plugin,
  runtime?: PluginRuntimeState,
): readonly { key: string; tone: StateTone }[] {
  if (!('desired' in item)) return []
  const states: { key: string; tone: StateTone }[] = [{ key: 'installed', tone: 'off' }]
  if (item.desired === 'enabled') states.push({ key: 'enabled', tone: 'ok' })
  if (item.actual === 'running') states.push({ key: 'active', tone: 'ok' })
  if (item.draining === true) states.push({ key: 'draining', tone: 'warn' })
  if (item.actual === 'restart-required') states.push({ key: 'restart-required', tone: 'warn' })
  if (item.actual === 'failed' || runtime?.phase === 'failed') states.push({ key: 'failed', tone: 'bad' })
  return states
}
export function PluginBadges({
  item,
  runtime,
  t,
}: {
  item: Plugin
  runtime?: PluginRuntimeState | undefined
  t: Text
}) {
  return (
    <div className="agnes-settings-actions">
      {(item.kinds ?? []).map((kind) => (
        <Badge key={`kind:${kind}`}>{t(`kind.${kind}`)}</Badge>
      ))}
      {pluginStates(item, runtime).map(({ key, tone }) =>
        key === 'draining' ? (
          <Popover key={key} content={t('drain.tooltip')} trigger={['hover', 'focus']}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus exposes the old-version explanation to keyboard users. */}
            <span role="note" tabIndex={0} aria-label={t('state.draining') + '. ' + t('drain.tooltip')}>
              <Badge tone="off">{t('state.draining')}</Badge>
            </span>
          </Popover>
        ) : (
          <Badge key={`state:${key}`} tone={tone}>
            {t(`state.${key}`)}
          </Badge>
        ),
      )}
    </div>
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
  const { t: names } = useUiText(ADMIN_LIST_LOCALE_NAMESPACE, adminListLocaleCatalog)
  const displayName = (id: string) => {
    const key = `row.name.${id}`
    const name = names(key)
    return name !== key ? name : (nameOf?.(id) ?? id.split('/').at(-1))
  }
  const plugins =
    status?.plugins.filter(
      (plugin) => plugin.drainingSessions > 0 && installed.some((item) => item.id === plugin.id),
    ) ?? []
  if (!plugins.length) return null
  const generations =
    status?.generations.filter(
      (generation) =>
        generation.state === 'draining' &&
        generation.boundSessions > 0 &&
        generation.packages.some((item) => plugins.some((plugin) => plugin.id === item.id)),
    ) ?? []
  // A session binds one generation; summing per-plugin counts would count it repeatedly.
  const sessions = generations.reduce((sum, generation) => sum + generation.boundSessions, 0)
  return (
    <div className="plugin-drain-notice">
      <p data-testid="plugin-drain-summary">
        {t(sessions ? 'drain.summary' : 'drain.summaryUnknown', {
          plugins: plugins.length,
          sessions,
          pluginNoun: t(plugins.length === 1 ? 'drain.pluginOne' : 'drain.pluginMany'),
          sessionNoun: t(sessions === 1 ? 'drain.sessionOne' : 'drain.sessionMany'),
        })}
      </p>
      <details data-testid="plugin-drain-details">
        <summary>{t('drain.details')}</summary>
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
                        {t('drain.version', { version: item.version, sessions: generation.boundSessions })}
                        <br />
                        <code>
                          {plugin.id} · {generation.id}
                        </code>
                      </li>
                    )),
                )}
              </ul>
            </li>
          ))}
        </ul>
      </details>
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
