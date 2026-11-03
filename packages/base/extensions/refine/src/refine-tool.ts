import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import type { RefinementToolPort } from './port.js'
import { Target } from './propose-tool.js'

export const RefineParams = Type.Object(
  {
    focus: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    target: Type.Optional(Target),
  },
  { additionalProperties: false },
)

/** Asks for a review of this session's work so far; the port decides whether and when it runs. */
export function createRefineTool(port: Pick<RefinementToolPort, 'refine'>) {
  return defineTool({
    name: 'harness_refine',
    description:
      'Ask for a background review of the work in this session so far, to keep what was learned as experience for later turns. An optional focus names what to look at. Returns at once; any result takes effect from a later turn.',
    parameters: RefineParams,
    meta: {
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      deferLoading: true,
    },
    async execute(args, ctx) {
      return port.refine(
        { ...(args.focus === undefined ? {} : { focus: args.focus }), target: args.target ?? 'session' },
        ctx,
      )
    },
  })
}
