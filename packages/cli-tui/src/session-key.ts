import { randomUUID } from 'node:crypto'

/**
 * Interactive TUI launches are conversations, not workspace singletons.  A caller that wants an
 * existing conversation uses --resume; both a plain launch and /new need a key that cannot inherit
 * queued input from an earlier process in the same working directory.
 */
export function freshTuiSessionKey(profile: string): string {
  return `agnes:local:${profile}:cli:session:${randomUUID()}`
}
