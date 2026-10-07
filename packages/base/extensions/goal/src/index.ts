import { defineExtension, defineTool, type ProjectionReader } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { CONTINUE_PREFIX, type GoalState, goalProjection } from './state.js'

export { goalProjection } from './state.js'

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'idempotent' as const,
  costHint: {},
  deferLoading: false,
  requiresApproval: 'never' as const,
}
export default defineExtension((agnes) => {
  const read = async (ctx: { projections: ProjectionReader }) => {
    const result = await ctx.projections.readOwn<GoalState>('goal')
    if (result.status !== 'available') throw new Error('Goal persistence unavailable')
    return result.value
  }
  const update = async (state: GoalState, phase: 'blocked' | 'complete', reason: string) => {
    if (!state.goal) throw new Error('No goal exists in this session')
    await agnes.events.append('updated', { id: state.goal.id, revision: state.goal.revision, phase, reason })
  }
  const disposers = [agnes.registerProjection(goalProjection)]
  disposers.push(
    agnes.registerTool(
      defineTool({
        name: 'goal_get',
        description: 'Read the persistent session goal, status, automatic rounds, credit budget and blocker.',
        parameters: Type.Object({}, { additionalProperties: false }),
        meta,
        async execute(_args, ctx) {
          const goal = (await read(ctx)).goal
          return { content: [{ type: 'text', text: JSON.stringify(goal) }], details: { goal } }
        },
      }),
    ),
    agnes.registerTool(
      defineTool({
        name: 'goal_update',
        description:
          'Mark the existing goal complete only when achieved, or blocked when unable to progress. Give a concrete reason. Only the human can create, edit, pause, resume or clear goals.',
        parameters: Type.Object(
          {
            status: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]),
            reason: Type.String({ minLength: 1, maxLength: 2048 }),
          },
          { additionalProperties: false },
        ),
        meta: { ...meta, isReadOnly: false },
        async execute(args, ctx) {
          const state = await read(ctx)
          if (state.goal?.phase === args.status && state.goal.reason === args.reason.trim())
            return { content: [{ type: 'text', text: `Goal ${args.status}: ${args.reason.trim()}` }] }
          if (!args.reason.trim() || !state.goal || state.goal.phase !== 'active')
            return {
              content: [{ type: 'text', text: 'An active goal and a nonempty reason are required.' }],
              isError: true,
            }
          await update(state, args.status, args.reason.trim())
          return { content: [{ type: 'text', text: `Goal ${args.status}: ${args.reason.trim()}` }] }
        },
      }),
    ),
  )
  disposers.push(
    agnes.registerHook('session_start', async (payload, ctx) => {
      if (payload.reason === 'resume' && (await read(ctx)).goal?.phase === 'active')
        await agnes.events.append('paused', {})
    }),
  )
  disposers.push(
    agnes.registerHook('before_step', async (payload, ctx) => {
      const state = await read(ctx),
        g = state.goal
      if (state.input && (!state.input.run || (state.input.automatic && g?.phase !== 'active')))
        return { park: true, reason: state.input.error ?? 'Goal control applied' }
      if (
        g?.phase === 'active' &&
        (payload.budget.remaining <= 0 || (g.budgetCredits !== undefined && g.creditsUsed >= g.budgetCredits))
      ) {
        await update(state, 'blocked', 'Credit budget exhausted')
        return { park: true, reason: 'Goal credit budget exhausted' }
      }
      return {}
    }),
  )
  disposers.push(
    agnes.registerHook('context', async (_payload, ctx) => {
      const state = await read(ctx),
        g = state.goal
      return g
        ? {
            sections: [
              {
                id: 'persistent-goal',
                order: 164,
                content:
                  'Persistent goal: ' +
                  JSON.stringify(g) +
                  '\nWork toward this objective while active. When achieved call goal_update complete with evidence; when unable to progress call goal_update blocked with a concrete reason. Human input takes priority. Do not claim completion with required work remaining.',
              },
            ],
          }
        : {}
    }),
  )
  disposers.push(
    agnes.registerHook('turn_stopping', async (payload, ctx) => {
      const state = await read(ctx),
        g = state.goal
      if (g?.phase !== 'active' || ctx.signal.aborted) return { action: 'stop' }
      if (state.input?.control && !state.input.run) return { action: 'stop' }
      if (state.reservation?.turn === payload.turn) return { action: 'stop' }
      const reason =
        payload.proposedReason !== 'completed'
          ? `Turn stopped: ${payload.proposedReason}`
          : g.budgetCredits !== undefined && g.creditsUsed >= g.budgetCredits
            ? 'Credit budget exhausted'
            : g.rounds >= g.maxRounds
              ? 'Maximum automatic rounds reached'
              : !ctx.input
                ? 'Automatic continuation unavailable on this host'
                : undefined
      if (reason) {
        await update(state, 'blocked', reason)
        return { action: 'stop' }
      }
      const reservation = { id: g.id, revision: g.revision, round: g.rounds + 1, turn: payload.turn }
      await agnes.events.append('reserved', reservation)
      await ctx.input?.enqueueNextTurn(
        CONTINUE_PREFIX + JSON.stringify({ id: g.id, revision: g.revision, round: g.rounds + 1 }),
        `${g.id}:${g.revision}:${g.rounds + 1}`,
        agnes.ctx.signal,
      )
      return { action: 'stop' }
    }),
  )
  disposers.push(
    agnes.registerSlot('status.line', async (ctx) => {
      const state = await read(ctx),
        g = state.goal
      if (!g && !state.input?.control) return null
      return {
        text: (
          state.input?.error ??
          (g ? `Goal ${g.phase} · ${g.rounds}/${g.maxRounds}: ${g.objective}` : 'No goal')
        ).slice(0, 512),
        level: state.input?.error || g?.phase === 'blocked' ? 'warn' : 'info',
        ...(g ? { goal: g } : {}),
      }
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
})
