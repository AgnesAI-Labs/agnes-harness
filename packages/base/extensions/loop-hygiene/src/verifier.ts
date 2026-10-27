import type { VerifierSeam, VerifierVerdict } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'

export type VerifyInput = {
  toolCalls: Array<{
    name: string
    args: unknown
    schemaOk: boolean
    isReadOnly?: boolean
    rejected?: boolean
  }>
  deviations: number
  recentToolKeys: string[]
  surfaceTailHashes: string[]
  newToolResults: number
  lastFinishReason?: 'stop' | 'length' | 'tool_use' | 'error'
  /** Step scope, in a turn under a prompt limit or unattended: the turn's last few steps. */
  history?: Pick<VerifyInput, 'toolCalls' | 'recentToolKeys' | 'surfaceTailHashes' | 'newToolResults'>
}

type Call = VerifyInput['toolCalls'][number]
const invalid = (c: Call) => !c.schemaOk && !c.rejected

/**
 * Over a whole turn, an invalid call counts only while it still stands: no later valid call to the
 * same tool replaced it, or the same tool was called invalidly again. One slip the model corrected
 * says nothing about the answer the turn ended with.
 */
export function unresolvedInvalid(calls: readonly Call[]): boolean {
  const slips = new Map<string, { count: number; open: boolean }>()
  for (const c of calls) {
    const slip = slips.get(c.name)
    if (invalid(c)) slips.set(c.name, { count: (slip?.count ?? 0) + 1, open: true })
    else if (slip && c.schemaOk && !c.rejected) slip.open = false
  }
  return [...slips.values()].some((slip) => slip.open || slip.count > 1)
}

/**
 * Tier 0: five pure checks over one step/turn's worth of shape, no model call. `tool`/`step` scope
 * only sees the failure-grade checks (schema, deviation, truncation), and `turn`/`task` scope reads
 * the schema check as the turn's outcome (see `unresolvedInvalid`); `turn`/`task` scope adds the
 * two revision-grade checks (repeat, no-progress) that need a run of history to make sense of. A
 * `step` input that carries `history` (a limited or unattended turn) gets them too, over that
 * history; core turns such a step verdict into a progress check, never into a stop.
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
      if (scope === 'turn' || scope === 'task' ? unresolvedInvalid(x.toolCalls) : x.toolCalls.some(invalid))
        fail.push('schema_invalid')
      if (x.deviations > 0) fail.push('tool_call_as_text')
      if (x.lastFinishReason === 'length') fail.push('output_truncated')
      const h = scope === 'turn' || scope === 'task' ? x : scope === 'step' ? x.history : undefined
      if (h) {
        const keys = h.recentToolKeys
        // Longest run of an identical (tool, args) key at the tail, not just anywhere in the
        // window: a model that repeats after trying something else in between is not stuck the
        // same way one that repeats back-to-back is.
        // A read breaks the run; filtering it out would join nonconsecutive writes. Older
        // callers without aligned policy metadata retain conservative repeat detection.
        let run = 0
        for (let i = 0; i < keys.length; i++) {
          if (
            h.toolCalls.length === keys.length &&
            (h.toolCalls[i]?.isReadOnly === true || h.toolCalls[i]?.rejected === true)
          )
            run = 0
          else run = i > 0 && keys[i] === keys[i - 1] ? run + 1 : 1
        }
        if (keys.length >= repeatThreshold && run >= repeatThreshold) revise.push(`repeated_write:${run}`)
        const hashes = h.surfaceTailHashes
        if (
          hashes.length >= noProgressSteps &&
          new Set(hashes.slice(-noProgressSteps)).size === 1 &&
          h.newToolResults === 0
        )
          revise.push(`no_progress:${noProgressSteps}`)
      }
      if (fail.length) return { verdict: 'fail', reasons: fail }
      if (revise.length) return { verdict: 'needs_revision', reasons: revise }
      return { verdict: 'pass', reasons: [] }
    },
  }
}
