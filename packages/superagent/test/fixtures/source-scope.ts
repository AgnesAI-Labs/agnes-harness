// Adapted from dsh-superagent (MIT)
/**
 * A stand-in for the Source registry's `SourceScope`: the receiving scope the Feishu and GitHub Sources report for a trigger,
 * read from the stored Source configuration with the Sources' defaults. A Source with stored configuration but no kind here
 * listens to nothing, as with a missing plugin; a Source without either listens to everything it produces and observes none.
 */
import { z } from 'zod'
import type { ScopeResult, SourceScope } from '../../src/core/index.js'
import type { Settings } from '../../src/policy.js'

const Feishu = z.object({
  chats: z.array(z.object({ chatId: z.string(), listen: z.enum(['mentions', 'all']) })).default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
})
const Github = z.object({
  observeIssues: z.boolean().default(false),
  observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false),
})
const OBSERVED = {
  issues: 'observeIssues',
  pulls: 'observePulls',
  comments: 'observeComments',
  ci: 'observeCi',
} as const

function githubRow(meta: Record<string, unknown>): keyof typeof OBSERVED | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review'
    ? 'comments'
    : undefined
}

export function sourceScope(settings: Settings): SourceScope {
  return {
    scope({ source, meta }): ScopeResult {
      const stored = settings.sources[source]
      if (source !== 'feishu' && source !== 'github')
        return stored
          ? { listened: false, reason: 'source_not_installed' }
          : { listened: true, observed: false }
      if (!(stored?.enabled ?? true)) return { listened: false, reason: 'source_disabled' }
      if (source === 'feishu') {
        const config = Feishu.parse(stored?.config ?? {})
        if (meta.direct === true)
          return config.directMessages
            ? { listened: true, observed: false, row: 'direct' }
            : { listened: false, reason: 'direct_messages_not_allowed' }
        const chat = config.chats.find((item) => item.chatId === meta.chatId)
        if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
        return config.otherChats === 'mentions'
          ? { listened: true, observed: false, row: 'other' }
          : { listened: false, reason: 'chat_not_allowed' }
      }
      const config = Github.parse(stored?.config ?? {})
      const row = githubRow(meta)
      return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...(row ? { row } : {}) }
    },
  }
}
