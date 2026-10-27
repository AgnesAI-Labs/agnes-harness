const CHANNEL_NAME = 'agnes-voice'
const CLAIM_WAIT_MS = 150
/** A claim stays on record this long, so a tab that asks a moment later yields to it. */
const CLAIM_KEEP_MS = 3_000
const HEARTBEAT_MS = 2_000
const PEER_EXPIRY_MS = 5_000

type Message =
  | { type: 'playing'; tab: string }
  | { type: 'claim'; key: string; tab: string }
  | { type: 'conversation'; tab: string; active: boolean }
  | { type: 'status-changed'; tab: string }

function parse(data: unknown): Message | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const m = data as Record<string, unknown>
  if (typeof m.tab !== 'string') return undefined
  switch (m.type) {
    case 'playing':
    case 'status-changed':
      return { type: m.type, tab: m.tab }
    case 'claim':
      return typeof m.key === 'string' ? { type: 'claim', key: m.key, tab: m.tab } : undefined
    case 'conversation':
      return typeof m.active === 'boolean'
        ? { type: 'conversation', tab: m.tab, active: m.active }
        : undefined
    default:
      return undefined
  }
}

/**
 * Coordinates the browser tabs of one profile over a BroadcastChannel: only one tab plays at a time, one tab
 * auto-reads a given reply (the lowest tab id wins), and a tab in a voice conversation tells the others.
 */
export class VoiceTabLock {
  private readonly tabId: string
  private readonly channel: BroadcastChannel | undefined
  private readonly ownsChannel: boolean
  private readonly now: () => number
  private readonly visible: () => boolean
  private readonly playing = new Set<() => void>()
  private readonly statusChanged = new Set<() => void>()
  private readonly subscribers = new Set<() => void>()
  private readonly claims = new Map<string, Set<string>>()
  private readonly peers = new Map<string, { seenAt: number; timer: ReturnType<typeof setTimeout> }>()
  private readonly pending = new Set<() => void>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(o: {
    tabId: string
    channel?: BroadcastChannel
    now?: () => number
    visible?: () => boolean
  }) {
    this.tabId = o.tabId
    this.ownsChannel = !o.channel && typeof BroadcastChannel !== 'undefined'
    this.channel = o.channel ?? (this.ownsChannel ? new BroadcastChannel(CHANNEL_NAME) : undefined)
    this.now = o.now ?? Date.now
    this.visible =
      o.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
    this.channel?.addEventListener('message', this.onMessage)
  }

  announcePlaying(): void {
    this.post({ type: 'playing', tab: this.tabId })
  }

  onPeerPlaying(listener: () => void): () => void {
    return this.add(this.playing, listener)
  }

  /**
   * True when this tab may auto-read `key`: visible, no peer claimed it before this tab asked (the first
   * claim wins), and no lower tab id claimed it within the wait (the tie-break).
   */
  async claimAuto(key: string): Promise<boolean> {
    if (this.disposed || !this.visible()) return false
    if (!this.channel) return true
    if (this.claims.has(key)) return false
    this.post({ type: 'claim', key, tab: this.tabId })
    const alive = await new Promise<boolean>((resolve) => {
      const abandon = () => resolve(false)
      this.pending.add(abandon)
      this.later(() => {
        this.pending.delete(abandon)
        resolve(true)
      }, CLAIM_WAIT_MS)
    })
    if (!alive) return false
    return ![...(this.claims.get(key) ?? [])].some((tab) => tab < this.tabId)
  }

  setConversation(active: boolean): void {
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.post({ type: 'conversation', tab: this.tabId, active })
    if (active && !this.disposed) {
      this.heartbeat = setInterval(
        () => this.post({ type: 'conversation', tab: this.tabId, active: true }),
        HEARTBEAT_MS,
      )
    }
  }

  conversationElsewhere(): boolean {
    const now = this.now()
    return [...this.peers.values()].some((peer) => now - peer.seenAt <= PEER_EXPIRY_MS)
  }

  announceStatusChanged(): void {
    this.post({ type: 'status-changed', tab: this.tabId })
  }

  onStatusChanged(listener: () => void): () => void {
    return this.add(this.statusChanged, listener)
  }

  /** Notified when `conversationElsewhere()` may have changed. */
  subscribe(listener: () => void): () => void {
    return this.add(this.subscribers, listener)
  }

  /**
   * Stops listening and timing. It does not announce the end of a conversation (call `setConversation(false)`
   * first): peers drop a vanished tab after the heartbeat expiry, as they do after a crash.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const timer of this.timers) clearTimeout(timer)
    for (const peer of this.peers.values()) clearTimeout(peer.timer)
    this.timers.clear()
    this.peers.clear()
    this.claims.clear()
    for (const abandon of [...this.pending]) abandon()
    this.pending.clear()
    this.channel?.removeEventListener('message', this.onMessage)
    if (this.ownsChannel) this.channel?.close()
    for (const set of [this.playing, this.statusChanged, this.subscribers]) set.clear()
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const message = parse(event.data)
    if (!message || message.tab === this.tabId || this.disposed) return
    switch (message.type) {
      case 'playing':
        for (const listener of [...this.playing]) listener()
        return
      case 'status-changed':
        for (const listener of [...this.statusChanged]) listener()
        return
      case 'claim':
        this.recordClaim(message.key, message.tab)
        return
      case 'conversation':
        this.recordConversation(message.tab, message.active)
    }
  }

  private recordClaim(key: string, tab: string): void {
    const tabs = this.claims.get(key) ?? new Set<string>()
    this.claims.set(key, tabs)
    tabs.add(tab)
    this.later(() => {
      tabs.delete(tab)
      if (tabs.size === 0 && this.claims.get(key) === tabs) this.claims.delete(key)
    }, CLAIM_KEEP_MS)
  }

  private recordConversation(tab: string, active: boolean): void {
    const before = this.conversationElsewhere()
    const known = this.peers.get(tab)
    if (known) clearTimeout(known.timer)
    if (active) {
      const timer = setTimeout(() => {
        this.peers.delete(tab)
        this.notify()
      }, PEER_EXPIRY_MS)
      this.peers.set(tab, { seenAt: this.now(), timer })
    } else {
      this.peers.delete(tab)
    }
    if (before !== this.conversationElsewhere()) this.notify()
  }

  private notify(): void {
    for (const listener of [...this.subscribers]) listener()
  }

  private later(run: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, ms)
    this.timers.add(timer)
  }

  private add(set: Set<() => void>, listener: () => void): () => void {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  private post(message: Message): void {
    if (!this.disposed) this.channel?.postMessage(message)
  }
}
