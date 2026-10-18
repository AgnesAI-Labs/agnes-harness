import { randomUUID } from 'node:crypto'
import { BrowserEngine } from './engine.mjs'
import { commandFor } from './protocol.mjs'

const keyOf = (session) => JSON.stringify([session.key, session.lane])
const actorKey = (actor) => JSON.stringify(actor, Object.keys(actor).sort())

/** One current-profile owner. Tools supply Host-bound session identities; viewers get expiring read leases. */
export class BrowserRuntime {
  constructor(engine = new BrowserEngine(), now = Date.now) {
    this.engine = engine
    this.now = now
    this.sessions = new Map()
    this.tickets = new Map()
    this.closed = false
    this.reaper = setInterval(() => {
      for (const [key, record] of this.sessions)
        if (this.now() - record.lastUsed >= 900000) {
          const [session, lane] = JSON.parse(key)
          void this.closeSession({ key: session, lane }).catch(() => {})
        }
    }, 30000)
    this.reaper.unref?.()
  }

  async execute(input, context) {
    const command = commandFor(input)
    if (this.closed) throw new Error('Browser runtime is closed')
    const key = keyOf(context.session)
    let record = this.sessions.get(key)
    if (input.action === 'close') {
      await this.closeSession(context.session)
      return { closed: true }
    }
    if (!record) {
      if (input.action !== 'open')
        throw new Error('Open a URL with browser_open before inspecting or operating this session browser')
      if (this.sessions.size >= 4)
        throw new Error('Four session browsers are active; close an unused session browser first')
      record = {
        key,
        controller: new AbortController(),
        queue: Promise.resolve(),
        state: 'starting',
        url: '',
        viewers: new Set(),
        lastUsed: this.now(),
      }
      this.sessions.set(key, record)
    }
    const current = record
    const work = async () => {
      const signal = AbortSignal.any([context.signal, current.controller.signal])
      signal.throwIfAborted()
      current.lastUsed = this.now()
      if (!current.browser) {
        try {
          current.browser = await this.engine.start({ ...context, signal })
          signal.throwIfAborted()
          current.state = 'ready'
          void current.browser.exited.then(() => {
            if (this.sessions.get(key) === current) void this.closeSession(context.session).catch(() => {})
          })
        } catch (error) {
          current.controller.abort()
          await current.browser?.close()
          if (this.sessions.get(key) === current) this.sessions.delete(key)
          throw error
        }
      }
      const result = await current.browser.call(command, signal, Math.min(context.timeoutMs ?? 30000, 30000))
      if (input.action === 'open') current.url = command.url
      return result
    }
    const result = current.queue.then(work)
    current.queue = result.catch(() => {})
    return result
  }

  observe(sessionId, actor) {
    if (this.closed) throw new Error('Browser runtime is closed')
    const record = this.sessions.get(keyOf({ key: sessionId, lane: 'main' }))
    if (!record || record.controller.signal.aborted) return { state: 'idle' }
    if (record.state !== 'ready') return { state: record.state }
    for (const [token, lease] of this.tickets) if (lease.expiresAt <= this.now()) this.tickets.delete(token)
    if (this.tickets.size >= 128) throw new Error('Browser viewer lease limit reached')
    const ticket = randomUUID()
    const expiresAt = this.now() + 30000
    this.tickets.set(ticket, { record, expiresAt, actor: actorKey(actor) })
    return { state: 'ready', ticket, expiresAt, url: record.url, width: 1280, height: 800 }
  }

  watch(ticket, context) {
    const lease = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    if (
      !lease ||
      this.closed ||
      lease.expiresAt <= this.now() ||
      lease.actor !== actorKey(context.actor) ||
      lease.record.controller.signal.aborted
    )
      throw new Error('Browser viewer lease is invalid or expired')
    const record = lease.record
    if (record.viewers.size >= 3) throw new Error('At most three viewers may watch a session browser')
    const ws = new WebSocket(`ws://127.0.0.1:${record.browser.port}/?maxFps=20&pacing=push`)
    let stopped = false
    const stop = (reason = 'viewer-closed') => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      record.viewers.delete(stop)
      context.signal.removeEventListener('abort', abort)
      off()
      ws.close()
      context.stream.close(reason)
    }
    const abort = () => stop()
    const timer = setTimeout(() => stop('lease-expired'), Math.max(1, lease.expiresAt - this.now()))
    const off = context.stream.onDisconnect(() => stop())
    record.viewers.add(stop)
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) stop()
    ws.addEventListener('message', ({ data }) => {
      if (stopped || typeof data !== 'string' || data.length > 1000000) return
      try {
        const frame = JSON.parse(data)
        // No raw CDP, dashboard input, command logs, private endpoints or executable configuration cross this bridge.
        if (frame.type === 'frame' && typeof frame.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(frame.data))
          context.stream.send({ type: 'frame', data: frame.data })
        else if (frame.type === 'url' && typeof frame.url === 'string') {
          record.url = frame.url.slice(0, 8192)
          context.stream.send({ type: 'url', url: record.url })
        }
      } catch {
        stop('invalid-browser-frame')
      }
    })
    ws.addEventListener('error', () => stop('browser-disconnected'))
    ws.addEventListener('close', () => stop('browser-disconnected'))
  }

  async closeSession(session) {
    const key = keyOf(session)
    const record = this.sessions.get(key)
    if (!record) return
    if (record.closing) return record.closing
    record.controller.abort()
    for (const stop of [...record.viewers]) stop('browser-closed')
    for (const [token, lease] of this.tickets) if (lease.record === record) this.tickets.delete(token)
    record.closing = (async () => {
      await record.queue
      await record.browser?.close()
      if (this.sessions.get(key) === record) this.sessions.delete(key)
    })()
    return record.closing
  }

  async dispose() {
    this.closed = true
    clearInterval(this.reaper)
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((key) => {
        const [session, lane] = JSON.parse(key)
        return this.closeSession({ key: session, lane })
      }),
    )
    this.tickets.clear()
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Owned browser shutdown could not be confirmed')
  }
}
