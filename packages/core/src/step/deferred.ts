import { canonicalJson, sha256Hex } from '../request/hash.js'

/**
 * Stable identity for the external job that outlives its originating tool effect. Both parts are
 * required: one idempotent job may be returned to two calls, and each call still needs its own
 * result and settlement on replay.
 */
export function deferredEffectId(jobId: string, toolUseId: string): string {
  // Both source ids may legally be 128 bytes, while protocol caps an effectId at 128. Hash the
  // canonical pair instead of concatenating it, which would make the longest valid deferred job
  // impossible to record and would strand the originating tool call after it had already run.
  return `job-${sha256Hex(canonicalJson([jobId, toolUseId]))}`
}
