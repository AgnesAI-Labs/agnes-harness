import { resolvePluginMetadata } from '@agnes/protocol'
import type { ReactNode } from 'react'
import { PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog } from './locales/plugin-presentation.js'
import { type PluginPresentation, type PluginPurposeItem, pluginOrigin } from './plugin-presentation.js'
import { SettingsDetails, SettingsTechnicalDetails } from './settings-layout.js'
import { Badge } from './ui/badge.js'
import type { IconName } from './ui/icon-set.js'
import { MetaText } from './ui/tag.js'
import { useUiText } from './ui-locale.js'

const PLUGIN_ICONS = new Map<string, IconName>([
  ['@agnes/plugin-helper', 'puzzle'],
  ['@agnes/document-reader', 'file-text'],
  ['@agnes/skill-helper', 'sparkles'],
  ['@agnes/mcp-helper', 'plug'],
])

/** Known package IDs carry purpose across locales; other plugins keep the generic glyph. */
export const pluginIconName = (id: string): IconName => PLUGIN_ICONS.get(id) ?? 'puzzle'

/** Where the plugin comes from: built in, official, community, local or an example. */
export function PluginSourceBadge({ item }: { item: PluginPurposeItem }) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const origin = pluginOrigin(item)
  return (
    <Badge>
      <span data-testid="plugin-source-badge" data-origin={origin}>
        {t(`origin.${origin}`)}
      </span>
    </Badge>
  )
}

const INCLUDE_COUNTS = { tool: 'tools', skills: 'skills', mcp: 'mcp', bundle: 'bundles', ui: 'ui' } as const

/**
 * What a plugin brings, in a few words. The package says which kinds it includes and, where its
 * data states one, how many; a kind without a number is counted by the plugin's code, not zero.
 * Author declarations stay separate from observed registrations. Explicit launch declarations
 * identify agents.
 */
export function pluginIncludes(
  item: PluginPurposeItem,
  _value: PluginPresentation | undefined,
  t: (key: string, vars?: Readonly<Record<string, string | number>>) => string,
): string {
  const label = (kind: string) => {
    const key = `provide.${kind === 'skills' ? 'skill' : kind}`
    return t(key) === key ? kind : t(key)
  }
  const includes = item.presentation?.includes
  const kinds: readonly string[] = item.provides ?? []
  if (kinds.length)
    return kinds
      .flatMap((kind) => {
        const count = includes?.counts?.[INCLUDE_COUNTS[kind as keyof typeof INCLUDE_COUNTS]]
        if (kind === 'bundle' && item.agents?.length) {
          const reusable = Math.max(0, (count ?? item.agents.length) - item.agents.length)
          return [
            t('includesItem', { count: item.agents.length, name: t('provide.agent') }),
            ...(reusable ? [t('includesItem', { count: reusable, name: label(kind) })] : []),
          ]
        }
        return count ? t('includesItem', { count, name: label(kind) }) : label(kind)
      })
      .join(' · ')
  return ''
}

/** The row's small line describes the package's declared capabilities and static counts. */
export function PluginPurposeBadges({
  item,
  value,
}: {
  item: PluginPurposeItem
  value?: PluginPresentation | undefined
}) {
  const { t } = useUiText(PLUGIN_PRESENTATION_NAMESPACE, pluginPresentationCatalog)
  const includes = pluginIncludes(item, value, t)
  if (!item.metadata && !includes && !value?.provides.length) return null
  return (
    <MetaText data-testid="plugin-purpose-badges">
      {includes && <span data-testid="plugin-declared-provides">{t('includes', { items: includes })}</span>}
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
  // The detail's header already says the summary; the overview adds the description only when it
  // says more than that.
  const description =
    purpose?.description && purpose.description.trim() !== purpose.summary?.trim()
      ? purpose.description
      : undefined
  const settings = (item.presentation?.rows ?? []).filter((row) => row.settings)
  return (
    <div className="agnes-settings-stack" data-testid="plugin-purpose-detail">
      {(!section || section === 'overview') && (
        <section data-testid="plugin-overview">
          {/* Inside the overview tab the tab already names this part. */}
          {!section && <h3>{t('overview')}</h3>}
          {description ? (
            <p data-testid="plugin-description">{description}</p>
          ) : (
            !purpose?.description && <PluginProvidesChips value={value} />
          )}
          <p className="agh-plugin-source-line">
            <PluginSourceBadge item={item} />
            <PluginPurposeBadges item={item} value={value} />
          </p>
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
            <SettingsTechnicalDetails title={t('technical')}>
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
            </SettingsTechnicalDetails>
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
