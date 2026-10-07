import { CompactionRunner } from '@agnes/core'
import type { CompactionEngine, CompactionPlan, HookPayloadMap } from '@agnes/extension-api'
import { buildCompactionPlan } from './plan.js'
import { type CompactionQualityConfig, prepareCompaction, resolveCompactionQualityConfig } from './prepare.js'

export type { CompactionQualityConfig } from './prepare.js'
export { resolveCompactionQualityConfig } from './prepare.js'

/**
 * Preserve the package-owned planner and Core's existing threshold/overflow policy.
 * The optional quality config is an engine argument. Host still calls this with the planner only,
 * so production uses the defaults until a caller passes thresholds through.
 */
export function createDefaultCompactionEngine(
  plan: (
    payload: HookPayloadMap['before_compact'],
    config: Readonly<{ keepRecentTokens: number }>,
  ) => CompactionPlan | null | Promise<CompactionPlan | null> = buildCompactionPlan,
  config?: Partial<CompactionQualityConfig>,
): CompactionEngine {
  const quality = resolveCompactionQualityConfig(config)
  return {
    id: 'default',
    version: '1.0.0',
    create: () => {
      const inner = new CompactionRunner({
        plan: async (payload, compactConfig) => plan(payload, compactConfig),
        onCompact: async () => undefined,
      })
      return {
        shouldCompact: (budget) => inner.shouldCompact(budget),
        async compact(input, ports) {
          const prepared = prepareCompaction(input, quality)
          if (prepared) return prepared
          return inner.compact(input, ports)
        },
      }
    },
  }
}
