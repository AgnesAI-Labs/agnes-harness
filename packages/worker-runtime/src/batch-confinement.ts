import type { Host } from '@agnes/host'
import { BATCH_ITEM_SESSION_PATTERN } from '@agnes/protocol'

/** The bundled extension whose `tool_call` hook keeps a batch item session to the read tool. */
const BATCH_EXTENSION = 'agnes/batch'

/**
 * Whether this Host has the built-in batch extension's `tool_call` hook registered right now. Only
 * the built-in registration counts: a replacement row is held to registering the hook, not to what
 * it decides, so a batch item must not run under one. Any failure to tell reads as "not live".
 */
export function batchItemConfinementLive(host: Pick<Host, 'kernel'>): boolean {
  try {
    return host.kernel.hooks
      .snapshot(BATCH_EXTENSION)
      .entries('tool_call')
      .some((entry) => entry.meta.source === BATCH_EXTENSION && entry.meta.trust === 'builtin')
  } catch {
    return false
  }
}

/**
 * Refuses to open or run a batch item session in a Host where the hook is not live. Keys are matched
 * on their pattern alone: this only takes something away, so a user key that happens to match is
 * merely held to the same rule.
 */
export function assertBatchItemConfinement(host: Pick<Host, 'kernel'>, sessionKey: string): void {
  if (BATCH_ITEM_SESSION_PATTERN.test(sessionKey) && !batchItemConfinementLive(host))
    throw new Error(
      'batch item sessions cannot run here: the hook that keeps them to the read tool is not active',
    )
}
