import { SETTINGS_NAMESPACE, settingsCatalog } from '@agnes/web-admin/settings/locales'
import { type SchedulesApi, SchedulesPage } from '@agnes/web-admin/settings/schedules'
import { TriggersPanel } from '@agnes/web-admin/settings/triggers'
import type { UiExtensionContext } from '@agnes/web-client'
import { Tabs, useUiText } from '@agnes/web-ui'
import { useMemo } from 'react'
import { canEffect, useHomeAdmin } from './admin-api.js'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'

/** Scheduled tasks and triggers. */
export function AutomationPage({ context }: { context: UiExtensionContext }) {
  const data = context.data as HomePageData
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const admin = useHomeAdmin()
  const schedules = useMemo<SchedulesApi>(
    () => ({
      list: (params) => data.call('_agnes/v1/schedules.list', params),
      upsert: (params) => data.call('_agnes/v1/schedules.upsert', params),
      archive: (params) => data.call('_agnes/v1/schedules.archive', params),
      sessionKey: () => data.sessionId(),
    }),
    [data],
  )
  const tab = (context.selection as { tab?: unknown } | undefined)?.tab
  return (
    <HomePageFrame
      id="automation"
      title={context.t('home.entry.automation')}
      description={context.t('home.automation.description')}
    >
      <Tabs
        defaultActiveKey={tab === 'triggers' ? 'triggers' : 'schedules'}
        items={[
          {
            key: 'schedules',
            label: context.t('home.automation.schedules'),
            children: <SchedulesPage api={schedules} t={t} />,
          },
          {
            key: 'triggers',
            label: context.t('home.automation.triggers'),
            children: <TriggersPanel canSave={canEffect(admin, 'packages.activate')} />,
          },
        ]}
      />
    </HomePageFrame>
  )
}
