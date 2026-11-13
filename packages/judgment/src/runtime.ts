import type { HookContext, PluginContextFacets } from '@agnes/extension-api'
import { createAnswerCache } from './cache.js'
import { type JudgeTarget, resolveJudgeChain } from './config.js'
import { within } from './deadline.js'
import { createJudge, createRouteCooldown, type Judge } from './judge.js'
import { object } from './questions.js'
import { createJudgmentScheduler } from './scheduler.js'

export type JudgmentContext = Pick<HookContext, 'sideCall' | 'signal' | 'session'>
export type JudgmentUse = 'stop' | 'findRelevant' | 'judgeBatch' | 'rules'
export type JudgmentStatusReason =
  | 'none'
  | 'model-not-configured'
  | 'model-unavailable'
  | 'ambiguous-model'
  | 'authorization-unavailable'
export interface JudgmentRuntime {
  stats(): { cache: { hit: number; miss: number; size: number }; requests: Record<JudgmentUse, number> }
  statusReason(): JudgmentStatusReason
  current(): readonly JudgeTarget[] | null
  subscribe(listener: () => void): () => void
  judge(ctx: JudgmentContext, requirements?: { nativeOnly?: boolean }): Promise<Judge | null>
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
  let reason: JudgmentStatusReason = sideModels ? 'model-not-configured' : 'authorization-unavailable'
  const requests: Record<JudgmentUse, number> = { stop: 0, findRelevant: 0, judgeBatch: 0, rules: 0 }
  const purposes: Record<string, JudgmentUse> = {
    'judgment.stop': 'stop',
    'judgment.find.names': 'findRelevant',
    'judgment.find.sketches': 'findRelevant',
    'judgment.find.verify': 'findRelevant',
    'judgment.batch': 'judgeBatch',
    'judgment.rules': 'rules',
  }
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
      const selected = object(config) && object(config.judge) ? config.judge : {}
      const explicit = typeof selected.route === 'string' || typeof selected.model === 'string'
      const eligible = models.filter(
        (model) =>
          (typeof selected.route === 'string'
            ? model.route === selected.route
            : model.api === 'typesafe-systemone') &&
          (typeof selected.model !== 'string' || model.model === selected.model),
      )
      reason = next
        ? 'none'
        : eligible.length
          ? 'ambiguous-model'
          : explicit
            ? 'model-unavailable'
            : 'model-not-configured'
      publish(next)
      return next
    } catch {
      reason = 'model-unavailable'
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
    reason = 'authorization-unavailable'
    for (const use of Object.keys(requests) as JudgmentUse[]) requests[use] = 0
    scheduler.dispose()
    cache.clear()
    cooldown.clear()
    ownerSignal.removeEventListener('abort', dispose)
  }
  ownerSignal.addEventListener('abort', dispose, { once: true })
  refresh()
  return {
    stats: () => ({ cache: cache.stats(), requests: { ...requests } }),
    statusReason: () => reason,
    current: () => current,
    subscribe(listener) {
      if (signal.aborted) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async judge(ctx, requirements) {
      const callSignal = AbortSignal.any([ctx.signal, signal])
      if (!ctx.sideCall || callSignal.aborted) return null
      const chain = await read(callSignal)
      if (!chain || callSignal.aborted || (requirements?.nativeOnly && !chain[0]?.native)) return null
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
        async judge(purpose, req, opts) {
          const outcome = await judge.judge(purpose, req, {
            ...opts,
            signal: AbortSignal.any([opts.signal, callSignal]),
          })
          const use = Object.hasOwn(purposes, purpose) ? purposes[purpose] : undefined
          if (use && !signal.aborted)
            requests[use] = Math.min(
              Number.MAX_SAFE_INTEGER,
              requests[use] +
                outcome.accounting.calls.filter((call) => !call.replayed && call.dispatch === 'may-have-sent')
                  .length,
            )
          return outcome
        },
      }
    },
    dispose,
  }
}
