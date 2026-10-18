import type { AgentPlan } from '@agnes/protocol'
import { AGENTS_NAMESPACE, agentsCatalog } from '@agnes/web-admin/agents'
import { Button, SettingsGroup, SettingsItem, useUiText } from '@agnes/web-ui'

/** Everything here comes from the ticket presentation, rather than the catalog card. */
export function AgentLaunchReview({ plan, onConfirm }: { plan: AgentPlan; onConfirm(): void }) {
  const { t, locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  return (
    <section data-testid="agent-launch-review">
      <SettingsGroup>
        <SettingsItem label={plan.launch.title[locale] ?? plan.launch.title.en} description={plan.ref} />
        <SettingsItem label={t('launch.model')} description={JSON.stringify(plan.models)} />
        <SettingsItem label={t('launch.permission')} description={JSON.stringify(plan.permission)} />
        <SettingsItem
          label={t('launch.sources')}
          description={plan.sources.map((item) => `${item.id}@${item.version} ${item.integrity}`).join(', ')}
        />
        {plan.launch.prompt && (
          <SettingsItem
            label={t('launch.draft')}
            description={plan.launch.prompt.text[locale] ?? plan.launch.prompt.text.en}
          />
        )}
      </SettingsGroup>
      <Button data-testid="agent-launch-confirm" onClick={onConfirm}>
        {t('action.session')}
      </Button>
    </section>
  )
}
