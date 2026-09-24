import type { HostSession } from '@agnes/host'
import { type DaemonNotice, type EventEnvelope, META_KEY } from '@agnes/protocol'
import type { PreviewSnapshotEntry, PreviewUpdate } from '../registry.js'
import { notify } from '../rpc.js'
import { type AttachPrefs, type LocalEndpoint, utf8JsonBytes } from './endpoint.js'
import { type MetaState, stampMeta } from './meta.js'
import { PreviewPipe } from './preview.js'

export type Limits = { subscribeBufferEvents: number; subscribeBufferBytes: number }
export const DEFAULT_LIMITS: Limits = { subscribeBufferEvents: 1000, subscribeBufferBytes: 8 * 1024 * 1024 }
export type DaemonNoticeKind = DaemonNotice['kind']

/**
 * The one place a daemon.notice payload is built. Notices are heterogeneous - sdk's `Client.notice`
 * takes an unknown payload and forwards these params verbatim, and a client's own synthetic notices
 * (a dropped ledger row arrives as `kind: 'invalid-event'`) share the same channel - so a consumer
 * can only tell them apart by `kind`. Making that reliable means the field is never optional and
 * never spelled per call site, and the kind parameter is the schema's closed set rather than a
 * string. boundary.test.ts asks for the code to be written this way; what enforces it is
 * LocalEndpoint.push(), which measures the frame against the method table before queueing it, so a
 * payload built some other way is refused however its method name was spelled.
 */
export function noticeParams(
  kind: DaemonNoticeKind,
  o: { sessionId?: string; detail: unknown; atMs: number },
): DaemonNotice {
  return {
    kind,
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    detail: o.detail,
    at: new Date(o.atMs).toISOString(),
  } as DaemonNotice
}

export function passesFilter(e: EventEnvelope, f: AttachPrefs['filter']): boolean {
  if (f.types && !f.types.includes(e.type)) return false
  if (f.lanes && !f.lanes.includes(e.lane ?? 'main')) return false
  return true
}

/**
 * One attached connection's raw `_agnes/v1/session.event` stream for one session.
 *
 * It holds its own MetaState. The ACP Feed holds the live one, and running a cursor catch-up through
 * that would reset promptTurnId on every historical turn/start, re-emit terminalQuiescence for every
 * historical turn/end, and stamp eventSequence values below ones already sent - all three of the
 * _meta invariants, broken by any attach after a completed turn.
 *
 * What a consumer of this stream gets is the ledger verbatim, and that includes `request/header`
 * rows for attempts that were aborted or retried. A header here means "a request
 * was tried", not "a request got an answer"; filter on `types` if that is not wanted.
 */
export class AttachedFeed {
  private meta: MetaState
  private cut = false
  private held: EventEnvelope[] | null = null
  // The highest row already covered by this feed's replay/live stream. The registry tail can lag
  // behind storage: a snapshot may include a committed row before tailSession has delivered it to
  // subscribers. Without a server-side watermark that delayed row is emitted after replay as if it
  // were live, and a large committed batch can overflow and detach an otherwise caught-up client.
  private coveredSeq = 0
  // Streamed text, for a connection that asked for it. It starts once the replay has caught up.
  private readonly preview: PreviewPipe | undefined

  constructor(
    private readonly o: {
      ep: LocalEndpoint
      key: string
      generation: number
      prefs: AttachPrefs
      limits: Limits
      clock: () => number
      onDrop: () => void
      fetchPreview?: () => Promise<PreviewSnapshotEntry[]>
    },
  ) {
    this.meta = { promptTurnId: null, generation: o.generation }
    const fetch = o.fetchPreview
    if (o.prefs.filter.preview && fetch)
      this.preview = new PreviewPipe({
        lanes: o.prefs.filter.lanes,
        fetch,
        send: (p) => o.ep.pushPreview(notify('_agnes/v1/session.preview', { sessionId: o.key, ...p })),
      })
  }

