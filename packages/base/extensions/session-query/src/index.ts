import { type Context, defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import {
  bindSessionQuery,
  closeSessionQuery,
  runSessionEventRead,
  runSessionEventSearch,
  runSessionEventTrace,
  runSessionSearch,
  runSessionTrace,
} from './runtime.js'

const READ_ONLY = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  // Looking back at earlier sessions is occasional; the five tools wait behind tool_search as one
  // listed group instead of costing about 490 schema tokens on every request.
  deferLoading: true,
  discoveryGroup: 'Earlier sessions (search, read and trace past sessions)',
  requiresApproval: 'never' as const,
}

const query = Type.String({ minLength: 1, maxLength: 256 })
const sessionId = Type.String({ minLength: 1, maxLength: 256 })
const seq = Type.Integer({ minimum: 1 })
const window = Type.Optional(Type.Integer({ minimum: 0, maximum: 20 }))

export const sessionSearchTool = defineTool({
  name: 'session_search',
  description:
    'Search earlier sessions in this workspace for a literal phrase. Read-only. Omits the current session. The phrase is text, not SQL. If the result says to narrow the query, use a more specific phrase.',
  parameters: Type.Object({ query }, { additionalProperties: false }),
  meta: READ_ONLY,
  async execute(args, ctx) {
    return runSessionSearch(args.query, ctx)
  },
})

export const sessionEventSearchTool = defineTool({
  name: 'session_event_search',
  description:
    'Search events in one authorized session for a literal phrase. Read-only. Pass a session id returned by session_search or session_trace. The phrase is text, not SQL.',
  parameters: Type.Object({ sessionId, query }, { additionalProperties: false }),
  meta: READ_ONLY,
  async execute(args, ctx) {
    return runSessionEventSearch(args.sessionId, args.query, ctx)
  },
})

export const sessionTraceTool = defineTool({
  name: 'session_trace',
  description:
    'Show the authorized ancestor and descendant sessions of one session. Read-only. Sessions outside this workspace are marked unavailable.',
  parameters: Type.Object({ sessionId }, { additionalProperties: false }),
  meta: READ_ONLY,
  async execute(args, ctx) {
    return runSessionTrace(args.sessionId, ctx)
  },
})

export const sessionEventTraceTool = defineTool({
  name: 'session_event_trace',
  description:
    'Show the source events and later events that cite one event in an authorized session. Read-only.',
  parameters: Type.Object({ sessionId, seq }, { additionalProperties: false }),
  meta: READ_ONLY,
  async execute(args, ctx) {
    return runSessionEventTrace(args.sessionId, args.seq, ctx)
  },
})

export const sessionEventReadTool = defineTool({
  name: 'session_event_read',
  description:
    'Read one event and up to 20 neighboring events on each side in an authorized session. Read-only.',
  parameters: Type.Object({ sessionId, seq, before: window, after: window }, { additionalProperties: false }),
  meta: READ_ONLY,
  async execute(args, ctx) {
    return runSessionEventRead(args.sessionId, args.seq, args.before, args.after, ctx)
  },
})

export function createSessionQueryExtension(options: { dataDir?: string } = {}) {
  return defineAgnesPlugin({
    inject: ['tools', 'hooks', 'self'],
    apply(plugin: Context) {
      const dataDir = options.dataDir
      if (!dataDir) plugin.self.log.warn('session query has no data directory')
      else bindSessionQuery(dataDir)
      const disposers = [
        plugin.tools.register(sessionSearchTool),
        plugin.tools.register(sessionEventSearchTool),
        plugin.tools.register(sessionTraceTool),
        plugin.tools.register(sessionEventTraceTool),
        plugin.tools.register(sessionEventReadTool),
        plugin.hooks.register('context', () => ({
          sections: [
            {
              id: 'session-query',
              order: 168,
              content:
                'Use session_search and session_event_search to find earlier sessions and events in this workspace. Use session_trace, session_event_trace, and session_event_read to inspect an authorized session. These tools are read-only and cannot run SQL.',
            },
          ],
        })),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
        closeSessionQuery()
      }
    },
  })
}
