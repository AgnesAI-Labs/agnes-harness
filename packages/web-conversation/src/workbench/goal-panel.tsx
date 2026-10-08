import type { UiExtensionContext } from '@agnes/web-client'
import { SettingsState } from '@agnes/web-ui'
import { GoalActions, goalReasonKey } from '../goal-actions.js'
import { goalSlot } from '../goal-card.js'
import { panelContext } from './context.js'

/** The live status slot is the durable goal projection; there is no separate step list. */
export function GoalPanel({ context }: { context: UiExtensionContext }) {
  const { timeline, disabled, command } = panelContext(context),
    { t } = context
  const slot = goalSlot(timeline),
    goal = slot?.goal
  const number = (value: number) =>
    value.toLocaleString(document.documentElement.lang || 'en', {
      maximumFractionDigits: 2,
    })
  return (
    <section className="workbench-goal" data-testid="goal-panel" aria-label={t('workbench.goal.title')}>
      {slot?.level === 'warn' && !goal?.reason && (
        <SettingsState tone="error">{t('goal.error')}</SettingsState>
      )}
      {!timeline?.sessionId ? (
        <SettingsState tone="empty">{t('workbench.session')}</SettingsState>
      ) : !goal ? (
        <SettingsState tone="empty">{t('workbench.goal.empty')}</SettingsState>
      ) : (
        <>
          <p
            className="workbench-goal-phase"
            role="status"
            data-testid="goal-panel-phase"
            data-phase={goal.phase}
          >
            {t(`goal.state.${goal.phase}`)}
          </p>
          <h2 data-testid="goal-panel-objective">{goal.objective}</h2>
          <p data-testid="goal-panel-progress">
            {t('goal.progress', { rounds: goal.rounds, maxRounds: goal.maxRounds })}
          </p>
          <dl className="workbench-goal-usage">
            <dt>{t('workbench.goal.used')}</dt>
            <dd>{number(goal.creditsUsed)}</dd>
            <dt>{t('workbench.goal.budget')}</dt>
            <dd>
              {goal.budgetCredits === undefined ? t('workbench.goal.unlimited') : number(goal.budgetCredits)}
            </dd>
          </dl>
          {goal.reason && (
            <p role="status" data-testid="goal-reason">
              {t(goalReasonKey(goal.reason))}
            </p>
          )}
          <GoalActions goal={goal} disabled={disabled} onCommand={command} t={t} prefix="goal-panel" />
          <details className="workbench-goal-details">
            <summary>{t('workbench.goal.details')}</summary>
            <dl>
              <dt>{t('workbench.goal.id')}</dt>
              <dd>{goal.id}</dd>
              <dt>{t('workbench.goal.revision')}</dt>
              <dd>{goal.revision}</dd>
            </dl>
          </details>
        </>
      )}
    </section>
  )
}
