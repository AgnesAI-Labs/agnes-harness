import type { ApplicationState } from '@agnes/protocol'
import { resolveApplicationBrand } from '@agnes/web-client'
import { SettingsCode, SettingsTechnicalDetails, useDocumentLanguage } from '@agnes/web-ui'
import { navigationLabels } from './application-preview.js'

/** Human identity and effects first; the exact saved projection remains available for diagnosis. */
export function ApplicationSummary({ state }: { state: ApplicationState | undefined }) {
  const language = useDocumentLanguage()
  const tr = (en: string, zh: string) => (language === 'zh-CN' ? zh : en)
  return (
    <>
      <p>
        {tr('Current application', '当前应用')}:{' '}
        {state?.effective ? resolveApplicationBrand(state.effective, language).name : 'Agnes Harness'}
      </p>
      {state?.status === 'unresolved' && (
        <p role="status">
          {tr(
            'This application is unavailable; showing the official interface.',
            '此应用暂不可用，已显示官方界面。',
          )}
        </p>
      )}
      {state?.selection && (
        <p>
          {tr('Version', '版本')}:{' '}
          {state.candidates.find((item) => item.packageId === state.selection?.packageId)?.version ??
            state.selection.consentSnapshot?.version ??
            tr('Unavailable', '暂不可读取')}
        </p>
      )}
      <p>
        {state?.effective
          ? tr(
              'This application controls the home page, navigation and agent choices. You can restore the official interface below.',
              '当前应用决定首页、导航与智能体选项，可随时在下方恢复官方界面。',
            )
          : tr('Using the official home page, navigation and agents.', '正在使用官方首页、导航和智能体。')}
      </p>
      {state?.effective && (
        <p data-testid="application-changes">
          {tr('Interface changes', '界面变化')}:{' '}
          {state.effective.presentation?.home
            ? tr('Application home page', '应用首页')
            : tr('Official home page', '官方首页')}
          {state.effective.presentation?.navigation?.hideBuiltin?.length
            ? ` · ${tr('Hidden navigation', '隐藏导航')}: ${[...new Set(state.effective.presentation.navigation.hideBuiltin.map((id) => tr(...(navigationLabels[id] ?? [id, id]))))].join(', ')}`
            : ''}
          {state.effective.agents
            ? ` · ${tr('Available agents', '可选智能体')}: ${state.effective.agents.length}`
            : ''}
        </p>
      )}
      {state?.effective && (
        <SettingsTechnicalDetails title={tr('Technical details', '技术详情')}>
          <SettingsCode
            label={tr('Current presentation', '当前展示')}
            copy={JSON.stringify(state.effective, null, 2)}
          >
            {JSON.stringify(state.effective, null, 2)}
          </SettingsCode>
        </SettingsTechnicalDetails>
      )}
    </>
  )
}