  onPreview(p: PreviewUpdate): void {
    if (this.cut || this.held) return
    this.preview?.live(p)
  }

  previewLowWater(): void {
    this.preview?.lowWater()
  }

  /** Previews were lost upstream: catch the viewer up, unless the replay will do it anyway. */
  previewResync(): void {
    if (this.cut || this.held) return
    this.preview?.resync()
  }

  /** The client detached, or attached again with a new feed: this one says nothing more. */
  detach(): void {
    this.cut = true
    this.held = null
    this.preview?.close()
  }

  onEvent(e: EventEnvelope): void {
    if (this.cut) return
    if (e.seq <= this.coveredSeq) return
    // A live row arriving mid-replay is held: pushing it now would put a newer row ahead of the older
    // history still being paged in.
    if (this.held) {
      this.held.push(e)
      return
    }
    this.coveredSeq = e.seq
    this.enqueue(e)
  }

  /** Starts the attach barrier before this feed becomes reachable from the live event callback. */
  beginReplay(): void {
    if (this.held !== null) throw new Error('attached feed replay already started')
    this.held = []
  }

  /** Replays (fromSeq, lastSeq] - fromSeq is the last row the client already applied, exclusive. */
  async replay(session: HostSession, fromSeq: number, lastSeq: number): Promise<void> {
    // Direct package callers retain the old one-call form; production calls beginReplay() before
    // publishing the feed so the capture/register window is covered too.
    if (this.held === null) this.beginReplay()
    try {
      for (let from = fromSeq + 1; from <= lastSeq; from += 500) {
        const page = (await session.scan({
          fromSeq: from,
          toSeq: Math.min(lastSeq, from + 499),
          limit: 500,
        })) as EventEnvelope[]
        for (const e of page) {
          if (e.seq <= this.coveredSeq) continue
          this.coveredSeq = e.seq
          this.enqueue(e)
        }
      }
    } finally {
      // `lastSeq` is the storage cut, not merely the greatest row returned by one scan page. Even an
      // empty replay from a caught-up cursor covers that cut and must suppress tail's delayed copy.
      this.coveredSeq = Math.max(this.coveredSeq, lastSeq)
      const buffered = this.held ?? []
      this.held = null
      for (const e of buffered) if (e.seq > lastSeq) this.onEvent(e)
      // Whatever is streaming now started before this viewer was caught up; the snapshot fills it in.
      this.preview?.resync()
    }
  }

  private advance(e: EventEnvelope): ReturnType<typeof stampMeta>['meta'] {
    const { meta, next } = stampMeta(e, this.meta)
    this.meta = next
    return meta
  }

  private dropOverloaded(): void {
    this.cut = true
    this.preview?.close()
    this.o.onDrop()
    this.o.ep.push(
      notify(
        '_agnes/v1/daemon.notice',
        noticeParams('overloaded', {
          sessionId: this.o.key,
          detail: { code: 'OVERLOADED', retryAfterMs: 500 },
          atMs: this.o.clock(),
        }),
      ),
    )
  }

  private enqueue(e: EventEnvelope): void {
    if (this.cut) return
    const p = this.o.ep.pending()
    if (p.events >= this.o.limits.subscribeBufferEvents) {
      this.dropOverloaded()
      return
    }
    if (!passesFilter(e, this.o.prefs.filter)) {
      this.advance(e)
      return
    }
    const { meta, next } = stampMeta(e, this.meta)
    const frame = notify('_agnes/v1/session.event', {
      sessionId: this.o.key,
      event: e,
      _meta: { [META_KEY]: meta },
    })
    const incoming = utf8JsonBytes(frame)
    if (p.bytes + incoming > this.o.limits.subscribeBufferBytes) {
      this.dropOverloaded()
      return
    }
    this.meta = next
    this.o.ep.push(frame)
  }
}
