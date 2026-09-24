import { CompactionRunner } from '@agnes/core'
import type { BuildCompactionPlan } from './packages.js'

/** Fit the trusted package policy into Core without making Core depend on Base or Host. */
export function assembleCompaction(buildPlan: BuildCompactionPlan | undefined): CompactionRunner | undefined {
  if (!buildPlan) return undefined
  return new CompactionRunner({
    plan: async (payload, config) => buildPlan(payload, config),
    onCompact: async () => undefined,
  })
}
