import type { UITimeline } from '@agnes/protocol'
import type { GoalSnapshot, StatusLinePayload } from '@agnes/protocol/gen/slots'
import { conversationCards } from '@agnes/web-client'
import {
  Button,
  ConversationCardLayout,
  Field,
  renderRegion,
  SettingsInput,
  SettingsTextArea,
} from '@agnes/web-ui'
import type { ComponentProps } from 'react'
import { useState } from 'react'
import { RegisteredConversationCard } from './conversation-registry.js'
import { tr } from './locale-bridge.js'

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
  const [objective, setObjective] = useState(goal?.objective ?? '')
  const [rounds, setRounds] = useState(goal?.maxRounds ?? 10)
  const [budget, setBudget] = useState(goal?.budgetCredits?.toString() ?? '')
  const action = (op: string) => onCommand(`/goal ${op}`)
  const reasonKeys: Record<string, string> = {
    'Credit usage unavailable': 'goal.reason.usageUnavailable',
    'Credit budget exhausted': 'goal.reason.budgetExhausted',
    'Maximum automatic rounds reached': 'goal.reason.roundLimit',
    'Automatic continuation unavailable on this host': 'goal.reason.continuationUnavailable',
  }
  return (
    <ConversationCardLayout
      as="section"
      className="goal-card"
      data-testid="goal-bar"
      aria-label={tr('goal.title')}
    >
      <Button htmlType="button" data-testid="goal-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {goal
          ? tr(`goal.state.${goal.phase}`) +
            ' · ' +
            goal.rounds +
            '/' +
            goal.maxRounds +
            ' · ' +
            goal.objective
          : tr('goal.create')}
      </Button>
      {goal?.reason && (
        <p role="status" data-testid="goal-reason">
          {reasonKeys[goal.reason] ? tr(reasonKeys[goal.reason] ?? '') : goal.reason}
        </p>
      )}
      {error && <p role="status">{tr('goal.error')}</p>}
      {open && (
        <div data-testid="goal-card">
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
          {goal && (
            <div className="goal-actions">
              {goal.phase === 'active' && (
                <Button
                  htmlType="button"
                  disabled={disabled}
                  data-testid="goal-pause"
                  onClick={() => action('pause')}
                >
                  {tr('goal.pause')}
                </Button>
              )}
              {(goal.phase === 'paused' || goal.phase === 'blocked') && (
                <Button
                  htmlType="button"
                  disabled={disabled}
                  data-testid="goal-resume"
                  onClick={() => action('resume')}
                >
                  {tr('goal.resume')}
                </Button>
              )}
              {goal.phase !== 'complete' && (
                <Button
                  htmlType="button"
                  disabled={disabled}
                  data-testid="goal-complete"
                  onClick={() => action('complete')}
                >
                  {tr('goal.complete')}
                </Button>
              )}
              <Button
                htmlType="button"
                disabled={disabled}
                data-testid="goal-clear"
                onClick={() => action('clear')}
              >
                {tr('goal.clear')}
              </Button>
            </div>
          )}
          {goal && (
            <p>
              {tr('goal.spent')}{' '}
              {goal.creditsUsed.toLocaleString(document.documentElement.lang || 'en', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
              {goal.budgetCredits === undefined
                ? ''
                : ` / ${goal.budgetCredits.toLocaleString(document.documentElement.lang || 'en')}`}
            </p>
          )}
        </div>
      )}
    </ConversationCardLayout>
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
