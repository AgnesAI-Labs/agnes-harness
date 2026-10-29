import { AUTOMATION_NAMESPACE, automationCatalog } from '@agnes/web-admin/settings/automation-locale'
import { SETTINGS_NAMESPACE, settingsCatalog } from '@agnes/web-admin/settings/locales'
import { scheduleChoices } from '@agnes/web-admin/settings/schedule-model'
import { type SchedulesApi, SchedulesPage } from '@agnes/web-admin/settings/schedules'
import { TriggersPanel } from '@agnes/web-admin/settings/triggers'
import { homeNavigation, type UiExtensionContext } from '@agnes/web-client'
import { Tabs, useUiText } from '@agnes/web-ui'
import { useMemo, useState } from 'react'
import { canEffect, homeAdmin, useHomeAdmin } from './admin-api.js'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'

type AutomationTab = 'schedules' | 'triggers'
const tabOf = (selection: unknown): AutomationTab =>
  (selection as { tab?: unknown } | undefined)?.tab === 'triggers' ? 'triggers' : 'schedules'

/**
 * Triggers have no entry while they are being reworked: the tab, its panel and a `?tab=triggers` link
 * are all left out, and the page opens on the schedule list. Flip this back to true to restore them —
 * the panel and its routes stay in place, so nothing else has to change.
 */
const TRIGGERS_TAB = false

/**
 * Automation: what happens by itself. Scheduled tasks run at a set time, in a new session or an existing
 * one; triggers start a session when another system sends an event. The tab is part of the address.
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
      history: (params) => data.call('_agnes/v1/schedules.history', params),
      receipt: (params) => data.call('_agnes/v1/schedules.receipt', params),
      upsert: (params) => data.call('_agnes/v1/schedules.upsert', params),
      archive: (params) => data.call('_agnes/v1/schedules.archive', params),
      control: (params) => data.call('_agnes/v1/schedules.control', params),
      sessionKey: () => data.sessionId(),
      workspaces: () => data.call('_agnes/v1/workspace.list', {}),
      sessions: () => data.call('_agnes/v1/session.list', { limit: 200 }),
      // The same catalog a new chat chooses from; a reader without admin access sees the defaults only.
      choices: async () => {
        const { api } = await homeAdmin()
        const [loops, adapters, runtime, config, installed] = await Promise.allSettled([
          api.loops(),
          api.modelAdapters(),
          api.runtime(),
          data.call<{ accounts?: { route: string; label: string; providerId?: string }[] }>(
            '_agnes/v1/config.get',
            {},
          ),
          api.list(),
        ])
        const agents =
          installed.status === 'fulfilled'
            ? await Promise.allSettled(
                installed.value.packages
                  .filter((pkg) => pkg.trusted && pkg.desired === 'enabled')
                  .flatMap((pkg) =>
                    (pkg.agents ?? []).map((agent) =>
                      data.call<import('@agnes/protocol').AgentPlan>('_agnes/v1/agents.resolve', {
                        ref: agent.ref,
                      }),
                    ),
                  ),
              )
            : []
        return scheduleChoices({
          agents: agents.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
          ...(loops.status === 'fulfilled'
            ? { loops: loops.value.loops, ...(loops.value.presets ? { presets: loops.value.presets } : {}) }
            : {}),
          ...(adapters.status === 'fulfilled' ? { adapters: adapters.value.modelAdapters } : {}),
          ...(runtime.status === 'fulfilled' && runtime.value.bundles
            ? { bundles: runtime.value.bundles }
            : {}),
          ...(config.status === 'fulfilled' ? { accounts: config.value.accounts ?? [] } : {}),
        })
      },
    }),
    [data],
  )
  const tab = TRIGGERS_TAB ? tabOf(context.selection) : 'schedules'
  const tabs = [
    { key: 'schedules', label: ux('tabSchedules') },
    ...(TRIGGERS_TAB ? [{ key: 'triggers', label: ux('tabTriggers') }] : []),
  ]
  return (
    <HomePageFrame
      id="automation"
      title={context.t('home.entry.automation')}
      // New and edit open as pages inside this one: Automation › New scheduled task.
      pushTitle={context.t('home.entry.automation')}
      // The sentence names only what the page offers: with the triggers tab hidden, no event entry.
      description={ux(TRIGGERS_TAB ? 'pageDescription' : 'schedulesDescription')}
      actions={<div className="home-page-action-slot" ref={setActionsHost} />}
      // A bar of one tab is noise; it comes back with the second tab.
      {...(tabs.length > 1
        ? {
            tabs: (
              <Tabs
                activeKey={tab}
                aria-label={ux('tabs')}
                onChange={(key) => homeNavigation.open('automation', { tab: key })}
                items={tabs}
              />
            ),
          }
        : {})}
    >
      {tab === 'schedules' ? (
        <SchedulesPage api={schedules} t={t} actionsHost={actionsHost} />
      ) : (
        <TriggersPanel canSave={canEffect(admin, 'packages.activate')} actionsHost={actionsHost} />
      )}
    </HomePageFrame>
  )
}
