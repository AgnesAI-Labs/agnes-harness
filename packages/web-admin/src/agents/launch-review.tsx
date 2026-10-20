import type { AgentPlan } from '@agnes/protocol'
import {
  Button,
  SettingsCode,
  SettingsGroup,
  SettingsItem,
  SettingsTechnicalDetails,
  useUiText,
} from '@agnes/web-ui'
import { AGENTS_NAMESPACE, agentsCatalog } from './agents-locale.js'

/** Human consent summary; the original ticket payload remains available on demand. */
export function AgentLaunchReview({
  plan,
  onConfirm,
  onCancel,
  cancelTestId,
  draft,
  consent,
  object,
  changes,
}: {
  plan: AgentPlan
  onConfirm(): void
  onCancel(): void
  cancelTestId?: string | undefined
  draft?: string | undefined
  consent?: 'covered' | 'changed' | 'unavailable' | undefined
  object?: string | undefined
  changes?: string[] | undefined
}) {
  const { t, locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const tr = (en: string, zh: string) => (locale === 'zh-CN' ? zh : en)
  const raw = JSON.stringify(plan, null, 2)
  return (
    <section data-testid="agent-launch-review">
      <p>
        {consent === 'changed'
          ? tr(
              'The application or its launch access has changed since adoption. Review this conversation before starting.',
              '应用或启动权限已较采用时变化，请确认本次对话。',
            )
          : consent === 'covered'
            ? tr(
                'Application consent already covers this configuration. Confirm the task before opening a conversation.',
                '应用同意已覆盖当前配置，请确认本次任务后打开对话。',
              )
            : tr(
                'This launch is not covered by a current application consent. Review the agent and access before starting.',
                '本次启动尚未被当前应用同意覆盖，请确认智能体和权限。',
              )}
      </p>
      {consent === 'changed' && (
        <p>
          {(changes ?? ['configuration'])
            .map((change) =>
              change === 'sources'
                ? tr('Plugin versions, content or capabilities changed.', '插件版本、内容或能力已变化。')
                : change === 'permissions'
                  ? tr('The tools or permissions differ from adoption.', '工具或权限与采用时不同。')
                  : change === 'application'
                    ? tr('The adopted application is no longer current.', '已采用的应用不再是当前版本。')
                    : tr('The running configuration differs from adoption.', '运行配置与采用时不同。'),
            )
            .join(' ')}
        </p>
      )}
      <SettingsGroup>
        <SettingsItem
          label={tr('Agent', '智能体')}
          description={plan.launch.title[locale] ?? plan.launch.title.en}
        />
        <SettingsItem
          label={tr('Task', '任务')}
          description={plan.launch.description[locale] ?? plan.launch.description.en}
        />
        {object && <SettingsItem label={tr('Object', '对象')} description={object} />}
        <SettingsItem
          label={tr('Access', '权限')}
          description={
            plan.permission.readOnly
              ? tr(
                  'Read-only tools. Existing runtime restrictions and approvals still apply.',
                  '只读工具。仍遵循现有运行限制与审批。',
                )
              : tr(
                  'Tools may change data. Existing runtime restrictions and approvals still apply.',
                  '工具可能修改数据。仍遵循现有运行限制与审批。',
                )
          }
        />
        <SettingsItem
          label={tr('Next', '下一步')}
          description={tr(
            'Open a conversation with an editable request. Send it when ready.',
            '打开对话并填写可编辑请求，准备好后再发送。',
          )}
        />
        {draft && <SettingsItem label={t('launch.draft')} description={draft} />}
      </SettingsGroup>
      <SettingsTechnicalDetails title={tr('Technical details', '技术详情')} data-testid="launch-technical">
        <SettingsCode label={tr('Reviewed launch configuration', '已审阅的启动配置')} copy={raw}>
          {raw}
        </SettingsCode>
      </SettingsTechnicalDetails>
      <div className="home-push-actions">
        <Button data-testid={cancelTestId} onClick={onCancel}>
          {t('dialog.cancel')}
        </Button>
        <Button appearance="primary" data-testid="agent-launch-confirm" onClick={onConfirm}>
          {t('action.session')}
        </Button>
      </div>
    </section>
  )
}
