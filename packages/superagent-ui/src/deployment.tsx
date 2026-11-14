/**
 * Deployment settings view of the panel Settings tab: the machine-level values Superagent runs with, as they are now.
 * They live in the plugin configuration of AGH, which the plugins page edits; the panel shows them and links there.
 */
import type { SetupView } from './api.js'
import { InfoTip } from './controls.js'
import { usePanel } from './provider.js'
import { Field, Fields } from './settings-kit.js'
import { setupText } from './text.js'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets.js'

/** The plugins page of AGH, on the Superagent plugin. */
export const PLUGIN_PAGE = '?page=plugins&tab=plugins&view=plugin%3A%40agnes%2Fsuperagent'

export function DeploymentPage({ setup }: { setup: SetupView }) {
  const { t } = usePanel()
  const accounts = setup.accounts
  const { machine } = setup
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return (
    <div className="dt-form">
      <Fields disabled>
        <Hint>{t('deploymentIntro')}</Hint>
        {setup.problem && (
          <div className="dt-row-buttons">
            <p className="dt-error" role="status">
              <SetupMessage problem={setup.problem} lead />
            </p>
            <CheckSetupButton />
          </div>
        )}
        <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
          <KeyValues
            rows={[
              [t('deploymentRepository'), accounts?.repository ?? '—'],
              [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'],
              [t('deploymentFeishu'), feishu],
            ]}
          />
          <Hint>{t('deploymentAccountsWhere')}</Hint>
        </Section>
        <Section title={t('deploymentMachine')}>
          <div className="dt-field">
            <span className="dt-field-head">
              {t('deploymentStateDir')}
              <InfoTip text={t('deploymentStateDirHint')} />
            </span>
            <span className="dt-mono">{machine.stateDir}</span>
          </div>
        </Section>
        <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
          <Field label={t('deploymentPromptMaxChars')}>
            <span className="dt-mono">{machine.promptMaxChars}</span>
          </Field>
          <Field label={t('deploymentContextPages')}>
            <span className="dt-mono">{machine.admissionContextMaxPages}</span>
          </Field>
          <Field label={t('deploymentContextTimeout')}>
            <span className="dt-mono">{machine.admissionContextTimeoutMs}</span>
          </Field>
        </Section>
      </Fields>
      <p className="dt-hint">
        <a href={PLUGIN_PAGE}>{t('deploymentConfigure')}</a>
      </p>
    </div>
  )
}
