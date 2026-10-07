import { defineExtension, defineTool } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { readPlanMode, writePlanMode } from './state.js'

const SUMMARY_LIMIT = 4096

export default defineExtension((agnes) => {
  const disposers = [
    agnes.registerTool(
      defineTool({
        name: 'exit_plan_mode',
        description:
          'Submit the plan markdown and ask the user to approve it. Write and exec tools stay blocked until this call is approved.',
        parameters: Type.Object(
          { plan: Type.String({ minLength: 1, maxLength: 100_000 }) },
          { additionalProperties: false },
        ),
        meta: {
          isReadOnly: false,
          isDestructive: false,
          isConcurrencySafe: false,
          isOpenWorld: false,
          replay: 'never',
          costHint: {},
          deferLoading: false,
          requiresApproval: 'never',
        },
        async execute(args, ctx) {
          const state = readPlanMode(ctx.cwd)
          if (!state.active) return { content: [{ type: 'text', text: 'Plan mode is not active' }] }
          writePlanMode(ctx.cwd, {
            active: false,
            pendingPlan: args.plan,
            updatedAt: new Date().toISOString(),
          })
          return {
            content: [
              {
                type: 'text',
                text: 'Plan approved. Plan mode is off; write and exec tools are available.',
              },
            ],
          }
        },
      }),
    ),
    agnes.registerHook('context', (_payload, ctx) => {
      const state = readPlanMode(ctx.session.workspaceRoot)
      if (!state.active) return {}
      const instruction = state.instruction ? `\nInstruction: ${state.instruction}` : ''
      return {
        sections: [
          {
            id: 'plan-mode',
            order: 162,
            content: `Plan mode is active. Write a plan and call exit_plan_mode with the plan markdown. Write, edit, shell, and other non-read-only tools are blocked until the user approves that plan.${instruction}`,
          },
        ],
      }
    }),
    agnes.registerHook('approval_request', (payload, ctx) => {
      if (payload.request.tool !== 'exit_plan_mode') return {}
      const argv = payload.request.argv
      const fromArgs =
        argv && typeof argv === 'object' && !Array.isArray(argv) && typeof argv.plan === 'string'
          ? argv.plan
          : ''
      const plan = fromArgs || readPlanMode(ctx.session.workspaceRoot).pendingPlan || ''
      const header = 'Approve this plan to leave plan mode\n\n'
      const room = Math.max(0, SUMMARY_LIMIT - header.length)
      const body = plan.length > room ? `${plan.slice(0, Math.max(0, room - 1))}…` : plan
      return { request: { summary: `${header}${body}` } }
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})

export { decidePlanMode } from './policy.js'
export type { PlanModeState } from './state.js'
export { applyPlanCommand, planModePath, readPlanMode, writePlanMode } from './state.js'
