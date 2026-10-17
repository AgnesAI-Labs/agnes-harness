import { type Context, defineAgnesPlugin, defineTool, workspaceStateKind } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import { createPlanServices } from './services.js'
import { clearPlanMode, readPlanMode } from './state.js'

const SUMMARY_LIMIT = 4096

const planBackend = defineAgnesPlugin({
  inject: ['tools', 'hooks', 'providers', 'self'],
  apply(plugin: Context) {
    const disposers = [
      plugin.providers.register(workspaceStateKind, {
        id: 'plan-mode',
        version: '1.0.0',
        open() {
          return {
            query(workspaceRoot) {
              plugin.self.signal.throwIfAborted()
              return { ...readPlanMode(workspaceRoot) }
            },
          }
        },
      }),
      plugin.tools.register(
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
            const state = readPlanMode(ctx.session.workspaceRoot)
            if (!state.active) return { content: [{ type: 'text', text: 'Plan mode is not active' }] }
            ctx.signal.throwIfAborted()
            if (
              !ctx.approval ||
              !clearPlanMode(ctx.session.workspaceRoot, ctx.approval.subjectRevision, args.plan)
            )
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'Plan changed or human approval is missing. Plan mode remains blocked.',
                  },
                ],
              }
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
      plugin.hooks.register('context', (_payload, ctx) => {
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
      plugin.hooks.register('approval_request', (payload, ctx) => {
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
    return async () => {
      for (const dispose of disposers.reverse()) await dispose()
    }
  },
})

export default planBackend

export { decidePlanMode } from './policy.js'
export type { PlanModeState } from './state.js'
export { applyPlanCommand, clearPlanMode, planModePath, readPlanMode, writePlanMode } from './state.js'

/** Optional declared policy dependency over the selected generation's state provider. */
export const planModePlugin = defineAgnesPlugin({
  inject: ['providers', 'services'],
  provide: ['planMode'],
  apply(plugin: Context) {
    const available = () =>
      plugin.providers
        .catalog()
        .some((entry) => entry.kind === workspaceStateKind.kind && entry.id === 'plan-mode')
    const releases = createPlanServices(available).map((service) => plugin.services.register(service))
    plugin.provide(
      'planMode',
      Object.freeze({
        async status(workspaceRoot: string, signal: AbortSignal) {
          const entries = plugin.providers
            .catalog()
            .filter((entry) => entry.kind === workspaceStateKind.kind && entry.id === 'plan-mode')
          if (!entries.length) return { active: false, updatedAt: '' }
          const selected =
            entries.find((entry) => entry.active) ?? (entries.length === 1 ? entries[0] : undefined)
          if (!selected) throw new Error('Ambiguous plan state provider')
          const provider = plugin.providers.resolve(workspaceStateKind, {
            provider: selected.id,
            version: selected.version,
          })
          const instance = await provider.open({
            binding: { owner: 'agnes/approval-policy', packageId: selected.sourcePackage, signal },
            now: Date.now,
          })
          try {
            const state = await instance.query(workspaceRoot)
            if (
              !state ||
              typeof state !== 'object' ||
              Array.isArray(state) ||
              typeof state.active !== 'boolean' ||
              typeof state.updatedAt !== 'string'
            )
              throw new Error('Invalid plan state')
            if (state.active && (state.blocked === true || typeof state.revision !== 'string'))
              return { active: true, blocked: true, updatedAt: state.updatedAt }
            return {
              active: state.active,
              updatedAt: state.updatedAt,
              ...(typeof state.revision === 'string' ? { revision: state.revision } : {}),
            }
          } finally {
            await instance.dispose?.()
          }
        },
      }),
    )
    return () => {
      for (const release of releases.reverse()) release()
    }
  },
})
