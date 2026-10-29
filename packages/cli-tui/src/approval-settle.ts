/** How long the approval in front of the user must sit untouched before a single key may decide it. */
export const SETTLE_MS = 600

/**
 * The misclick guard for single-key approvals. A card is "settled" once SETTLE_MS have passed since
 * it appeared (or became a different card) and since the last key of any kind, so typing that is
 * already under way when a card pops up never lands on it. `press` says whether the card was settled
 * before the key arrived and restarts the wait either way; Esc is the caller's to let through.
 */
export class ApprovalSettle {
  private current: string | undefined
  private until = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly repaint: () => void,
    /** Identity of the approval now in front of the user, or undefined when there is none. */
    private readonly identity: () => string | undefined,
    private readonly ms = SETTLE_MS,
  ) {}

  /** Notices a new or replaced approval; every key and every paint of a hint (`settled`) goes through it. */
  watch(): void {
    const key = this.identity()
    if (key === this.current) return
    this.current = key
    if (key === undefined) this.stop()
    else this.arm()
  }

  /** Whether a decision key would count right now (the card's hints use this to light up). */
  get settled(): boolean {
    this.watch()
    return Date.now() >= this.until
  }

  press(): boolean {
    this.watch()
    const settled = this.settled
    if (this.current !== undefined) this.arm()
    return settled
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    this.until = Date.now() + this.ms
    clearTimeout(this.timer)
    this.timer = setTimeout(this.repaint, this.ms + 5)
    this.timer.unref?.()
  }
}
