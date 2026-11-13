import type { HookContext, PluginContextFacets } from '@agnes/extension-api'
import { createAnswerCache } from './cache.js'
import { type JudgeTarget, resolveJudgeChain } from './config.js'
import { within } from './deadline.js'
import { createJudge, createRouteCooldown, type Judge } from './judge.js'
import { createJudgmentScheduler } from './scheduler.js'

export type JudgmentContext = Pick<HookContext, 'sideCall' | 'signal' | 'session'>
export interface JudgmentRuntime {
  current(): readonly JudgeTarget[] | null
  subscribe(listener: () => void): () => void
  judge(ctx: JudgmentContext): Promise<Judge | null>
  dispose(): void
}

export function createJudgmentRuntime(plugin: PluginContextFacets, config: unknown): JudgmentRuntime {
  const ownerSignal = plugin.self.signal
  const sideModels = plugin.self.sideModels
  const log = plugin.self.log
  const lifetime = new AbortController()
  const signal = AbortSignal.any([ownerSignal, lifetime.signal])
  const scheduler = createJudgmentScheduler(16)
  const cache = createAnswerCache(null, {
    ttlMs: 30 * 86400000,
    maxEntries: 2000,
    onError: () => log.warn('Judgment answer cache disabled'),
  })
  const cooldown = createRouteCooldown()
  const listeners = new Set<() => void>()
  let current: readonly JudgeTarget[] | null = null
  const publish = (next: readonly JudgeTarget[] | null) => {
    if (signal.aborted || JSON.stringify(current) === JSON.stringify(next)) return
    current = next
    for (const listener of listeners) listener()
  }
  const read = async (readSignal: AbortSignal) => {
    if (readSignal.aborted || !sideModels) return null
    try {
      const models = await within(sideModels.list(), readSignal)
      const next = resolveJudgeChain(config, models)
      publish(next)
      return next
    } catch {
      publish(null)
      return null
    }
  }
  let refreshing = false
  let dirty = false
  const refresh = () => {
    dirty = true
    if (refreshing || signal.aborted) return
    refreshing = true
    void (async () => {
      try {
        while (dirty && !signal.aborted) {
          dirty = false
          await read(signal)
        }
      } finally {
        refreshing = false
      }
    })()
  }
  const unsubscribe = sideModels?.subscribe?.(refresh)
  const dispose = () => {
    lifetime.abort()
    unsubscribe?.()
    listeners.clear()
    current = null
    scheduler.dispose()
    cache.clear()
    cooldown.clear()
    ownerSignal.removeEventListener('abort', dispose)
  }
  ownerSignal.addEventListener('abort', dispose, { once: true })
  refresh()
  return {
    current: () => current,
    subscribe(listener) {
      if (signal.aborted) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async judge(ctx) {
      const callSignal = AbortSignal.any([ctx.signal, signal])
      if (!ctx.sideCall || callSignal.aborted) return null
      const chain = await read(callSignal)
      if (!chain || callSignal.aborted) return null
      const judge = createJudge({
        port: ctx.sideCall,
        chain,
        cache,
        cooldown,
        scheduler,
        session: ctx.session.key,
        now: Date.now,
      })
      return {
        judge: (purpose, req, opts) =>
          judge.judge(purpose, req, {
            ...opts,
            signal: AbortSignal.any([opts.signal, callSignal]),
          }),
      }
    },
    dispose,
  }
}
