import type { ToolContext, ToolDef, ToolResult } from '@agnes/extension-api'
import type { Static, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export type TypedToolResult<R extends TSchema> = Omit<ToolResult, 'structured'> &
  ({ isError: true; structured?: never } | { isError?: false; structured: Static<R> })

export type TypedToolDef<P extends TSchema, R extends TSchema> = Omit<ToolDef<P>, 'execute'> & {
  result: R
  execute(args: Static<P>, ctx: ToolContext): Promise<TypedToolResult<R>>
}

/** Infer both schemas; validate successful structured results without changing Host policy. */
export function defineTool<P extends TSchema, R extends TSchema>(def: TypedToolDef<P, R>): TypedToolDef<P, R>
export function defineTool<P extends TSchema>(def: ToolDef<P>): ToolDef<P>
export function defineTool<P extends TSchema, R extends TSchema>(
  def: ToolDef<P> | TypedToolDef<P, R>,
): ToolDef<P> | TypedToolDef<P, R> {
  if (!('result' in def)) return def
  return {
    ...def,
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      const result = await def.execute(args, ctx)
      ctx.signal.throwIfAborted()
      if (result.isError !== true && !Value.Check(def.result, result.structured)) {
        throw new TypeError(`Tool ${def.name}: structured result does not match result schema`)
      }
      return result
    },
  }
}

/** An expected business failure. Unexpected failures should still throw. */
export function toolError(message: string): { content: ToolResult['content']; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Cancellation stays an exception, so the runtime can distinguish it from a tool error. */
export function toolCancelled(signal: AbortSignal): never {
  throw signal.reason ?? new DOMException('Tool cancelled', 'AbortError')
}
