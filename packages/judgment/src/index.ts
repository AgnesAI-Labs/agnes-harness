import type { PluginContextFacets } from '@agnes/extension-api'
import { createAnswerCache } from './cache.js'
import { resolveJudgeChain, resolveStopConfig } from './config.js'
import { createJudge, createRouteCooldown } from './judge.js'
import { registerStopDetection } from './uses/stop.js'

export { createAnswerCache } from './cache.js'
export type { JudgeTarget, StopConfig } from './config.js'
export { CONFIG_SCHEMA, resolveJudgeChain, resolveStopConfig } from './config.js'
export { nativePayload, splitRequest } from './encode.js'
export type { Judge, JudgeOutcome } from './judge.js'
export { createJudge, createRouteCooldown } from './judge.js'
export type * from './questions.js'
export { validateRequest } from './questions.js'
export { parseAnswers, renderPrompt } from './text-bridge.js'

export const judgmentPlugin = {
  inject: ['hooks', 'projections', 'eventLog', 'sideCall', 'self'] as const,
  apply(plugin: PluginContextFacets, config?: unknown) {
    const cache = createAnswerCache(null, {
      ttlMs: 30 * 86400000,
      maxEntries: 2000,
      onError: () => plugin.self.log.warn('Judgment answer cache disabled'),
    })
    const cooldown = createRouteCooldown()
    const dispose = registerStopDetection(plugin, {
      config: () => resolveStopConfig(config),
      async judge(ctx) {
        if (!ctx.sideCall || !plugin.self.sideModels || ctx.signal.aborted) return null
        const models = await plugin.self.sideModels.list()
        if (ctx.signal.aborted) return null
        const chain = resolveJudgeChain(config, models)
        if (!chain) {
          plugin.self.log.info('Judgment idle: select an unambiguous available judgment model')
          return null
        }
        return createJudge({
          port: ctx.sideCall,
          chain,
          cache,
          cooldown,
          session: ctx.session.key,
          now: Date.now,
        })
      },
    })
    return () => {
      dispose()
      cache.clear()
      cooldown.clear()
    }
  },
}
