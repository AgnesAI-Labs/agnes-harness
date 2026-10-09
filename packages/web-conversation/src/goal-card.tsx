import type { UITimeline } from '@agnes/protocol'
import type { GoalSnapshot, StatusLinePayload } from '@agnes/protocol/gen/slots'
import { conversationCards } from '@agnes/web-client'
import { tr } from '@agnes/web-foundation/locale-bridge'
import {
  Button,
  ConversationCardLayout,
  Field,
  Popover,
  renderRegion,
  SettingsInput,
  SettingsState,
  SettingsTextArea,
} from '@agnes/web-ui'
import type { ComponentProps } from 'react'
import { useEffect, useRef, useState } from 'react'
import { RegisteredConversationCard } from './conversation-registry.js'
import { GoalActions } from './goal-actions.js'

export function goalSlot(timeline?: UITimeline): StatusLinePayload | undefined {
  const live = timeline?.slots?.find((fill) => fill.extId === 'agnes/goal' && fill.slot === 'status.line')
  if (live) return live.payload as StatusLinePayload
  for (const node of [...(timeline?.nodes ?? [])].reverse())
    if (node.kind === 'slot' && node.fill.extId === 'agnes/goal' && node.fill.slot === 'status.line')
      return node.fill.payload as StatusLinePayload
  return undefined
}

export function GoalCard({
  goal,
  error,
  disabled,
  onCommand,
}: {
  goal?: GoalSnapshot | undefined
  error?: string | undefined
  disabled: boolean
  onCommand(command: string): void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
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
            aria-label={tr('goal.title')}
          >
            {error && (
              <SettingsState tone="error" role="status">
                {tr('goal.error')}
              </SettingsState>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (!objective.trim()) return
                onCommand(
                  '/goal ' +
                    (goal ? 'edit' : 'create') +
                    ' --max-rounds ' +
                    rounds +
                    ` --budget ${budget || 'none'}` +
                    ' ' +
                    objective.trim(),
                )
              }}
            >
              <Field label={tr('goal.objective')}>
                <SettingsTextArea
                  data-testid="goal-objective"
                  value={objective}
                  maxLength={8192}
                  required
                  disabled={disabled}
                  onChange={(event) => setObjective(event.target.value)}
                />
              </Field>
              <Field label={tr('goal.rounds')}>
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
              <Field label={tr('goal.budget')}>
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
                {tr(goal ? 'goal.edit' : 'goal.create')}
              </Button>
            </form>
            {goal && <GoalActions goal={goal} disabled={disabled} onCommand={onCommand} t={tr} />}
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
          aria-label={tr('goal.title')}
        >
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {tr(goal ? `goal.state.${goal.phase}` : 'goal.create')}
        </Button>
      </Popover>
    </span>
  )
}

if (!conversationCards.get('goal'))
  conversationCards.register({
    id: 'goal',
    order: 0,
    matches: (card) => card.kind === 'goal',
    component: ({ card }) => <GoalCard {...(card.data as ComponentProps<typeof GoalCard>)} />,
  })

export function renderGoalCard(
  host: HTMLElement,
  timeline: UITimeline | undefined,
  disabled: boolean,
  onCommand: (command: string) => void,
) {
  host.hidden = !timeline?.sessionId
  if (!timeline?.sessionId) {
    renderRegion(host, null)
    return
  }
  const slot = goalSlot(timeline)
  renderRegion(
    host,
    <RegisteredConversationCard
      key={`${timeline.sessionId}:${slot?.goal?.id ?? 'new'}`}
      card={{
        kind: 'goal',
        data: {
          goal: slot?.goal,
          error: slot?.level === 'warn' && !slot.goal?.reason ? slot.text : undefined,
          disabled,
          onCommand,
        },
      }}
      context={{ t: tr }}
    />,
  )
}
