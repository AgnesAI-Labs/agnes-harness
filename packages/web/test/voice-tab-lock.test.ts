import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceTabLock } from '../src/voice/tab-lock.js'

class FakeChannel {
  readonly sent: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent) => void>()
  readonly peers: FakeChannel[] = []
  closed = false
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }
  postMessage(data: unknown): void {
    this.sent.push(data)
    for (const peer of this.peers) peer.receive(data)
  }
  receive(data: unknown): void {
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent)
  }
  close(): void {
    this.closed = true
  }
}

function pair(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel()
  const b = new FakeChannel()
  a.peers.push(b)
  b.peers.push(a)
  return [a, b]
}

function lock(tabId: string, channel: FakeChannel, visible = () => true): VoiceTabLock {
  return new VoiceTabLock({ tabId, channel: channel as unknown as BroadcastChannel, visible })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('VoiceTabLock', () => {
  it('stops the other tab when one starts playing', () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const b = lock('b', cb)
    const heardByB = vi.fn()
    const heardByA = vi.fn()
    b.onPeerPlaying(heardByB)
    a.onPeerPlaying(heardByA)
    a.announcePlaying()
    expect(heardByB).toHaveBeenCalledTimes(1)
    expect(heardByA).not.toHaveBeenCalled()
    const other = vi.fn()
    const off = b.onPeerPlaying(other)
    a.announcePlaying()
    expect(other).toHaveBeenCalledTimes(1)
    off()
    a.announcePlaying()
    expect(other).toHaveBeenCalledTimes(1)
    expect(heardByB).toHaveBeenCalledTimes(3)
  })

  it('lets the lower tab id win an auto-read claim for the same key', async () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const b = lock('b', cb)
    const ra = a.claimAuto('s:t1')
    const rb = b.claimAuto('s:t1')
    let settled = false
    void rb.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(149)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await ra).toBe(true)
    expect(await rb).toBe(false)
  })

  it('does not let a claim for another key block the claimant', async () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const b = lock('b', cb)
    const ra = a.claimAuto('s:t1')
    const rb = b.claimAuto('s:t2')
    await vi.advanceTimersByTimeAsync(150)
    expect(await ra).toBe(true)
    expect(await rb).toBe(true)
  })

  it('wins alone, and again for a later claim of the same key', async () => {
    const [ca, cb] = pair()
    const b = lock('b', cb)
    lock('a', ca)
    const first = b.claimAuto('s:t1')
    await vi.advanceTimersByTimeAsync(150)
    expect(await first).toBe(true)
  })

  it('refuses an auto-read claim from a hidden page without posting a claim', async () => {
    const [ca, cb] = pair()
    const hidden = lock('a', ca, () => false)
    const shown = lock('b', cb)
    expect(await hidden.claimAuto('s:t1')).toBe(false)
    expect(ca.sent).toEqual([])
    const claim = shown.claimAuto('s:t1')
    await vi.advanceTimersByTimeAsync(150)
    expect(await claim).toBe(true)
  })

  it('resolves a pending claim as false when the lock is disposed', async () => {
    const [ca] = pair()
    const a = lock('a', ca)
    const claim = a.claimAuto('s:t1')
    a.dispose()
    expect(await claim).toBe(false)
  })

  it('marks a conversation elsewhere until its heartbeat expires', async () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const b = lock('b', cb)
    const seen = vi.fn()
    a.subscribe(seen)
    expect(a.conversationElsewhere()).toBe(false)
    b.setConversation(true)
    expect(a.conversationElsewhere()).toBe(true)
    expect(b.conversationElsewhere()).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(a.conversationElsewhere()).toBe(true)
    expect(seen).toHaveBeenCalledTimes(1)
    b.dispose()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(a.conversationElsewhere()).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(a.conversationElsewhere()).toBe(false)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('clears the conversation at once when the peer ends it', () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const b = lock('b', cb)
    const seen = vi.fn()
    const off = a.subscribe(seen)
    b.setConversation(true)
    b.setConversation(false)
    expect(a.conversationElsewhere()).toBe(false)
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    b.setConversation(true)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('stops posting heartbeats after the conversation ends', async () => {
    const [ca] = pair()
    const a = lock('a', ca)
    a.setConversation(true)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(ca.sent.filter((m) => (m as { active?: boolean }).active === true)).toHaveLength(3)
    a.setConversation(false)
    const before = ca.sent.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ca.sent.length).toBe(before)
  })

  it('relays status-changed notices to peers only', () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const b = lock('b', cb)
    const onB = vi.fn()
    const onA = vi.fn()
    b.onStatusChanged(onB)
    a.onStatusChanged(onA)
    a.announceStatusChanged()
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onA).not.toHaveBeenCalled()
  })

  it('ignores malformed messages and stops listening after dispose', () => {
    const [ca, cb] = pair()
    const a = lock('a', ca)
    const heard = vi.fn()
    a.onPeerPlaying(heard)
    for (const junk of [
      null,
      'x',
      5,
      {},
      { type: 'playing' },
      { type: 'conversation', tab: 'x' },
      { type: 'nope', tab: 'x' },
    ]) {
      cb.postMessage(junk)
    }
    expect(heard).not.toHaveBeenCalled()
    expect(a.conversationElsewhere()).toBe(false)
    a.dispose()
    cb.postMessage({ type: 'playing', tab: 'b' })
    expect(heard).not.toHaveBeenCalled()
  })

  it('works without a channel (no BroadcastChannel)', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const a = new VoiceTabLock({ tabId: 'a', visible: () => true })
    a.announcePlaying()
    a.setConversation(true)
    a.announceStatusChanged()
    expect(a.conversationElsewhere()).toBe(false)
    expect(await a.claimAuto('k')).toBe(true)
    a.dispose()
  })
})
