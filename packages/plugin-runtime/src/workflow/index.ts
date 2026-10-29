import type { LoopFactory } from '@agnes/extension-api'
import { loopKind, toolPolicyKind } from '@agnes/extension-api'
import { defineLoop } from '../author/loop.js'
import { type Context, defineAgnesPlugin } from '../author.js'
import { workflowCheckpoint } from './checkpoint.js'
import { workflowDriver } from './driver.js'
import { publishWorkflow, workflowPolicy } from './publishing.js'
import type { WorkflowData, WorkflowOptions, WorkflowStage } from './types.js'
import { workflowChecked } from './values.js'

export type { WorkflowData, WorkflowOptions, WorkflowStage, WorkflowState } from './types.js'
export {
  workflowChecked,
  workflowModelText,
  workflowResult,
  workflowText,
  workflowTool,
  workflowValue,
} from './values.js'

/** Define a staged business Loop and its tools, policy and Skills through public author ports. */
export function defineWorkflowLoop(options: WorkflowOptions) {
  const policy = workflowPolicy(options)
  const plan =
    `# ${options.name ?? options.id} workflow plan\n\n` +
    options.stages.map((stage, i) => `${i + 1}. ${stage.name}`).join('\n') +
    '\n\nPresent generated reports. Keep source evidence read-only where configured. Business actions require a separate Proceed/Cancel answer and backend tool permission; unknown effects are never replayed.'
  const stages: WorkflowStage[] = [
    {
      name: 'approve-plan',
      approval: true,
      async run(ctx, _state, signal) {
        const active = (await ctx.turn.view())?.prompt.sections.some((section) => section.id === 'plan-mode')
        if (!active && !('approvalCall' in _state && _state.approvalCall))
          return { plan: { required: false } }
        workflowChecked(await ctx.tools.execute({ name: 'exit_plan_mode', args: { plan } }, signal))
        return { plan: { required: true, approved: true } }
      },
    },
    ...options.stages,
    ...(options.deliverables
      ? [
          {
            name: 'present-deliverables',
            async run(ctx, state, signal) {
              return { deliverables: await publishWorkflow(ctx, state, options, signal) }
            },
            // The same line the present tool returns, never the artifact references: the conversation
            // shows the files themselves as cards and folds this line into that call.
            message(data) {
              const names = Array.isArray(data.deliverables)
                ? data.deliverables.flatMap((file) =>
                    file && typeof file === 'object' && !Array.isArray(file) && typeof file.name === 'string'
                      ? [file.name]
                      : [],
                  )
                : []
              return names.length ? `Presented ${names.join(', ')}` : undefined
            },
          } satisfies WorkflowStage,
        ]
      : []),
  ]
  function createFactory(rawSettings: WorkflowData = {}): LoopFactory {
    const settings = options.validateSettings?.(rawSettings) ?? rawSettings
    const { codec, initial } = workflowCheckpoint(options, stages.length, settings)
    return defineLoop({
      id: options.id,
      version: options.version,
      capabilities: ['tools', 'model', 'checkpoint', 'deferred-invocations', 'approval'],
      ...(stages.some((stage) => stage.inputStage) ? { controls: { steer: true } } : {}),
      codec: {
        version: codec.version,
        encode(state) {
          return codec.encode(codec.decode({ codecVersion: codec.version, state }))
        },
        decode(saved) {
          return codec.encode(codec.decode(saved)).state
        },
      },
      create: (ctx) => workflowDriver(ctx, initial(), options, stages, codec, initial, plan),
      resume: (ctx, saved) => workflowDriver(ctx, codec.decode(saved), options, stages, codec, initial, plan),
    })
  }
  const main = defineAgnesPlugin({
    inject: ['tools', 'providers', 'skills'],
    apply(
      ctx: Context & { skills: { register(skill: NonNullable<WorkflowOptions['skills']>[number]): unknown } },
      config: { workflow?: WorkflowData } = {},
    ) {
      for (const definition of options.tools ?? []) ctx.tools.register(definition)
      ctx.providers.register(loopKind, createFactory(config.workflow))
      ctx.providers.register(toolPolicyKind, {
        ...policy,
        async decide(input, signal, ports) {
          const base = await ctx.providers.resolve(toolPolicyKind, 'default').decide(input, signal, ports)
          return base.effect === 'deny' ? base : policy.decide(input, signal, ports)
        },
      })
      for (const skill of options.skills ?? []) ctx.skills.register(skill)
    },
  })
  return { main, factory: createFactory(), createFactory, policy }
}
