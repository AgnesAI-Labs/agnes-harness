import type { ChannelCapabilities, ChannelManifest, UITimeline } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { ChannelAdapter, ChannelMessage, ChatTarget, MessageRef } from '../adapter.js'
import { type DegradedCap, degrade } from '../degrade.js'
import { backoffDelays } from './backoff.js'
import type { RunnerConfig } from './config.js'
import { contentHash, whatToDraw } from './draw.js'
import type { DeliveryRefRow, RefPart, RefStore } from './ref-store.js'
import type { SessionCache } from './session-cache.js'
import { chunkText, TokenBucket } from './throttle.js'

type Log = {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

type OutboundSession = Pick<Session, 'id' | 'events' | 'projectUI'>

type OutboundDeps = {
  adapter: ChannelAdapter
  refs: RefStore
  cache: Pick<SessionCache, 'markTurn'>
  cfg: Pick<RunnerConfig, 'outbound'>
  caps: ChannelCapabilities
  limits: ChannelManifest['limits']
  log: Log
  debounceMs?: number
  artifactsUrl?: string
  /** Test seam; production deliberately remains one message per session per second. */
  rates?: { sessionPerSec?: number }
  noticeRetry?: { attempts?: number; baseMs?: number; maxMs?: number; jitter?: () => number }
  stopSettleMs?: number
  maxDetachedWork?: number
}

type Watermark = Pick<UITimeline, 'generation' | 'upto'>
type Lane = {
  session: OutboundSession
  chat: ChatTarget
  timer?: ReturnType<typeof setTimeout>
  bucket: TokenBucket
  flushing: Promise<void>
  stop: AbortController
  degraded: Set<DegradedCap>
  watermark?: Watermark
  pumping?: Promise<void>
}

export class Outbound {
  private readonly lanes = new Map<string, Lane>()
  private readonly detachedPumps = new Set<Promise<void>>()
  private readonly accountBucket: TokenBucket
  private stopped = false
  onDegraded?: (sessionKey: string, capability: DegradedCap) => void

  constructor(private readonly dependencies: OutboundDeps) {
    const rate = dependencies.limits.rate?.perAccountPerSec ?? 20
    this.accountBucket = new TokenBucket({ tokensPerSecond: rate, capacity: Math.max(1, rate) })
  }

  attach(sessionKey: string, session: OutboundSession, chat: ChatTarget): void {
    if (this.stopped || this.lanes.has(sessionKey)) return
    const lane: Lane = {
      session,
      chat,
      bucket: new TokenBucket({
        tokensPerSecond: this.dependencies.rates?.sessionPerSec ?? 1,
        capacity: 1,
      }),
      flushing: Promise.resolve(),
      stop: new AbortController(),
      degraded: new Set(),
    }
    this.lanes.set(sessionKey, lane)
    lane.pumping = this.pump(sessionKey, lane)
  }

  detach(sessionKey: string, options: { retire?: boolean } = {}): void {
    const lane = this.lanes.get(sessionKey)
    if (lane === undefined) return
    lane.stop.abort()
    if (options.retire === true) this.dependencies.refs.retireSession(sessionKey, lane.session.id)
    if (lane.timer !== undefined) clearTimeout(lane.timer)
    this.lanes.delete(sessionKey)
    this.trackDetached(lane.flushing)
    if (lane.pumping !== undefined) this.trackDetached(lane.pumping)
  }

  keys(): string[] {
    return [...this.lanes.keys()]
  }

  flushSession(sessionId: string, reason: 'gap' | 'generationChanged'): Promise<void> {
    const matches = [...this.lanes]
      .filter(([, lane]) => lane.session.id === sessionId)
      .map(([key]) => this.flush(key, { reason }))
    return Promise.all(matches).then(() => undefined)
  }

  async stop(): Promise<void> {
    this.stopped = true
    const pending = [
      ...this.detachedPumps,
      ...[...this.lanes.values()].flatMap((lane) => [lane.flushing, lane.pumping]),
    ]
    for (const key of this.keys()) this.detach(key)
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, this.dependencies.stopSettleMs ?? 1_000)),
    ])
  }

  flush(
    sessionKey: string,
    _options: { reason?: 'gap' | 'generationChanged' | 'event' } = {},
  ): Promise<void> {
    const lane = this.lanes.get(sessionKey)
    if (lane === undefined) return Promise.resolve()
    lane.flushing = lane.flushing.catch(() => undefined).then(() => this.render(sessionKey, lane))
    return lane.flushing
  }

  sendNotice(sessionKey: string, message: ChannelMessage, deliveryKey: string): Promise<void> {
    const lane = this.lanes.get(sessionKey)
    if (lane === undefined || !this.isCurrent(sessionKey, lane)) return Promise.resolve()
    lane.flushing = lane.flushing
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(sessionKey, lane)) return
        const retry = this.dependencies.noticeRetry
        const attempts = Math.max(1, Math.min(10, Math.floor(retry?.attempts ?? 3)))
        const delays = backoffDelays(retry)
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            await this.take(lane)
            await this.dependencies.adapter.send({ ...lane.chat, deliveryKey }, message)
            return
          } catch (error) {
            if (!this.isCurrent(sessionKey, lane) || attempt === attempts) throw error
            await delay(delays.next().value, lane.stop.signal)
          }
        }
      })
    return lane.flushing
  }

  private async pump(sessionKey: string, lane: Lane): Promise<void> {
    let failures = 0
    while (this.isCurrent(sessionKey, lane)) {
      try {
        const iterator = lane.session.events()[Symbol.asyncIterator]()
        try {
          while (true) {
            const item = await nextEvent(iterator, lane.stop.signal)
            if (item.done) throw new Error('channel outbound event stream ended')
            const event = item.value
            if (!this.isCurrent(sessionKey, lane)) return
            failures = 0
            if (event.type === 'turn/start') this.dependencies.cache.markTurn(sessionKey, true)
            if (event.type === 'turn/end') {
              this.dependencies.cache.markTurn(sessionKey, false)
              if (lane.timer !== undefined) clearTimeout(lane.timer)
              delete lane.timer
              this.flushInBackground(sessionKey)
              continue
            }
            if (lane.timer !== undefined) clearTimeout(lane.timer)
            lane.timer = setTimeout(() => {
              delete lane.timer
              this.flushInBackground(sessionKey)
            }, this.dependencies.debounceMs ?? 300)
          }
        } finally {
          if (iterator.return !== undefined) {
            await settleWithin(
              Promise.resolve(iterator.return()).then(() => undefined),
              this.dependencies.stopSettleMs ?? 1_000,
            )
          }
        }
      } catch (error) {
        if (!this.isCurrent(sessionKey, lane)) return
        failures++
        this.safeError('channel outbound event pump failed; rebuilding iterator', {
          sessionKey,
          error: String(error),
          failures,
        })
        await delay(Math.min(1_000, 10 * 2 ** Math.min(failures - 1, 7)), lane.stop.signal).catch(
          () => undefined,
        )
      }
    }
  }

  private flushInBackground(sessionKey: string): void {
    void this.flush(sessionKey).catch((error) => {
      this.safeError('channel outbound flush failed', { sessionKey, error: String(error) })
    })
  }

  private async render(sessionKey: string, lane: Lane): Promise<void> {
    if (!this.isCurrent(sessionKey, lane)) return
    const timeline = await lane.session.projectUI(undefined, { surface: 'channel' })
    if (!this.isCurrent(sessionKey, lane) || stale(timeline, lane.watermark)) return
    lane.watermark = { generation: timeline.generation, upto: timeline.upto }

    const known = this.dependencies.refs.forSession(sessionKey, lane.session.id)
    for (const node of timeline.nodes) {
      if (!this.isCurrent(sessionKey, lane)) return
      const message = whatToDraw(node, {
        costLine: this.dependencies.cfg.outbound.costLine,
        caps: this.dependencies.caps,
        ...(this.dependencies.artifactsUrl === undefined
          ? {}
          : { artifactsUrl: this.dependencies.artifactsUrl }),
      })
      if (message === null) continue
      const hash = contentHash(message)
      const previous = known.get(node.id)
      if (previous?.contentHash === hash && previous.complete) continue

      // An incomplete first delivery is still a new message on retry; changing degradation
      // semantics mid-revision would invalidate already persisted multipart progress.
      const updating = previous?.complete === true || previous?.isUpdate === true
      const rendered = degrade(message, this.dependencies.caps, { updating })
      this.recordDegradation(sessionKey, lane, rendered.degraded)
      const delivered = await this.deliverNode(
        sessionKey,
        lane,
        node.id,
        hash,
        rendered.msg,
        previous,
        updating,
      )
      if (!this.isCurrent(sessionKey, lane)) return
      known.set(node.id, delivered)
    }
  }

  private async deliverNode(
    sessionKey: string,
    lane: Lane,
    nodeId: string,
    hash: string,
    message: ChannelMessage,
    previous: DeliveryRefRow | undefined,
    isUpdate: boolean,
  ): Promise<DeliveryRefRow> {
    const pieces = this.split(message)
    if (pieces.length === 0) throw new Error('channel outbound message has no blocks')
    const canReuse = this.dependencies.caps.edit
    const continuing = previous?.contentHash === hash && !previous.complete
    const parts: RefPart[] = continuing || canReuse ? [...(previous?.parts ?? [])] : []

    for (const [index, piece] of pieces.entries()) {
      const pieceHash = contentHash(piece)
      const existing = parts[index]
      if (existing?.contentHash === pieceHash) continue
      await this.take(lane)
      let ref: MessageRef
      if (existing !== undefined && canReuse) {
        await this.dependencies.adapter.update(existing.ref, piece)
        ref = existing.ref
      } else {
        ref = await this.dependencies.adapter.send(
          {
            ...lane.chat,
            deliveryKey: `${sessionKey}\0${lane.session.id}\0${nodeId}\0${index}\0${pieceHash}`,
          },
          piece,
        )
      }
      parts[index] = { ref, contentHash: pieceHash }
      this.persistProgress(sessionKey, lane, nodeId, hash, parts, false, isUpdate)
    }

    // There is no delete primitive. With edit support, neutralize obsolete tail chunks once,
    // then forget them. Without edit support a changed revision is sent exactly once as a new set.
    if (canReuse && parts.length > pieces.length) {
      const tombstoneText = chunkText('↩ 内容已合并到上一条', this.dependencies.limits.textChars)[0]
      if (tombstoneText === undefined) throw new Error('channel outbound tombstone is empty')
      const tombstone: ChannelMessage = {
        blocks: [{ kind: 'text', markdown: tombstoneText }],
      }
      for (const extra of parts.slice(pieces.length)) {
        await this.take(lane)
        await this.dependencies.adapter.update(extra.ref, tombstone)
      }
      parts.length = pieces.length
    }
    this.persistProgress(sessionKey, lane, nodeId, hash, parts, true, isUpdate)
    const first = parts[0]
    if (first === undefined) throw new Error('channel outbound message has no reference')
    return { ref: first.ref, contentHash: hash, parts, complete: true, isUpdate }
  }

  private split(message: ChannelMessage): ChannelMessage[] {
    const messages: ChannelMessage[] = []
    let blocks: ChannelMessage['blocks'] = []
    const flush = (): void => {
      if (blocks.length === 0) return
      messages.push({ ...message, blocks })
      blocks = []
    }
    const limit = this.dependencies.limits.textChars
    let textChars = 0
    for (const block of message.blocks) {
      if (block.kind !== 'text') {
        blocks.push(block)
        continue
      }
      if (block.markdown.length === 0) {
        blocks.push(block)
        continue
      }
      let remaining = block.markdown
      while (remaining.length > 0) {
        if (textChars === limit) {
          flush()
          textChars = 0
        }
        const capacity = limit - textChars
        const markdown = chunkText(remaining, capacity)[0]
        if (markdown === undefined || markdown.length === 0) throw new Error('text chunker made no progress')
        blocks.push({ kind: 'text', markdown })
        textChars += markdown.length
        remaining = remaining.slice(markdown.length)
      }
    }
    flush()
    return messages
  }

  private async take(lane: Lane): Promise<void> {
    await lane.bucket.take(lane.stop.signal)
    await this.accountBucket.take(lane.stop.signal)
    lane.stop.signal.throwIfAborted()
  }

  private persistProgress(
    sessionKey: string,
    lane: Lane,
    nodeId: string,
    hash: string,
    parts: RefPart[],
    complete: boolean,
    isUpdate: boolean,
  ): void {
    try {
      const stored = this.dependencies.refs.putProgress(
        sessionKey,
        lane.session.id,
        nodeId,
        hash,
        [...parts],
        complete,
        isUpdate,
        !lane.stop.signal.aborted,
      )
      if (!stored && !lane.stop.signal.aborted) {
        throw new Error('channel outbound ref store closed during active delivery')
      }
    } catch (error) {
      if (lane.stop.signal.aborted) {
        this.safeError('channel outbound ref progress could not be persisted after detach', {
          sessionKey,
          error: String(error),
        })
        return
      }
      throw error
    }
  }

  private recordDegradation(sessionKey: string, lane: Lane, capabilities: DegradedCap[]): void {
    for (const capability of capabilities) {
      if (lane.degraded.has(capability)) continue
      lane.degraded.add(capability)
      this.onDegraded?.(sessionKey, capability)
    }
  }

  private trackDetached(work: Promise<void>): void {
    // Observe the original promise even when the bounded tracking set is full so a late
    // rejection never becomes unhandled. Tracking itself settles within the stop window.
    const observed = Promise.resolve(work).catch(() => undefined)
    if (this.detachedPumps.size >= (this.dependencies.maxDetachedWork ?? 128)) return
    const tracked = settleWithin(observed, this.dependencies.stopSettleMs ?? 1_000)
    this.detachedPumps.add(tracked)
    void tracked.finally(() => this.detachedPumps.delete(tracked))
  }

  private isCurrent(sessionKey: string, lane: Lane): boolean {
    return !lane.stop.signal.aborted && this.lanes.get(sessionKey) === lane
  }

  private safeError(message: string, meta: Record<string, unknown>): void {
    try {
      this.dependencies.log.error(message, meta)
    } catch {
      // Diagnostics cannot break the outbound lane.
    }
  }
}

function settleWithin(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    void work.then(finish, finish)
    if (timeoutMs <= 0) {
      finish()
      return
    }
    timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
  })
}

function stale(timeline: Watermark, previous: Watermark | undefined): boolean {
  if (previous === undefined) return false
  if (timeline.generation < previous.generation) return true
  return timeline.generation === previous.generation && timeline.upto < previous.upto
}

function nextEvent<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    void Promise.resolve(iterator.next())
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', aborted)
      })
  })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      reject(signal.reason)
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
