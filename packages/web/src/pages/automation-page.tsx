import { AUTOMATION_NAMESPACE, automationCatalog } from '@agnes/web-admin/settings/automation-locale'
import { SETTINGS_NAMESPACE, settingsCatalog } from '@agnes/web-admin/settings/locales'
import { type SchedulesApi, SchedulesPage } from '@agnes/web-admin/settings/schedules'
import { TriggersPanel } from '@agnes/web-admin/settings/triggers'
import { homeNavigation, type UiExtensionContext } from '@agnes/web-client'
import { Tabs, useUiText } from '@agnes/web-ui'
import { useMemo, useState } from 'react'
import { canEffect, useHomeAdmin } from './admin-api.js'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'

type AutomationTab = 'schedules' | 'triggers'
const tabOf = (selection: unknown): AutomationTab =>
  (selection as { tab?: unknown } | undefined)?.tab === 'triggers' ? 'triggers' : 'schedules'

/**
 * 自动化: what happens by itself. Scheduled tasks continue a session at a set time; triggers start
 * one when another system sends an event. The tab is part of the page's address.
 */
export function AutomationPage({ context }: { context: UiExtensionContext }) {
  const data = context.data as HomePageData
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const { t: ux } = useUiText(AUTOMATION_NAMESPACE, automationCatalog)
  const admin = useHomeAdmin()
  // The panel that is showing puts its "new" button in the page header.
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null)
  const schedules = useMemo<SchedulesApi>(
    () => ({
      list: (params) => data.call('_agnes/v1/schedules.list', params),
      upsert: (params) => data.call('_agnes/v1/schedules.upsert', params),
      archive: (params) => data.call('_agnes/v1/schedules.archive', params),
      sessionKey: () => data.sessionId(),
    }),
    [data],
  )
  const tab = tabOf(context.selection)
  return (
    <HomePageFrame
      id="automation"
      title={context.t('home.entry.automation')}
      description={ux('pageDescription')}
      actions={<div className="home-page-action-slot" ref={setActionsHost} />}
      tabs={
        <Tabs
          activeKey={tab}
          aria-label={ux('tabs')}
          onChange={(key) => homeNavigation.open('automation', { tab: key })}
          items={[
            { key: 'schedules', label: ux('tabSchedules') },
            { key: 'triggers', label: ux('tabTriggers') },
          ]}
        />
      }
    >
      {tab === 'schedules' ? (
        <SchedulesPage api={schedules} t={t} actionsHost={actionsHost} />
      ) : (
        <TriggersPanel canSave={canEffect(admin, 'packages.activate')} actionsHost={actionsHost} />
      )}
    </HomePageFrame>
  )
}
