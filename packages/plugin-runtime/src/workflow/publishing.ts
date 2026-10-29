import type { LoopContext, ToolPolicy } from '@agnes/extension-api'
import { object } from './checkpoint.js'
import type { JsonValue, WorkflowOptions, WorkflowState } from './types.js'
import { workflowChecked } from './values.js'

export async function publishWorkflow(
  ctx: LoopContext,
  state: WorkflowState,
  options: WorkflowOptions,
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!options.deliverables) return []
  const markdown =
    options.deliverables.markdown?.(state) ??
    `# ${options.name ?? options.id}\n\n\u0060\u0060\u0060json\n${JSON.stringify(state.data, null, 2)}\n\u0060\u0060\u0060\n`
  const documents = [{ name: 'report.md', content: markdown }]
  const html = options.deliverables.html?.(state)
  if (html) documents.push({ name: 'report.html', content: html })
  const files = []
  for (const document of documents) {
    const path = `${options.deliverables.directory}/${state.outputKey}/${state.index}-${document.name}`
    await ctx.tools.execute({ name: 'read', args: { path } }, signal)
    workflowChecked(
      await ctx.tools.execute({ name: 'write', args: { path, content: document.content } }, signal),
    )
    files.push({
      path,
      name: document.name,
      description: `${options.name ?? options.id}: ${state.index === state.stageCount - 1 ? 'final' : 'review draft'}`,
    })
  }
  const output = workflowChecked(await ctx.tools.execute({ name: 'present', args: { files } }, signal))
  return object(output.details) ? (output.details.deliverables ?? []) : []
}

export function workflowPolicy(options: WorkflowOptions): ToolPolicy {
  const directory = options.deliverables?.directory
  if (directory && !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(directory))
    throw new Error('Workflow output directory must be a relative path without traversal')
  const outputPath = directory ? new RegExp(`^${directory}/[a-f0-9]{64}/[0-9]+-report\\.(md|html)$`) : null
  return {
    id: options.id,
    version: options.version,
    decide(input, signal, ports) {
      signal.throwIfAborted()
      if (['ui_render', 'ui_update', 'ui_close', 'ui_submit', 'ask_user_question'].includes(input.call?.name))
        return { effect: 'allow', reason: 'Session presentation and authenticated answer collection only' }
      if (input.call?.name === 'exit_plan_mode')
        return { effect: 'ask', reason: 'Approve the workflow plan through the official ticket' }
      if (
        input.call?.name === 'write' &&
        object(input.call.args) &&
        typeof input.call.args.path === 'string' &&
        outputPath?.test(input.call.args.path)
      )
        return {
          effect: 'allow',
          reason: 'Generated report output only; official write enforces observation',
        }
      if (options.readOnly && (!input.policy.isReadOnly || input.policy.isDestructive))
        return { effect: 'deny', reason: 'Business evidence is read-only' }
      if (options.policy) return options.policy(input, signal, ports)
      return input.policy.requiresApproval === 'always' ||
        input.policy.isDestructive ||
        !input.policy.isReadOnly
        ? { effect: 'ask', reason: 'Business choice does not replace tool authorization' }
        : { effect: 'allow', reason: 'Read-only business evidence' }
    },
  }
}
