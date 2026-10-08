import type { GoalSnapshot } from '@agnes/protocol/gen/slots'
import type { UiExtensionContext } from '@agnes/web-client'
import { Button } from '@agnes/web-ui'

const reasons: Record<string, string> = {
  'Credit usage unavailable': 'goal.reason.usageUnavailable',
  'Credit budget exhausted': 'goal.reason.budgetExhausted',
  'Maximum automatic rounds reached': 'goal.reason.roundLimit',
  'Automatic continuation unavailable on this host': 'goal.reason.continuationUnavailable',
}
export const goalReasonKey = (reason: string) => reasons[reason] ?? 'goal.reason.other'

/** Both goal surfaces use the existing human slash-command authorization path. */
export function GoalActions({
  goal,
  disabled,
  onCommand,
  t,
  prefix = 'goal',
}: {
  goal: GoalSnapshot
  disabled: boolean
  onCommand(command: string): void
  t: UiExtensionContext['t']
  prefix?: string
}) {
  const actions = [
    ...(goal.phase === 'active' ? ['pause'] : []),
    ...(goal.phase === 'paused' || goal.phase === 'blocked' ? ['resume'] : []),
    ...(goal.phase !== 'complete' ? ['complete'] : []),
    'clear',
  ]
  return (
    <div className="goal-actions">
      {actions.map((action) => (
        <Button
          key={action}
          htmlType="button"
          disabled={disabled}
          data-testid={`${prefix}-${action}`}
          onClick={() => onCommand(`/goal ${action}`)}
        >
          {t(`goal.${action}`)}
        </Button>
      ))}
    </div>
  )
}
