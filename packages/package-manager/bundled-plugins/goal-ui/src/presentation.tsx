import type { UITimeline } from '@agnes/protocol'
import { type ClientContext, readGoal } from '@agnes/web-client'
import { GoalCard, GoalPanel, workbenchLocaleCatalog } from '@agnes/web-conversation/goal-renderers'
import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'

export const inject = ['slots', 'session', 'locale']
export function apply(ctx: ClientContext) {
  return ctx.presentationRoles.register({
    role: 'goal',
    priority: 100,
    mount(ctx) {
      let show: (() => void) | undefined
      const registerShow = (callback: () => void) => {
        show = callback
        return () => {
          if (show === callback) show = undefined
        }
      }
      const off = [
        ctx.composerCommands.register({
          id: 'goal',
          order: 0,
          route({ text, busy, sessionId }) {
            if (!sessionId || !/^\/goal(?:\s|$)/.test(text)) return undefined
            if (/^\/goal(?:\s+show)?$/.test(text) && show) {
              show()
              return 'handled'
            }
            return busy ? 'steer' : undefined
          },
        }),
        ctx.locale.register('goal.presentation', webLocaleCatalog),
        ctx.locale.register('goal.workbench', workbenchLocaleCatalog),
        ctx.conversationCards.register({
          id: 'goal',
          order: 0,
          matches: (card) => card.kind === 'session.actions',
          component: ({ card, context }) => {
            const { timeline, disabled, command } = card.data as {
              timeline: UITimeline
              disabled: boolean
              command(command: string): void
            }
            const slot = readGoal(timeline)
            return (
              <GoalCard
                key={`${timeline.sessionId}:${slot?.goal?.id ?? 'new'}`}
                goal={slot?.goal}
                error={slot?.level === 'warn' && !slot.goal?.reason ? slot.text : undefined}
                disabled={disabled}
                onCommand={command}
                t={context.t}
                registerShow={registerShow}
              />
            )
          },
        }),
        ctx.workbenchPanels.register({
          id: 'goal',
          order: 60,
          edge: 'right',
          titleKey: 'workbench.goal.title',
          visibility: 'contextual',
          when: (context) =>
            !!readGoal((context.data as { timeline?: UITimeline } | undefined)?.timeline)?.goal,
          component: GoalPanel,
        }),
      ]
      return () => {
        for (const stop of off.reverse()) stop()
      }
    },
  })
}
