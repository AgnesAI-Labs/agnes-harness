import { ChildEnginesPanel } from '@agnes/web-admin/settings/child-engines'
import { SETTINGS_NAMESPACE, settingsCatalog } from '@agnes/web-admin/settings/locales'
import { SearchPanel } from '@agnes/web-admin/settings/search'
import {
  Badge,
  type IconName,
  PushPage,
  SettingsGroup,
  SettingsItem,
  SettingsPageSlots,
  Tabs,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useState } from 'react'
import type { PluginView } from './admin-view.js'
import type { Capability } from './route.js'
import type { CapabilitySummary } from './summaries.js'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export const CAPABILITY_ICONS: Readonly<Record<Capability, IconName>> = {
  search: 'globe',
  'computer-use': 'monitor',
  subagents: 'git-branch',
}

/**
 * A built-in capability's page, pushed over the plugins page like a plugin's detail: an overview and
 * a settings tab that holds its configuration. It has no versions, trust or uninstall, because it is
 * not a package. It renders only while its page is open.
 */
export function CapabilityDetail({
  capability,
  view,
  t,
  summary,
  computerUse,
}: {
  capability: Capability
  view: PluginView | undefined
  t: Text
  summary: CapabilitySummary | undefined
  /** The computer-use panel is composed by the page: its state lives with the conversation package. */
  computerUse: ReactNode
}) {
  const { t: settingsText } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [tab, setTab] = useState('settings')
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const canSave = view?.canEffect('packages.activate') ?? false
  const name = t(`cap.${capability}.name`)
  return (
    <PushPage
      id={capability}
      title={name}
      description={
        <>
          <Badge>{t('builtin.badge')}</Badge> {t(`cap.${capability}.page`)}
        </>
      }
    >
      {/* The id the capability's page had before it became a detail. */}
      <div className="plugins-page-builtin" data-testid={`home-page-plugins-${capability}`}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          aria-label={name}
          tabBarExtraContent={<div ref={setActions} className="plugins-page-builtin-actions" />}
          items={[
            {
              key: 'overview',
              label: <span data-testid="builtin-tab-overview">{t('builtin.overview')}</span>,
              children: (
                <SettingsGroup data-testid="builtin-overview">
                  <SettingsItem
                    icon={CAPABILITY_ICONS[capability]}
                    label={name}
                    description={t(`cap.${capability}.desc`)}
                  >
                    {summary && (
                      <span className="plugins-page-summary" data-attention={summary.attention || undefined}>
                        {summary.text}
                      </span>
                    )}
                  </SettingsItem>
                  <SettingsItem
                    icon="puzzle"
                    label={t('builtin.source')}
                    description={t('builtin.sourceHelp')}
                  />
                </SettingsGroup>
              ),
            },
            {
              key: 'settings',
              label: <span data-testid="builtin-tab-settings">{t('builtin.settings')}</span>,
              children: (
                <SettingsPageSlots actions={actions}>
                  {capability === 'search' && <SearchPanel canSave={canSave} t={settingsText} />}
                  {capability === 'computer-use' && computerUse}
                  {capability === 'subagents' && (
                    <>
                      <SettingsGroup>
                        <SettingsItem
                          icon="git-branch"
                          label={t('sub.builtin')}
                          description={t('sub.builtinHelp')}
                        >
                          <Badge tone="ok">{t('sub.available')}</Badge>
                        </SettingsItem>
                      </SettingsGroup>
                      <h3 className="plugins-page-builtin-label">
                        {t('sub.external')} <small>{t('sub.externalNote')}</small>
                      </h3>
                      <ChildEnginesPanel api={view?.api} canSave={canSave} t={settingsText} />
                    </>
                  )}
                </SettingsPageSlots>
              ),
            },
          ]}
        />
      </div>
    </PushPage>
  )
}
