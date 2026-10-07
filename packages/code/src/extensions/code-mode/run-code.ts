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
    description: runCodeDescription(deps.language ?? 'python'),
    parameters: RunCodeParams,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: 'always',
    },
    async execute(args, ctx): Promise<ToolResult> {
      const controller = new AbortController()
      const scoped = { ...ctx, signal: AbortSignal.any([ctx.signal, controller.signal]) }
      const runtime = await deps.acquire(scoped)
      const limits = deps.limits(ctx)
      let result: Awaited<ReturnType<CodeRuntime['run']>>
      try {
        result = await runtime.run({
          program: args.code,
          bindings: deps.bridge(scoped),
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
      return {
        content: [{ type: 'text', text: guarded.text }],
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
