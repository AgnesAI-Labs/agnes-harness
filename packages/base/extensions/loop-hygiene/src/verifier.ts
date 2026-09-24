import type { VerifierSeam, VerifierVerdict } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'

export type VerifyInput = {
  toolCalls: Array<{ name: string; args: unknown; schemaOk: boolean }>
  deviations: number
  recentToolKeys: string[]
  surfaceTailHashes: string[]
  newToolResults: number
  lastFinishReason?: 'stop' | 'length' | 'tool_use' | 'error'
}

/**
 * Tier 0: five pure checks over one step/turn's worth of shape, no model call. `tool`/`step` scope
 * only sees the failure-grade checks (schema, deviation, truncation); `turn`/`task` scope adds the
 * two revision-grade checks (repeat, no-progress) that need a run of history to make sense of.
 */
export const verifierT0: SeamFactory<VerifierSeam> = async (ctx) => {
  const loop = (ctx.profile.preset.loop ?? {}) as { repeat_threshold?: number; no_progress_steps?: number }
  const repeatThreshold = loop.repeat_threshold ?? 3
  const noProgressSteps = loop.no_progress_steps ?? 4
  return {
    async verify(scope, input): Promise<VerifierVerdict> {
      const x = input as VerifyInput
      const fail: string[] = []
      const revise: string[] = []
      if (x.toolCalls.some((c) => !c.schemaOk)) fail.push('schema_invalid')
      if (x.deviations > 0) fail.push('tool_call_as_text')
      if (x.lastFinishReason === 'length') fail.push('output_truncated')
      if (scope === 'turn' || scope === 'task') {
        const keys = x.recentToolKeys
        // Longest run of an identical (tool, args) key at the tail, not just anywhere in the
        // window: a model that repeats after trying something else in between is not stuck the
        // same way one that repeats back-to-back is.
        let run = 1
        for (let i = 1; i < keys.length; i++) run = keys[i] === keys[i - 1] ? run + 1 : 1
        if (keys.length >= repeatThreshold && run >= repeatThreshold) revise.push(`repeated_write:${run}`)
        const h = x.surfaceTailHashes
        if (
          h.length >= noProgressSteps &&
          new Set(h.slice(-noProgressSteps)).size === 1 &&
          x.newToolResults === 0
        )
          revise.push(`no_progress:${noProgressSteps}`)
      }
      if (fail.length) return { verdict: 'fail', reasons: fail }
      if (revise.length) return { verdict: 'needs_revision', reasons: revise }
      return { verdict: 'pass', reasons: [] }
    },
  }
}
