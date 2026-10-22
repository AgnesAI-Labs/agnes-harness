import type { ClientContext } from '@agnes/web-client'

export type BrowserPage = {
  media?: 'audio'
  sampleRate?: number
  frameMime?: 'image/jpeg' | 'image/png'
  pageId: string
  url: string
  pageEpoch: number
  controlEpoch: number
  agentRevision?: number
  mode: 'agent' | 'human' | 'paused'
  uncertain?: boolean
  activity?: number
  viewportWidth?: number
  viewportHeight?: number
}
export type BrowserState = {
  enabled: boolean
  state: string
  error?: string | null | undefined
  pages: BrowserPage[]
  sessionId?: string | undefined
}
export class BrowserClient {
  private pending = new Map<
    string,
    { service: string; input: Record<string, unknown>; operationId: string }
  >()
  private inFlight = new Set<string>()
  private snapshot: BrowserState = { enabled: true, state: 'preparing', pages: [] }
  private listeners = new Set<() => void>()
  private stopped = false
  private refreshing = false
  private refreshEpoch?: number
  private refreshAgain = false
  private watching = false
  private abort = new AbortController()
  private pageWatch?: AbortController
  private profileWatch?: AbortController
  private profileLive = false
  private pagesLive = false
  private pagesVersion = 0
  private status?: Omit<BrowserState, 'pages'>
  private timer?: ReturnType<typeof setInterval>
  constructor(readonly ctx: ClientContext) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  update(snapshot: BrowserState) {
    if (this.stopped) return
    this.snapshot = snapshot
    for (const fn of this.listeners) fn()
  }
  start() {
    if (this.watching || this.stopped) return
    this.watching = true
    this.watchPages()
    // Queries are recovery only. Healthy streams carry status and session-owned pages.
    this.timer = setInterval(() => {
      const selected = this.ctx.session.readiness.getSnapshot()
      if (!this.profileLive || (selected.status === 'ready' && !this.pagesLive)) void this.refresh()
    }, 3000)
    return () => this.stopWatching()
  }
  private stopWatching() {
    this.watching = false
    this.pageWatch?.abort()
    this.profileWatch?.abort()
    this.pagesLive = false
    this.profileLive = false
    this.refreshAgain = false
    clearInterval(this.timer)
  }
  private receiveStatus(value: Record<string, unknown>) {
    if (typeof value.enabled !== 'boolean' || typeof value.state !== 'string') return
    this.status = {
      enabled: value.enabled,
      state: value.state,
      error: typeof value.error === 'string' ? value.error : null,
    }
    this.profileLive = true
    this.update({ ...this.snapshot, ...this.status })
  }
  private watch(
    streams: ClientContext['sessionStreams'],
    name: string,
    signal: AbortSignal,
    receive: (value: Record<string, unknown>) => void,
    disconnected: () => void,
  ) {
    let timer: ReturnType<typeof setTimeout>
    let retry = 1500
    const reconnect = () => {
      if (signal.aborted) return
      disconnected()
      timer = setTimeout(() => {
        void connect()
      }, retry)
      retry = Math.min(15_000, retry * 2)
    }
    const connect = async () => {
      try {
        const stream = await streams.open(name, {}, { signal })
        if (signal.aborted) {
          stream.close('cancelled')
          return
        }
        stream.onDisconnect(reconnect)
        stream.onFrame((value) => {
          if (
            signal.aborted ||
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            value instanceof Uint8Array
          )
            return
          retry = 1500
          receive(value)
        })
      } catch {
        reconnect()
      }
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
      },
      { once: true },
    )
    void connect()
  }
  private watchPages() {
    this.pageWatch?.abort()
    this.profileWatch?.abort()
    this.pagesLive = false
    this.profileLive = false
    const selected = this.ctx.session.readiness.getSnapshot()
    if (selected.status !== 'ready') {
      this.profileWatch = new AbortController()
      this.watch(
        this.ctx.profile.streams,
        'browser.state',
        AbortSignal.any([this.abort.signal, this.profileWatch.signal]),
        (value) => this.receiveStatus(value),
        () => {
          this.profileLive = false
        },
      )
      return
    }
    this.pageWatch = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, this.pageWatch.signal])
    this.watch(
      this.ctx.sessionStreams,
      'browser.pages',
      signal,
      (value) => {
        if (this.ctx.session.readiness.getSnapshot().epoch !== selected.epoch) return
        this.receiveStatus(value)
        if (value.changed === true) {
          this.pagesLive = false
          void this.refresh()
          return
        }
        if (!Array.isArray(value.pages)) return
        this.pagesLive = true
        this.pagesVersion++
        if (this.profileLive) this.update({ ...this.snapshot, error: this.status?.error })
        this.updatePages(value.pages as BrowserPage[], selected.sessionId)
      },
      () => {
        this.pagesLive = false
        this.profileLive = false
      },
    )
  }
  private updatePages(pages: BrowserPage[], sessionId: string | undefined) {
    this.update({ ...this.snapshot, pages, sessionId })
  }
  async refresh() {
    if (this.stopped) return
    if (this.refreshing) {
      if (this.refreshEpoch !== this.ctx.session.readiness.getSnapshot().epoch) this.refreshAgain = true
      return
    }
    this.refreshing = true
    const selected = this.ctx.session.readiness.getSnapshot()
    this.refreshEpoch = selected.epoch
    const pagesVersion = this.pagesVersion
    try {
      let state = (
        this.profileLive && this.status
          ? this.status
          : await this.ctx.profile.services.query('browser.status', {})
      ) as Omit<BrowserState, 'pages'>
      let pages: BrowserPage[] = []
      let sessionError: string | undefined
      if (state.enabled && selected.status === 'ready') {
        try {
          const value = (await this.ctx.agnes.services.call('browser.pages', {})) as { pages: BrowserPage[] }
          pages = value.pages
        } catch {
          pages = this.snapshot.sessionId === selected.sessionId ? this.snapshot.pages : []
          sessionError =
            'Browser pages could not be refreshed. If this conversation uses an older plugin version, migrate it or open a new conversation.'
        }
      }
      if (this.ctx.session.readiness.getSnapshot().epoch !== selected.epoch) return
      if (this.profileLive && this.status) state = this.status
      if (this.pagesLive && pagesVersion !== this.pagesVersion) {
        this.update({ ...this.snapshot, ...state })
        return
      }
      this.update({ ...state, pages, sessionId: selected.sessionId, error: state.error ?? sessionError })
      this.updatePages(pages, selected.sessionId)
    } catch (error) {
      // A failed read does not prove that the backend feature was disabled.
      if (this.ctx.session.readiness.getSnapshot().epoch !== selected.epoch) return
      if (this.profileLive && this.pagesLive) return
      this.update({
        ...this.snapshot,
        sessionId: selected.sessionId,
        pages: this.snapshot.sessionId === selected.sessionId ? this.snapshot.pages : [],
        state: 'failed',
        error: String(error),
      })
    } finally {
      this.refreshing = false
      if (this.refreshAgain) {
        this.refreshAgain = false
        void this.refresh()
      }
    }
  }
  pendingEffect() {
    const id = this.ctx.session.sessionId
    return id && !this.inFlight.has(id) ? this.pending.get(id) : undefined
  }
  async effect(service: string, input: Record<string, unknown>) {
    const selected = this.ctx.session.readiness.getSnapshot()
    if (selected.status !== 'ready' || !selected.sessionId) throw new Error('A ready session is required.')
    const pending = this.pending.get(selected.sessionId)
    if (pending && (pending.service !== service || JSON.stringify(pending.input) !== JSON.stringify(input)))
      throw new Error('A previous browser action has an uncertain outcome. Check it before another action.')
    const operation = pending ?? { service, input: structuredClone(input), operationId: crypto.randomUUID() }
    this.pending.set(selected.sessionId, operation)
    if (this.inFlight.has(selected.sessionId)) throw new Error('Browser action is still running.')
    this.inFlight.add(selected.sessionId)
    try {
      const result = (await this.ctx.agnes.services.effect(service, input, {
        operationId: operation.operationId,
      })) as Record<string, unknown>
      if (this.pending.get(selected.sessionId) === operation) this.pending.delete(selected.sessionId)
      if (this.ctx.session.readiness.getSnapshot().epoch !== selected.epoch)
        throw new Error('The result belongs to the previous conversation; it was not applied to this view.')
      if (result.status === 'refused')
        throw Object.assign(new Error(String(result.code)), { code: result.code })
      if (typeof result.closedPageId === 'string')
        this.updatePages(
          this.snapshot.pages.filter((page) => page.pageId !== result.closedPageId),
          selected.sessionId,
        )
      if (
        typeof result.pageId === 'string' &&
        typeof result.url === 'string' &&
        Number.isSafeInteger(result.pageEpoch) &&
        Number.isSafeInteger(result.controlEpoch)
      ) {
        const page = result as BrowserPage
        const exists = this.snapshot.pages.some((item) => item.pageId === page.pageId)
        this.updatePages(
          exists
            ? this.snapshot.pages.map((item) => (item.pageId === page.pageId ? { ...item, ...page } : item))
            : [...this.snapshot.pages, page],
          selected.sessionId,
        )
      }
      // A completed effect must not wait for an unrelated read. The same gated queries
      // remain the fallback when this backend does not supply page events.
      if (!this.pagesLive && service !== 'browser.control') void this.refresh()
      return { result, operationId: operation.operationId }
    } catch (error) {
      const failure = error as { kind?: string; data?: { code?: string } }
      if (
        !pending &&
        failure?.kind === 'json-rpc' &&
        ['CAPABILITY_DENIED', 'INVALID_PARAMS', 'AUTH_INVALID', 'OVERLOADED', 'SESSION_NOT_FOUND'].includes(
          failure.data?.code ?? '',
        ) &&
        this.pending.get(selected.sessionId) === operation
      )
        this.pending.delete(selected.sessionId)
      throw error
    } finally {
      this.inFlight.delete(selected.sessionId)
      this.update({ ...this.snapshot })
    }
  }
  clearSession() {
    this.update({ ...this.snapshot, pages: [], sessionId: this.ctx.session.sessionId })
    if (this.watching) this.watchPages()
  }
  close() {
    this.stopped = true
    this.stopWatching()
    this.abort.abort()
    this.listeners.clear()
  }
}
