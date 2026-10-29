import type { ApplicationState } from '@agnes/protocol'
import { resolveApplicationBrand } from '@agnes/web-client'
import {
  SettingsCode,
  SettingsGroup,
  SettingsItem,
  SettingsSection,
  SettingsTechnicalDetails,
  useDocumentLanguage,
} from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { navigationLabels } from './application-preview.js'

/** Current identity and effects use the same grouped rows as the other settings panes. */
export function ApplicationSummary({ state, restore }: { state: ApplicationState; restore: ReactNode }) {
  const language = useDocumentLanguage()
  const tr = (en: string, zh: string) => (language === 'zh-CN' ? zh : en)
  const app = state.effective
  const name = resolveApplicationBrand(app ?? undefined, language).name
  const version =
    state.candidates.find((item) => item.packageId === state.selection?.packageId)?.version ??
    state.selection?.consentSnapshot?.version
  const hidden = [
    ...new Set(
      app?.presentation?.navigation?.hideBuiltin?.map((id) => tr(...(navigationLabels[id] ?? [id, id]))),
    ),
  ]
  return (
    <>
      <SettingsSection title={tr('Current application', '当前应用')} data-testid="application-current">
        <SettingsGroup>
          <SettingsItem
            icon="puzzle"
            label={
              <>
                {name}
                {version && <span className="application-version">{version}</span>}
              </>
            }
            description={
              app
                ? tr(
                    'Your application home page, navigation and agent choices.',
                    '使用应用的首页、导航和智能体选项。',
                  )
                : tr('The official home page, navigation and agents.', '使用官方首页、导航和智能体。')
            }
          >
            {restore}
          </SettingsItem>
        </SettingsGroup>
        {state.status === 'unresolved' && (
          <p role="status">
            {tr(
              'This application is unavailable; showing the official interface.',
              '此应用暂不可用，已显示官方界面。',
            )}
          </p>
        )}
      </SettingsSection>
      {app && (
        <SettingsSection title={tr('What it changes', '界面变化')}>
          <SettingsGroup data-testid="application-changes">
            <SettingsItem
              label={tr('Home page', '首页')}
              description={
                app.presentation?.home
                  ? tr('Application home page', '应用首页')
                  : tr('Official home page', '官方首页')
              }
            />
            <SettingsItem
              label={tr('Hidden navigation', '隐藏导航')}
              description={hidden.join(', ') || tr('None', '无')}
            />
            <SettingsItem
              label={tr('Available agents', '可选智能体')}
              description={
                app.agents
                  ? tr(`${app.agents.length} chosen by the application`, `应用指定 ${app.agents.length} 个`)
                  : tr('All available agents', '全部可用智能体')
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}
      {app && (
        <SettingsTechnicalDetails title={tr('Technical details', '技术详情')}>
          <SettingsCode label={tr('Current presentation', '当前展示')} copy={JSON.stringify(app, null, 2)}>
            {JSON.stringify(app, null, 2)}
          </SettingsCode>
        </SettingsTechnicalDetails>
      )}
    </>
  )
}
