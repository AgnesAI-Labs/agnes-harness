import type { UITimeline } from '@agnes/protocol'
import type { GoalSnapshot, StatusLinePayload } from '@agnes/protocol/gen/slots'
import { renderRegion } from '@agnes/web-ui'
import { useState } from 'react'
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
  return (
    <section className="goal-card" data-testid="goal-bar" aria-label={tr('goal.title')}>
      <button type="button" data-testid="goal-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {goal
          ? tr(`goal.state.${goal.phase}`) +
            ' · ' +
            goal.rounds +
            '/' +
            goal.maxRounds +
            ' · ' +
            goal.objective
          : tr('goal.create')}
      </button>
      {goal?.reason && (
        <p role="status" data-testid="goal-reason">
          {goal.reason}
        </p>
      )}
      {error && <p role="status">{error}</p>}
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
            <label>
              {tr('goal.objective')}
              <textarea
                data-testid="goal-objective"
                value={objective}
                maxLength={8192}
                required
                disabled={disabled}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>
            <label>
              {tr('goal.rounds')}
              <input
                data-testid="goal-max-rounds"
                type="number"
                min={1}
                max={100}
                required
                disabled={disabled}
                value={rounds}
                onChange={(event) => setRounds(Number(event.target.value))}
              />
            </label>
            <label>
              {tr('goal.budget')}
              <input
                data-testid="goal-budget"
                type="number"
                min={0.000001}
                step="any"
                disabled={disabled}
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </label>
            <button type="submit" disabled={disabled} data-testid="goal-save">
              {tr(goal ? 'goal.edit' : 'goal.create')}
            </button>
          </form>
          {goal && (
            <div className="goal-actions">
              {goal.phase === 'active' && (
                <button
                  type="button"
                  disabled={disabled}
                  data-testid="goal-pause"
                  onClick={() => action('pause')}
                >
                  {tr('goal.pause')}
                </button>
              )}
              {(goal.phase === 'paused' || goal.phase === 'blocked') && (
                <button
                  type="button"
                  disabled={disabled}
                  data-testid="goal-resume"
                  onClick={() => action('resume')}
                >
                  {tr('goal.resume')}
                </button>
              )}
              {goal.phase !== 'complete' && (
                <button
                  type="button"
                  disabled={disabled}
                  data-testid="goal-complete"
                  onClick={() => action('complete')}
                >
                  {tr('goal.complete')}
                </button>
              )}
              <button
                type="button"
                disabled={disabled}
                data-testid="goal-clear"
                onClick={() => action('clear')}
              >
                {tr('goal.clear')}
              </button>
            </div>
          )}
          {goal && (
            <p>
              {tr('goal.spent')} {goal.creditsUsed.toFixed(2)}
              {goal.budgetCredits === undefined ? '' : ` / ${goal.budgetCredits}`}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export function renderGoalCard(
  host: HTMLElement,
  timeline: UITimeline | undefined,
  disabled: boolean,
  onCommand: (command: string) => void,
) {
  const slot = goalSlot(timeline)
  renderRegion(
    host,
    <GoalCard
      key={`${timeline?.sessionId ?? 'draft'}:${slot?.goal?.id ?? 'new'}`}
      goal={slot?.goal}
      error={slot?.level === 'warn' && !slot.goal?.reason ? slot.text : undefined}
      disabled={disabled}
      onCommand={onCommand}
    />,
  )
}
