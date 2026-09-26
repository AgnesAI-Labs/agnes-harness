/** Internal signal from the bundled prompt hook when a cold compaction reaches context first. */
export class HookBlockedError extends Error {
  readonly name = 'HookBlockedError'
  readonly reason: string

  constructor(reason: string) {
    const safe = reason.replace(/[\r\n\0]+/gu, ' ').slice(0, 1024) || 'hook blocked'
    super(safe)
    this.reason = safe
  }
}
