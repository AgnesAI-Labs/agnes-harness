import type { ToolContext, ToolDef, ToolMeta, ToolResult } from '@agnes/extension-api'
import type { Static, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export type TypedToolResult<R extends TSchema> = Omit<ToolResult, 'structured'> &
  ({ isError: true; structured?: never } | { isError?: false; structured: Static<R> })

/** Tool metadata as an author writes it: `replay` may be left out and is then `never`. */
export type AuthorToolMeta = Omit<ToolMeta, 'replay'> & { replay?: ToolMeta['replay'] }
type Authored<D extends { meta: ToolMeta }> = Omit<D, 'meta'> & { meta: AuthorToolMeta }

export type TypedToolDef<P extends TSchema, R extends TSchema> = Omit<ToolDef<P>, 'execute'> & {
  result: R
  execute(args: Static<P>, ctx: ToolContext): Promise<TypedToolResult<R>>
}

/**
 * Infer both schemas; validate successful structured results without changing Host policy.
 * A tool that does not state `replay` is never replayed after a crash; `safe` is for read-only tools.
 */
export function defineTool<P extends TSchema, R extends TSchema>(
  def: Authored<TypedToolDef<P, R>>,
): TypedToolDef<P, R>
export function defineTool<P extends TSchema>(def: Authored<ToolDef<P>>): ToolDef<P>
export function defineTool<P extends TSchema, R extends TSchema>(
  authored: Authored<ToolDef<P>> | Authored<TypedToolDef<P, R>>,
): ToolDef<P> | TypedToolDef<P, R> {
  // A complete declaration is returned as it was written.
  const def = (
    authored.meta.replay === undefined
      ? { ...authored, meta: { ...authored.meta, replay: 'never' } }
      : authored
  ) as ToolDef<P> | TypedToolDef<P, R>
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

/** Closed-world read: safe replay, concurrent execution, no approval by default. */
export const readOnlyTool: Readonly<ToolMeta> = Object.freeze({
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  requiresApproval: 'never',
})

/** Closed-world write: serial execution, no replay, explicit approval. Override for your contract. */
export const writeTool: Readonly<ToolMeta> = Object.freeze({
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never',
  requiresApproval: 'always',
})
