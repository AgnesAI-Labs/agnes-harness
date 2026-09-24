import { randomUUID } from 'node:crypto'
import { AGNES_ERRORS } from '@agnes/protocol'
import { type Client, JsonRpcError, type Session } from '@agnes/sdk'

export type BoundSession = Pick<
  Session,
  | 'id'
  | 'steer'
  | 'followUp'
  | 'cancel'
  | 'setPreset'
  | 'onPermissionRequest'
  | 'budget'
  | 'events'
  | 'projectUI'
  | 'detach'
>

type SessionClient = {
  session: {
    attach(id: string, options?: Parameters<Client['session']['attach']>[1]): Promise<BoundSession>
    new: (options: Parameters<Client['session']['new']>[0]) => Promise<BoundSession>
  }
}

type Entry = {
  session: BoundSession
  running: boolean
  participants: Set<string>
}

export class SessionCache {
  private readonly entries = new Map<string, Entry>()
  private readonly opening = new Map<string, Promise<{ session: BoundSession; created: boolean }>>()
  private readonly ownership = new Map<string, number>()
  private ownershipSequence = 0
  private stopped = false

  constructor(
    private readonly client: SessionClient,
    private readonly config: { cwd: string; preset: string },
    private readonly options: {
      maxPendingKeys?: number
      onRemove?: (key: string, session: BoundSession) => void
    } = {},
  ) {}

  async get(key: string): Promise<{ session: BoundSession; created: boolean }> {
    if (this.stopped) throw new Error('session cache is stopped')
    const cached = this.entries.get(key)
    if (cached !== undefined) return { session: cached.session, created: false }
    const pending = this.opening.get(key)
    if (pending !== undefined) return pending
    if (this.opening.size >= this.maxPendingKeys()) {
      throw new Error('session cache opening capacity reached')
    }

    const token = this.claim(key)
    const opening = this.open(key, token).finally(() => {
      if (this.opening.get(key) === opening) this.opening.delete(key)
      this.release(key, token)
    })
    this.opening.set(key, opening)
    return opening
  }

  busy(key: string): boolean {
    return this.entries.get(key)?.running ?? false
  }

  markTurn(key: string, running: boolean): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) entry.running = running
  }

  markParticipant(key: string, userId: string): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.participants.has(userId)) return false
    entry.participants.add(userId)
    return true
  }

  unmarkParticipant(key: string, userId: string): void {
    this.entries.get(key)?.participants.delete(userId)
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  owns(key: string, session: BoundSession): boolean {
    return this.entries.get(key)?.session === session
  }

  current(key: string): BoundSession | undefined {
    return this.entries.get(key)?.session
  }

  invalidate(key: string): void {
    const entry = this.entries.get(key)
    this.entries.delete(key)
    this.ownership.delete(key)
    if (entry !== undefined) this.removed(key, entry.session)
  }

  async evict(key: string, expected?: BoundSession): Promise<boolean> {
    const entry = this.entries.get(key)
    if (expected !== undefined && entry?.session !== expected) return false
    const token = this.claim(key)
    try {
      this.entries.delete(key)
      if (entry !== undefined) this.removed(key, entry.session)
      await entry?.session.detach().catch(() => undefined)
      return true
    } finally {
      this.release(key, token)
    }
  }

  async renew(key: string): Promise<BoundSession> {
    if (this.stopped) throw new Error('session cache is stopped')
    const token = this.claim(key)
    try {
      const previous = this.entries.get(key)
      const created = await this.client.session.new({
        cwd: this.config.cwd,
        preset: this.config.preset,
        sessionKey: `${key}:thread:${randomUUID()}`,
      })
      const session = await this.client.session.attach(created.id, { filter: attachFilter() })
      if (this.ownership.get(key) !== token) {
        await session.detach().catch(() => undefined)
        if (this.stopped) throw new Error('session cache stopped while renewing')
        throw new Error(`session ownership changed while renewing ${key}`)
      }
      this.entries.set(key, { session, running: false, participants: new Set() })
      await previous?.session.detach().catch(() => undefined)
      if (this.ownership.get(key) !== token || this.entries.get(key)?.session !== session) {
        if (this.entries.get(key)?.session === session) this.entries.delete(key)
        await session.detach().catch(() => undefined)
        if (this.stopped) throw new Error('session cache stopped while renewing')
        throw new Error(`session ownership changed while detaching previous session for ${key}`)
      }
      return session
    } finally {
      this.release(key, token)
    }
  }

  private async open(key: string, token: number): Promise<{ session: BoundSession; created: boolean }> {
    const filter = attachFilter()
    let session: BoundSession
    let created = false
    try {
      session = await this.client.session.attach(key, { filter })
    } catch (error) {
      if (!(error instanceof JsonRpcError) || error.code !== AGNES_ERRORS.SESSION_NOT_FOUND) {
        throw error
      }
      await this.client.session.new({
        cwd: this.config.cwd,
        preset: this.config.preset,
        sessionKey: key,
      })
      session = await this.client.session.attach(key, { filter })
      created = true
    }
    if (this.ownership.get(key) !== token) {
      await session.detach().catch(() => undefined)
      const current = this.entries.get(key)?.session
      if (current !== undefined) return { session: current, created: false }
      if (this.stopped) throw new Error('session cache stopped while opening')
      throw new Error(`session ownership changed while opening ${key}`)
    }
    this.entries.set(key, { session, running: false, participants: new Set() })
    return { session, created }
  }

  private claim(key: string): number {
    if (!this.ownership.has(key) && this.ownership.size >= this.maxPendingKeys()) {
      throw new Error('session cache ownership capacity reached')
    }
    const token = ++this.ownershipSequence
    this.ownership.set(key, token)
    return token
  }

  private release(key: string, token: number): void {
    if (this.ownership.get(key) === token) this.ownership.delete(key)
  }

  private maxPendingKeys(): number {
    return Math.max(1, this.options.maxPendingKeys ?? 1_024)
  }

  private removed(key: string, session: BoundSession): void {
    try {
      this.options.onRemove?.(key, session)
    } catch {
      // Cache ownership and detach cannot depend on an observer's bookkeeping.
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.ownership.clear()
    const entries = [...this.entries]
    this.entries.clear()
    for (const [key, entry] of entries) this.removed(key, entry.session)
    await Promise.allSettled(entries.map(([, entry]) => entry.session.detach()))
  }
}

function attachFilter(): { acpUpdates: false } {
  return { acpUpdates: false }
}
