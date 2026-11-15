/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
import type { StateView } from './api.js'
import { DeploymentPage } from './deployment.js'
import { EvalSettings } from './eval.js'
import { ExecutionSettings } from './execution.js'
import { PromptsPage } from './prompts.js'
import { usePanel } from './provider.js'
import { SETTINGS_GROUPS, type SettingsGroup, settingsRoute } from './route.js'
import { SettingsProvider } from './settings-kit.js'
import { SourceSettings } from './source.js'

const STAGE_GROUPS: readonly SettingsGroup[] = ['source', 'eval', 'execution']
export function SettingsPage({
  group,
  query,
  state,
}: {
  group: SettingsGroup
  query: { source?: string | undefined; version?: string | undefined }
  state: StateView
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'source':
        return (
          <SettingsProvider>
            <SourceSettings {...(query.source ? { focus: query.source } : {})} />
          </SettingsProvider>
        )
      case 'eval':
        return (
          <SettingsProvider>
            <EvalSettings version={query.version} />
          </SettingsProvider>
        )
      case 'execution':
        return (
          <SettingsProvider>
            <ExecutionSettings />
          </SettingsProvider>
        )
      case 'prompts':
        return <PromptsPage />
      case 'deployment':
        return <DeploymentPage setup={state.setup} />
    }
  })()
  return (
    <div className="dt-settings">
      <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
        {SETTINGS_GROUPS.map((value) => (
          <button
            key={value}
            type="button"
            className="dt-settings-link"
            data-stage={STAGE_GROUPS.includes(value) || undefined}
            aria-current={value === group ? 'page' : undefined}
            onClick={() => navigate(settingsRoute(value), true)}
          >
            {t(`settingsGroup.${value}`)}
          </button>
        ))}
      </nav>
      <div className="dt-settings-body">
        <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
        {content}
      </div>
    </div>
  )
}
