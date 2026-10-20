import type { CodeRuntime, ToolContext, ToolDef, ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { type Static, Type } from '@sinclair/typebox'
import type { BridgeHandler } from '../../runtime/index.js'
import type { NestedCall } from './bridge.js'
import type { RunLimits } from './limits.js'
import { guardOutput } from './output.js'
import { runCodeDescription } from './sdk/flavors.js'

export type { BridgeHandler } from '../../runtime/index.js'

export const RunCodeParams = Type.Object(
  {
    code: Type.String({ maxLength: 262144, description: 'The program to run in this cell.' }),
    description: Type.Optional(
      Type.String({ maxLength: 512, description: 'One line describing what this cell does.' }),
    ),
  },
  { additionalProperties: false },
)
export type RunCodeArgs = Static<typeof RunCodeParams>
export type RunCodeDeps = {
  language?: CodeRuntime['language']
  acquire(ctx: ToolContext): Promise<CodeRuntime>
  bridge(ctx: ToolContext): BridgeHandler & { calls?(): ReadonlyArray<NestedCall> }
  limits(ctx: ToolContext): RunLimits
  onCellDone?(ctx: ToolContext, runtime: CodeRuntime): void
}

/**
 * `write ok, shell error, edit pending; read-only: 2`; read-only calls are only counted, as the model
 * never sees them. `pending` is a call waiting for approval (bridge code 1006).
 */
function nestedLine(calls: ReadonlyArray<NestedCall>): string {
  if (!calls.length) return ''
  const listed = calls.filter((c) => !c.readOnly).map((c) => `${c.name} ${c.status}`)
  const readOnly = `read-only: ${calls.length - listed.length}`
  return `nested calls: ${listed.length ? `${listed.join(', ')}; ` : ''}${readOnly}`
}

function cellText(result: Awaited<ReturnType<CodeRuntime['run']>>): string {
  const parts = [result.stdout, result.stderr, result.result].filter(Boolean) as string[]
  if (result.error)
    parts.push([`${result.error.name}: ${result.error.message}`, ...result.error.traceback].join('\n'))
  return parts.join('\n').trimEnd() || '(cell produced no output)'
}

export function createRunCodeTool(deps: RunCodeDeps): ToolDef<typeof RunCodeParams> {
  return defineTool({
    name: 'run_code',
    description: runCodeDescription(deps.language ?? 'python'),
    parameters: RunCodeParams,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',

      deferLoading: false,
      requiresApproval: 'always',
      commandArg: 'code',
    },
    async execute(args, ctx): Promise<ToolResult> {
      const controller = new AbortController()
      const scoped = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) }
      const runtime = await deps.acquire(scoped)
      const bridge = deps.bridge(scoped)
      const limits = deps.limits(ctx)
      let result: Awaited<ReturnType<CodeRuntime['run']>>
      try {
        result = await runtime.run({
          program: args.code,
          bindings: bridge,
          signal: scoped.signal,
          limits: { wallMs: limits.wallMs, maxOutputChars: limits.maxOutputChars },
        })
      } finally {
        controller.abort()
        await runtime.shutdown?.()
      }
      const guarded = guardOutput(cellText(result), limits.maxOutputChars)
      let artifact: string | undefined
      if (guarded.full !== undefined) {
        const ref = await ctx.artifacts.put(new TextEncoder().encode(guarded.full), {
          mime: 'text/plain',
          name: 'cell-output.txt',
        })
        artifact = ref.sha256
      }
      deps.onCellDone?.(ctx, runtime)
      const line = nestedLine(bridge.calls?.() ?? [])
      return {
        content: [{ type: 'text', text: line ? `${guarded.text}\n${line}` : guarded.text }],
        structured: {
          status: result.status,
          durationMs: result.durationMs,
          subcalls: result.subcalls,
          ioEnforcement: ctx.codeRuntime?.rawIo ? 'cell-approval' : 'tool-bridge',
          truncated: guarded.truncated,
          ...(artifact ? { artifact } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        isError: result.status !== 'ok',
      }
    },
  })
}
