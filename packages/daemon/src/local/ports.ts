export type CompactOutcome =
  | { state: 'completed'; endSeq: number }
  | { state: 'failed'; endSeq: number }
  | { state: 'unknown' }
export type JournalResult = { seq?: number; result?: unknown; compact?: CompactOutcome }
export type JournalIdentity = {
  principalId: string
  clientId: string
  sessionId: string
  commandId: string
}
export type JournalBinding = {
  algorithm: 'agnes-command-jcs-sha256-v1'
  digest: string
  kind: string
  generation: number | null
}
export type JournalState =
  | { state: 'new' }
  | { state: 'complete'; result: JournalResult }
  | { state: 'uncertain' }
  | { state: 'conflict' }
  | { state: 'corrupt' }

export interface CommandJournal {
  begin(identity: JournalIdentity, binding: JournalBinding): Promise<JournalState>
  complete(identity: JournalIdentity, result: JournalResult): Promise<void>
  /** Frees a row whose dispatch threw. A row that already has a result is left alone: that result is
   *  the idempotency evidence. Without this, one failed dispatch makes the commandId answer
   *  'uncertain' for as long as the journal lives. */
  abandon(identity: JournalIdentity): Promise<void>
  /** Marks a completed receipt delivered and reports whether that receipt exists. */
  ack(identity: JournalIdentity): Promise<boolean>
  gc(now: number): Promise<number>
}

export interface ClaimStore {
  once(kind: string, value: string, expiresAtMs: number, now: number): Promise<boolean>
  withinRateLimit(
    kind: string,
    value: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<{ granted: boolean; slot: number }>
}

export interface JobsPort {
  enqueue(spec: unknown, o: { local: boolean }): Promise<{ jobId: string }>
  /** Trusted reverse lookup used to authorize poll/cancel from the stored job, never request data. */
  sessionKey(jobId: string): Promise<string | undefined>
  poll(jobId: string): Promise<unknown>
  cancel(jobId: string): Promise<void>
}

export type SessionMetaRow = {
  sessionId: string
  parent?: string
  createdAt: string
  lastSeq: number
  generation: number
  preset: string | null
  title?: string
  titleSource?: 'user'
  archived?: boolean
  cwd?: string
}
export interface SessionLister {
  list(q: {
    q?: string
    cwd?: string
    cursor?: string
    limit?: number
    /** Server-derived active owner scope. Implementations filter this before pagination. */
    sessionIds?: readonly string[]
  }): Promise<{
    items: SessionMetaRow[]
    cursor?: string
  }>
}

export interface DirectoryPort {
  upsert(entries: unknown[]): Promise<{ upserted: number; deleted: number }>
}

type JRow = {
  binding: JournalBinding
  receivedAt: number
  result?: JournalResult
  resultAt?: number
  ackedAt?: number
}

/** The local form: it lives in this process and dies with it. A restart is a new journal, which is
 *  the honest answer for a socket whose clients died with it. */
export class MemoryJournal implements CommandJournal {
  private rows = new Map<string, JRow>()
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private k(i: JournalIdentity): string {
    return `${i.principalId}\u0000${i.clientId}\u0000${i.sessionId}\u0000${i.commandId}`
  }

  async begin(identity: JournalIdentity, binding: JournalBinding): Promise<JournalState> {
    const r = this.rows.get(this.k(identity))
    if (!r) {
      this.rows.set(this.k(identity), { binding, receivedAt: this.clock() })
      return { state: 'new' }
    }
    if (
      !/^agnes-command-jcs-sha256-v1$/.test(r.binding.algorithm) ||
      !/^[0-9a-f]{64}$/.test(r.binding.digest)
    )
      return { state: 'corrupt' }
    if (
      r.binding.algorithm !== binding.algorithm ||
      r.binding.digest !== binding.digest ||
      r.binding.kind !== binding.kind ||
      r.binding.generation !== binding.generation
    )
      return { state: 'conflict' }
    return r.result ? { state: 'complete', result: r.result } : { state: 'uncertain' }
  }

  async complete(identity: JournalIdentity, result: JournalResult): Promise<void> {
    const r = this.rows.get(this.k(identity))
    if (r) {
      r.result = result
      r.resultAt = this.clock()
    }
  }

  async abandon(identity: JournalIdentity): Promise<void> {
    const r = this.rows.get(this.k(identity))
    if (r && !r.result) this.rows.delete(this.k(identity))
  }

  async ack(identity: JournalIdentity): Promise<boolean> {
    const r = this.rows.get(this.k(identity))
    if (!r?.result) return false
    if (r.ackedAt === undefined) r.ackedAt = this.clock()
    return true
  }

  /** Only acknowledged rows expire. An unacknowledged one is still the answer to a retry nobody has
   *  confirmed receiving, so age alone is not a reason to drop it. */
  async gc(now: number): Promise<number> {
    let n = 0
    for (const [k, r] of this.rows)
      if (r.ackedAt !== undefined && now - r.ackedAt > 24 * 3600_000) {
        this.rows.delete(k)
        n++
      }
    return n
  }
}

export class MemoryClaims implements ClaimStore {
  private singles = new Map<string, number>()
  private windows = new Map<string, number[]>()

  async once(kind: string, value: string, expiresAtMs: number, now: number): Promise<boolean> {
    const k = `${kind}:${value}`
    const exp = this.singles.get(k)
    // Strictly greater: expiresAtMs is the moment the claim stops holding, so at exactly that instant
    // the value is free again. `>=` would keep it held for one more tick, which is a boundary no
    // caller can see and no test would catch.
    if (exp !== undefined && exp > now) return false
    this.singles.set(k, expiresAtMs)
    return true
  }

  async withinRateLimit(
    kind: string,
    value: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<{ granted: boolean; slot: number }> {
    const k = `${kind}:${value}`
    const hits = (this.windows.get(k) ?? []).filter((t) => now - t < windowMs)
    const granted = hits.length < limit
    if (granted) hits.push(now)
    this.windows.set(k, hits)
    return { granted, slot: hits.length }
  }
}
