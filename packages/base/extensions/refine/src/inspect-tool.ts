import { defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import type { RefinementToolPort } from './port.js'
import { EntryKind } from './propose-tool.js'

export const InspectParams = Type.Object(
  {
    op: Type.Union([Type.Literal('search'), Type.Literal('list'), Type.Literal('get')]),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    kind: Type.Optional(EntryKind),
    cursor: Type.Optional(Type.String({ maxLength: 256 })),
    id: Type.Optional(Type.String({ maxLength: 128 })),
  },
  { additionalProperties: false },
)

/** Reads the experience entries this session can see; it changes nothing. */
export function createInspectTool(port: Pick<RefinementToolPort, 'inspect'>) {
  return defineTool({
    name: 'harness_inspect',
    description:
      "Read this session's experience entries: op 'search' finds entries matching a query, op 'list' pages through the entries of one kind with a cursor, op 'get' returns one entry's full text by id.",
    parameters: InspectParams,
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      deferLoading: true,
    },
    async execute(args, ctx) {
      return port.inspect(args, ctx)
    },
  })
}
