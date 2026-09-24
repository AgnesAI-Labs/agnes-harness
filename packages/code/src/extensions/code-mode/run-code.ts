import {
  type CodeRuntime,
  defineTool,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from '@agnes/extension-api'
import { type Static, Type } from '@sinclair/typebox'
import type { BridgeHandler } from '../../runtime/index.js'
import type { RunLimits } from './limits.js'
import { guardOutput } from './output.js'
import { runCodeDescription } from './sdk/flavors.js'

export type { BridgeHandler } from '../../runtime/index.js'

export const RunCodeParams = Type.Object(
  {
    code: Type.String({ description: 'The program to run in this cell.' }),
    description: Type.Optional(
      Type.String({ maxLength: 512, description: 'One line describing what this cell does.' }),
    ),
  },
  { additionalProperties: false },
)
export type RunCodeArgs = Static<typeof RunCodeParams>
export type RunCodeDeps = {
  acquire(ctx: ToolContext): Promise<CodeRuntime>
  bridge(ctx: ToolContext): BridgeHandler
  limits(ctx: ToolContext): RunLimits
  onCellDone?(ctx: ToolContext, runtime: CodeRuntime): void
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
    description: runCodeDescription('python'),
    parameters: RunCodeParams,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: undefined,
    },
    async execute(args, ctx): Promise<ToolResult> {
      const runtime = await deps.acquire(ctx)
      const limits = deps.limits(ctx)
      const result = await runtime.run({
        program: args.code,
        bindings: deps.bridge(ctx),
        signal: ctx.signal,
        limits: { wallMs: limits.wallMs, maxOutputChars: limits.maxOutputChars },
      })
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
      return {
        content: [{ type: 'text', text: guarded.text }],
        structured: {
          status: result.status,
          durationMs: result.durationMs,
          subcalls: result.subcalls,
          truncated: guarded.truncated,
          ...(artifact ? { artifact } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
        isError: result.status === 'error',
      }
    },
  })
}
