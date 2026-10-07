import { CompactionRunner } from '@agnes/core'
import type { CompactionEngine, CompactionPlan, HookPayloadMap } from '@agnes/extension-api'
import { buildCompactionPlan } from './plan.js'

/** Preserve the package-owned planner and Core's existing threshold/overflow policy. */
export function createDefaultCompactionEngine(
  plan: (
    payload: HookPayloadMap['before_compact'],
    config: Readonly<{ keepRecentTokens: number }>,
  ) => CompactionPlan | null | Promise<CompactionPlan | null> = buildCompactionPlan,
): CompactionEngine {
  return {
    id: 'default',
    version: '1.0.0',
    create: () =>
      new CompactionRunner({
        plan: async (payload, config) => plan(payload, config),
        onCompact: async () => undefined,
      }),
  }
}
