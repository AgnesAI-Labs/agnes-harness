import type { UITimeline } from '@agnes/protocol'
import type { GoalSnapshot } from '@agnes/protocol/gen/slots'
import { goalCommand } from '@agnes/web-client'
import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  Button,
  ConversationCardLayout,
  Field,
  Popover,
  SettingsInput,
  SettingsState,
  SettingsTextArea,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { GoalActions } from './goal-actions.js'
import { renderSessionActions } from './registered-card.js'

export { readGoal as goalSlot } from '@agnes/web-client'

export function GoalCard({
  goal,
  error,
  disabled,
  onCommand,
  t = tr,
  registerShow,
}: {
  goal?: GoalSnapshot | undefined
  error?: string | undefined
  disabled: boolean
  onCommand(command: string): void
  t?: typeof tr
  registerShow?: (show: () => void) => () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(
    () =>
      registerShow?.(() => {
        setOpen(true)
        trigger.current?.focus()
      }),
    [registerShow],
  )
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('keydown', close, true)
    return () => document.removeEventListener('keydown', close, true)
  }, [open])
  const [objective, setObjective] = useState(goal?.objective ?? '')
  const [rounds, setRounds] = useState(goal?.maxRounds ?? 10)
  const [budget, setBudget] = useState(goal?.budgetCredits?.toString() ?? '')
  return (
    <span data-testid="goal-bar">
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomRight"
        content={
          <ConversationCardLayout
            as="section"
            variant="plain"
            className="goal-card"
            data-testid="goal-card"
            aria-label={t('goal.title')}
          >
            {error && (
              <SettingsState tone="error" role="status">
                {t('goal.error')}
              </SettingsState>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!objective.trim()) return
                onCommand(
                  goalCommand({
                    action: goal ? 'edit' : 'create',
                    objective,
                    maxRounds: rounds,
                    ...(budget ? { budgetCredits: Number(budget) } : {}),
                  }),
                )
              }}
            >
              <Field label={t('goal.objective')}>
                <SettingsTextArea
                  data-testid="goal-objective"
                  value={objective}
                  maxLength={8192}
                  required
                  disabled={disabled}
                  onChange={(event) => setObjective(event.target.value)}
                />
              </Field>
              <Field label={t('goal.rounds')}>
                <SettingsInput
                  data-testid="goal-max-rounds"
                  type="number"
                  min={1}
                  max={100}
                  required
                  disabled={disabled}
                  value={rounds}
                  onChange={(event) => setRounds(Number(event.target.value))}
                />
              </Field>
              <Field label={t('goal.budget')}>
                <SettingsInput
                  data-testid="goal-budget"
                  type="number"
                  min={0.000001}
                  step="any"
                  disabled={disabled}
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
              </Field>
              <Button htmlType="submit" type="primary" disabled={disabled} data-testid="goal-save">
                {t(goal ? 'goal.edit' : 'goal.create')}
              </Button>
            </form>
            {goal && <GoalActions goal={goal} disabled={disabled} onCommand={onCommand} t={t} />}
          </ConversationCardLayout>
        }
      >
        <Button
          ref={trigger}
          htmlType="button"
          type="text"
          size="small"
          data-testid="goal-toggle"
          data-agnes-region="session-goal-action"
          aria-expanded={open}
          aria-label={t('goal.title')}
        >
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {t(goal ? `goal.state.${goal.phase}` : 'goal.create')}
        </Button>
      </Popover>
    </span>
  )
}

/** Compatibility renderer for embedders; registration belongs to the feature client. */
export function renderGoalCard(
  host: HTMLElement,
  timeline: UITimeline | undefined,
  disabled: boolean,
  onCommand: (command: string) => void,
) {
  renderSessionActions(host, timeline, disabled, onCommand, tr)
}
