import { resolvePluginMetadata } from '@agnes/protocol'
import type { ReactNode } from 'react'
import { PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog } from './locales/plugin-presentation.js'
import { type PluginPresentation, type PluginPurposeItem, pluginOrigin } from './plugin-presentation.js'
import { SettingsDetails } from './settings-layout.js'
import { MetaText } from './ui/tag.js'
import { useUiText } from './ui-locale.js'

export function PluginPurposeBadges({ item }: { item: PluginPurposeItem }) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  return (
    <MetaText data-testid="plugin-purpose-badges">
      {t(`origin.${pluginOrigin(item)}`)}
      {item.metadata ? ` · ${t(`category.${item.metadata.category}`)}` : ''}
    </MetaText>
  )
}

export function PluginProvidesChips({ value }: { value: PluginPresentation | undefined }) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const counts = new Map<string, number>()
  for (const item of value?.provides ?? []) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  if (!counts.size) return null
  return (
    <MetaText data-testid="plugin-provides">
      {t('includes', {
        items: [...counts]
          .map(
            ([kind, count]) =>
              `${count} ${t(`provide.${kind}`) === `provide.${kind}` ? kind : t(`provide.${kind}`)}`,
          )
          .join(' · '),
      })}
    </MetaText>
  )
}

/** Shared sections inside the host-owned detail dialog. Settings editing stays in its retained tab. */
export function PluginPurposeSections({
  item,
  value,
  permissions,
  versions,
  section,
}: {
  item: PluginPurposeItem
  value: PluginPresentation | undefined
  permissions: ReactNode
  versions: ReactNode
  section?: 'overview' | 'settings' | 'permissions' | 'versions'
}) {
  const { t, locale } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const purpose = resolvePluginMetadata(item.metadata, locale)
  const settings = (item.presentation?.rows ?? []).filter((row) => row.settings)
  return (
    <div className="agnes-settings-stack" data-testid="plugin-purpose-detail">
      {(!section || section === 'overview') && (
        <section data-testid="plugin-overview">
          {/* Inside the overview tab the tab already names this part. */}
          {!section && <h3>{t('overview')}</h3>}
          {purpose?.description ? <p>{purpose.description}</p> : <PluginProvidesChips value={value} />}
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
        </section>
      )}
      {(!section || (section === 'overview' && !!value?.provides.length)) && (
        <section data-testid="plugin-provides-detail">
          <h3>{t('provides')}</h3>
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
        </section>
      )}
      {(!section || section === 'overview') && (
        <section data-testid="plugin-appears-detail">
          <h3>{t('appears')}</h3>
          <p>
            {value?.appearsIn.length
              ? value.appearsIn.map((surface) => t(`surface.${surface}`)).join(' · ')
              : t('unavailable')}
          </p>
          <p>{t('appearanceHelp')}</p>
        </section>
      )}
      {(!section || section === 'settings') && (
        <section data-testid="plugin-settings-detail">
          <h3>{t('settings')}</h3>
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
        </section>
      )}
      {(!section || section === 'permissions') && (
        <section data-testid="plugin-permissions-detail">
          <h3>{t('permissions')}</h3>
          {permissions}
        </section>
      )}
      {(!section || section === 'versions') && (
        <section data-testid="plugin-versions-detail">
          <h3>{t('versions')}</h3>
          {versions}
        </section>
      )}
    </div>
  )
}
