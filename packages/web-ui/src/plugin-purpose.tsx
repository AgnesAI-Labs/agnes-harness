import { resolvePluginMetadata } from '@agnes/protocol'
import type { ReactNode } from 'react'
import { PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog } from './locales/plugin-presentation.js'
import { type PluginPresentation, type PluginPurposeItem, pluginOrigin } from './plugin-presentation.js'
import { SettingsCard, SettingsDetails } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import { useUiText } from './ui-locale.js'

export function PluginPurposeBadges({ item }: { item: PluginPurposeItem }) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  return (
    <div className="agnes-settings-actions" data-testid="plugin-purpose-badges">
      <Badge>{item.metadata ? t(`category.${item.metadata.category}`) : t('unclassified')}</Badge>
      <Badge>{t(`origin.${pluginOrigin(item)}`)}</Badge>
      {'trusted' in item && (
        <Badge tone={item.trusted ? 'ok' : 'warn'}>{t(item.trusted ? 'trusted' : 'untrusted')}</Badge>
      )}
    </div>
  )
}

export function PluginProvidesChips({ value }: { value: PluginPresentation | undefined }) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const counts = new Map<string, number>()
  for (const item of value?.provides ?? []) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  return (
    <div
      className="agnes-settings-actions"
      role="group"
      aria-label={t('provides')}
      data-testid="plugin-provides"
    >
      {[...counts].map(([kind, count]) => (
        <Badge key={kind}>
          {t(`provide.${kind}`) === `provide.${kind}` ? kind : t(`provide.${kind}`)} · {count}
        </Badge>
      ))}
      {!counts.size && <small>{t(value?.available ? 'none' : 'unavailable')}</small>}
    </div>
  )
}

/** Shared sections inside the host-owned detail dialog. Settings editing stays in its retained tab. */
export function PluginPurposeSections({
  item,
  value,
  permissions,
  versions,
}: {
  item: PluginPurposeItem
  value: PluginPresentation | undefined
  permissions: ReactNode
  versions: ReactNode
}) {
  const { t, locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const purpose = resolvePluginMetadata(item.metadata, locale)
  const settings = (item.presentation?.rows ?? []).filter((row) => row.settings)
  return (
    <div className="agnes-settings-stack" data-testid="plugin-purpose-detail">
      <SettingsCard title={t('overview')} data-testid="plugin-overview">
        <p>{purpose?.description ?? t('noDescription')}</p>
        <PluginPurposeBadges item={item} />
        {purpose?.docsUrl && (
          <a href={purpose.docsUrl} target="_blank" rel="noopener noreferrer">
            {t('docs')}
          </a>
        )}
        {!!item.presentation?.rows.length && (
          <SettingsDetails title={t('rowPurpose')} data-testid="plugin-row-purposes">
            <p>{t('rowPurposeHelp')}</p>
            {item.presentation.rows.map((row) => {
              const text = resolvePluginMetadata(row.metadata ?? item.metadata, locale)
              return (
                <div className="agnes-settings-row" key={row.id}>
                  <strong>{text?.displayName ?? row.id}</strong>
                  <p>{text?.summary ?? t('noDescription')}</p>
                  <code>{row.id}</code>
                </div>
              )
            })}
          </SettingsDetails>
        )}
      </SettingsCard>
      <SettingsCard title={t('provides')} data-testid="plugin-provides-detail">
        <PluginProvidesChips value={value} />
        {!!value?.provides.length && (
          <ul>
            {value.provides.map((entry) => (
              <li key={`${entry.kind}:${entry.id}`}>
                <code>{entry.id}</code> ·{' '}
                {t(`provide.${entry.kind}`) === `provide.${entry.kind}`
                  ? entry.kind
                  : t(`provide.${entry.kind}`)}
                {entry.selected !== undefined && <> · {t(entry.selected ? 'selected' : 'available')}</>}
                {entry.scope && <> · {entry.scope}</>}
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <SettingsCard title={t('appears')} data-testid="plugin-appears-detail">
        <p>
          {value?.appearsIn.length
            ? value.appearsIn.map((surface) => t(`surface.${surface}`)).join(' · ')
            : t('unavailable')}
        </p>
        <p>{t('appearanceHelp')}</p>
      </SettingsCard>
      <SettingsCard title={t('settings')} data-testid="plugin-settings-detail">
        <p>
          {settings.length
            ? t('settingsHelp')
            : value?.provides.some((entry) => entry.kind === 'settings')
              ? t('settingsSlots')
              : t('noSettings')}
        </p>
        {!!settings.length && (
          <ul>
            {settings.map((row) => (
              <li key={row.id}>
                <code>{row.id}</code>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <SettingsCard title={t('permissions')} data-testid="plugin-permissions-detail">
        {permissions}
      </SettingsCard>
      <SettingsCard title={t('versions')} data-testid="plugin-versions-detail">
        {versions}
      </SettingsCard>
    </div>
  )
}
