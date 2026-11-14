// Adapted from dsh-superagent (MIT)
/** Shared tool primitives for the main and worker sessions. */
import { z } from 'zod'
import { resourceGrammar } from './resources.js'

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/**
 * Builds the `orchestrator_read` tool, scoping allowed resource patterns to the main session or to a worker session (which
 * may read only its own ticket and messages that reached it).
 */
export function readTool(
  description: string,
  executor: boolean,
  read: (
    resource: string,
    offset: number,
    limit: number | undefined,
    signal: AbortSignal,
  ) => Promise<unknown>,
): Tool {
  return tool({
    name: 'orchestrator_read',
    description,
    schema: z
      .object({
        resource: z
          .string()
          .min(1)
          .describe(`The resource, one of: ${resourceGrammar(executor)}.`),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            'Copy next_offset from the previous page; it counts characters of a text and items of a list.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(8000)
          .optional()
          .describe(
            'Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.',
          ),
      })
      .strict(),
    execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal),
  })
}
