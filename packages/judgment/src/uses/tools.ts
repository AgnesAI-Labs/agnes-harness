import type { PluginContextFacets, ToolContext, ToolResult } from '@agnes/extension-api'
import { resolveToolConfig } from '../config.js'
import { deadlineScope, within } from '../deadline.js'
import type { JudgmentRuntime } from '../runtime.js'
import { findRelevant } from './find-relevant.js'
import { judgeBatch } from './judge-batch.js'
import { batchInput, findInput } from './tool-input.js'
import { toolParameters } from './tool-parameters.js'
import { createToolsProjection, sessionHash, TOOL_SESSION, type ToolSession } from './tools-projection.js'

const failure = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

export function registerJudgmentTools(
  plugin: PluginContextFacets,
  runtime: JudgmentRuntime,
  config: unknown,
): () => void {
  const ownerSignal = plugin.self.signal
  const lifetime = new AbortController()
  const registered = new Map<string, () => void>()
  const projection = plugin.projections.register(createToolsProjection())
  const uses = resolveToolConfig(config)
  const enabled = (kind: 'find' | 'batch') => uses[kind]
  const execute = async (kind: 'find' | 'batch', args: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const scope = deadlineScope(
      AbortSignal.any([ctx.signal, ownerSignal, lifetime.signal]),
      kind === 'find' ? 20000 : 60000,
    )
    const end = Date.now() + (kind === 'find' ? 20000 : 60000)
    let input: ReturnType<typeof findInput> | ReturnType<typeof batchInput> = null
    try {
      input = kind === 'find' ? findInput(args) : batchInput(args)
      if (!input) return failure('Invalid judgment tool input; no request sent.')
      if (!enabled(kind)) return failure('Judgment use is disabled.')
      if (!ctx.sideCall) return failure('Authorized judgment port unavailable.')
      if (ctx.session.depth > 0 || ctx.session.generationDepth > 0)
        return failure('Judgment unavailable in a child or nested invocation.')
      if (scope.signal.aborted) return failure('Judgment invocation cancelled.')
      const read = await within(ctx.projections.readOwn<ToolSession>(TOOL_SESSION), scope.signal)
      if (
        read.status !== 'available' ||
        !read.value ||
        read.value.child !== false ||
        read.value.sessionHash !== sessionHash(ctx.session.key)
      )
        return failure('Judgment session projection unavailable.')
      if (!runtime.current() || (kind === 'find' && !runtime.current()?.[0]?.native))
        return failure('Judgment model unavailable.')
      const judge = await within(runtime.judge({ ...ctx, signal: scope.signal }), scope.signal)
      if (!judge || !runtime.current() || (kind === 'find' && !runtime.current()?.[0]?.native))
        return failure('Judgment port unavailable.')
      const result =
        kind === 'find'
          ? await findRelevant(judge, ctx, input as ReturnType<typeof findInput> & {}, scope.signal, end)
          : await judgeBatch(
              judge,
              input as ReturnType<typeof batchInput> & {},
              scope.signal,
              ctx.session.toolUseId,
              end,
            )
      return {
        structured: result,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              'matches' in result
                ? {
                    message: result.message,
                    matches: result.matches,
                    partial: result.partial,
                    reasons: result.reasons,
                    billing: result.billing,
                  }
                : {
                    completed: result.completed,
                    pending: result.pending,
                    partial: result.partial,
                    billing: result.billing,
                  },
            ),
          },
        ],
      }
    } catch {
      if (input && 'items' in input)
        return {
          structured: {
            completed: [],
            pending: input.items.map((item) => item.id),
            partial: true,
            accounting: { calls: [] },
            reasons: ['interrupted_before_judgment'],
          },
          content: [
            {
              type: 'text',
              text: 'Judgment interrupted during preparation; all items remain pending. Dollar billing is unknown.',
            },
          ],
        }
      return failure('Judgment interrupted before completion; no conclusion is available.')
    } finally {
      scope.close()
    }
  }
  const refresh = () => {
    for (const kind of ['find', 'batch'] as const) {
      const name = kind === 'find' ? 'find_relevant' : 'judge_batch'
      const wanted =
        !lifetime.signal.aborted &&
        !ownerSignal.aborted &&
        enabled(kind) &&
        !!runtime.current()?.length &&
        (kind === 'batch' || runtime.current()?.[0]?.native)
      if (!wanted) {
        registered.get(name)?.()
        registered.delete(name)
        continue
      }
      if (registered.has(name)) continue
      registered.set(
        name,
        plugin.tools.register({
          name,
          parameters: toolParameters[kind],
          description:
            kind === 'find'
              ? 'Find relevant source ranges using a bounded redacted semantic scan. Partial results are explicit; use grep when judgment fails.'
              : 'Judge up to 500 independent JSON states. Choice questions require other and mixed keys. Sends redacted states and question text to the selected judgment model; unsafe question or choice identifiers are refused.',
          meta: {
            isReadOnly: true,
            isDestructive: false,
            isConcurrencySafe: true,
            isOpenWorld: true,
            replay: 'idempotent',
            ...(kind === 'find' ? { paths: [{ arg: 'path', access: 'read', default: '.' }] as const } : {}),
          },
          execute: (args, ctx) => execute(kind, args, ctx),
        }),
      )
    }
  }
  const unsubscribe = runtime.subscribe(refresh)
  const dispose = () => {
    if (lifetime.signal.aborted) return
    lifetime.abort()
    unsubscribe()
    refresh()
    projection()
    ownerSignal.removeEventListener('abort', dispose)
  }
  ownerSignal.addEventListener('abort', dispose, { once: true })
  refresh()
  return dispose
}
