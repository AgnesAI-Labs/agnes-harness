import type { CompactionEngine, CompactionEnginePluginContext, CompactionNode } from '@agnes/extension-api'
import { defineAgnesPlugin, type Context } from '@agnes/plugin-runtime'

/** A lossy, deterministic engine. All retained context and fixed system sections stay untouched. */
export function slidingWindow(keepTurns = 4): CompactionEngine {
  if (!Number.isSafeInteger(keepTurns) || keepTurns < 1)
    throw new TypeError('keepTurns must be a positive integer')
  return {
    id: 'sliding-window',
    version: '0.1.0',
    create: () => ({
      shouldCompact: (budget) => budget.contextTokens > budget.contextWindow - budget.reserveTokens,
      async compact(input, { signal }) {
        signal.throwIfAborted()
        const nodes = input.conversation
        const turns = [...new Set(nodes.filter((node) => node.turn > 0).map((node) => node.turn))].sort(
          (a, b) => a - b,
        )
        const oldestKept = turns.at(-keepTurns)
        if (oldestKept === undefined) return null
        let cut = nodes.findIndex((node) => node.turn >= oldestKept)
        // A pinned conversation node also keeps everything after it. Fixed system sections are
        // outside the conversation entirely, so no replacement can mask those sections.
        const pinned = nodes.findIndex((node) => node.pinned)
        if (pinned >= 0) cut = Math.min(cut, pinned)
        // A result belongs to its preceding assistant, even across an intervening user note.
        let owner = -1
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i] as CompactionNode
          if (node.kind === 'assistant') owner = i
          else if (node.kind === 'summary') owner = -1
          else if (node.kind === 'tool_result' && i >= cut && owner >= 0 && owner < cut) cut = owner
        }
        if (cut <= 0) return null
        const removed = nodes.slice(0, cut)
        const text = '[Earlier turns elided by sliding-window.]'
        // Core checks size again using its own estimator before committing.
        if (Math.ceil(text.length / 4) >= removed.reduce((sum, node) => sum + node.tokensEstimate, 0))
          return null
        return {
          kind: 'replacement',
          range: [removed[0]!.seq, removed.at(-1)!.seq],
          text,
          mode: 'elision',
        }
      },
    }),
  }
}

export const main = defineAgnesPlugin({
  inject: ['compactionEngines'],
  apply(ctx: Context & CompactionEnginePluginContext, config: { keepTurns?: number }) {
    ctx.compactionEngines.register(slidingWindow(config.keepTurns ?? 4))
  },
})
