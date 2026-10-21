import { randomUUID } from 'node:crypto'
import { browserUrl, failure, isBrowserRefusal } from './policy.mjs'

const MAX_PAGES = 3
const MAX_SESSIONS = 2
const CONTROL_MS = 5 * 60_000

/** One Page object serves tools, observations and all display/input subscribers. */
export class BrowserRuntime {
  constructor({ launch, assertCurrent = () => {}, now = Date.now, protectedOrigins = [] }) {
    this.launch = launch
    this.assertCurrent = assertCurrent
    this.now = now
    // Only an active plugin owns this resource; no separately persisted feature switch.
    this.enabled = true
    this.state = 'stopped'
    this.epoch = 0
    this.activity = 0
    this.sessions = new Map()
    this.views = new Map()
    this.retiredContexts = new Set()
    this.protectedOrigins = new Set()
    for (const origin of protectedOrigins) {
      try {
        const url = new URL(origin)
        if (['http:', 'https:'].includes(url.protocol)) this.protectedOrigins.add(url.origin)
      } catch {
        /* Invalid optional startup hints cannot widen authority. */
      }
    }
    this.listeners = new Set()
  }

  status() {
    this.assertCurrent()
    return {
      enabled: this.enabled,
      state: this.enabled ? this.state : 'stopped',
      epoch: this.epoch,
      error: this.error ?? null,
      cleanupRequired: !!this.cleanupRequired,
    }
  }

  guard(epoch = this.epoch) {
    this.assertCurrent()
    if (!this.enabled || this.closed || epoch !== this.epoch)
      throw failure('DISABLED', 'Built-in browser is disabled. Use authorized computer_use instead.')
    if (this.cleanupRequired)
      throw failure(
        'CLEANUP_UNCONFIRMED',
        'Browser cleanup is unconfirmed. Reconcile cleanup before re-enabling the plugin.',
      )
  }

  notify() {
    for (const notify of this.listeners) notify()
  }

  async browser() {
    this.guard()
    if (this.state === 'preparing' && !this.starting)
      throw failure('PREPARING', 'The browser plugin is preparing its runtime. Wait for it to become ready.')
    if (!this.starting) {
      const epoch = this.epoch
      this.state = 'preparing'
      this.notify()
      this.starting = this.launch()
        .then(async (browser) => {
          try {
            this.guard(epoch)
          } catch (error) {
            try {
              await browser.close()
            } catch {
              this.instance = browser
              this.cleanupRequired = true
            }
            throw error
          }
          this.instance = browser
          this.state = 'ready'
          this.error = undefined
          browser.on('disconnected', () => {
            if (this.instance !== browser || this.stopping) return
            this.instance = undefined
            this.starting = undefined
            this.state = 'failed'
            for (const id of [...this.sessions.keys()]) void this.closeSession(id).catch(() => {})
            this.notify()
          })
          this.notify()
          return browser
        })
        .catch((error) => {
          this.starting = undefined
          if (this.enabled && epoch === this.epoch) {
            this.state = 'failed'
            this.error = String(error.message).slice(0, 500)
            this.notify()
          }
          throw error
        })
    }
    return this.starting
  }

  async session(identity) {
    this.guard()
    if (!identity?.key || identity.lane !== 'main')
      throw failure('DENIED', 'A backend-bound main session is required.')
    let entry = this.sessions.get(identity.key)
    if (!entry) {
      if (this.sessions.size >= MAX_SESSIONS)
        throw failure('CAPACITY', 'Close another built-in browser session first.')
      const epoch = this.epoch
      entry = { pages: new Map(), opening: 0, pending: null }
      this.sessions.set(identity.key, entry)
      entry.pending = (async () => {
        const browser = await this.browser()
        this.guard(epoch)
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          acceptDownloads: false,
          serviceWorkers: 'block',
        })
        try {
          this.guard(epoch)
          if (this.sessions.get(identity.key) !== entry) throw failure('CLOSED', 'Session is closed.')
          entry.context = context
          await context.route('**/*', async (route) => {
            try {
              browserUrl(route.request().url(), this.protectedOrigins)
              await route.continue()
            } catch {
              await route.abort('blockedbyclient').catch(() => {})
            }
          })
          await context.routeWebSocket('**/*', (socket) => {
            try {
              const url = new URL(socket.url())
              url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
              browserUrl(url.href, this.protectedOrigins)
              socket.connectToServer()
            } catch {
              socket.close({ code: 1008, reason: 'Protected target' })
            }
          })
          context.on('page', (page) => {
            if (this.sessions.get(identity.key) !== entry || !this.enabled || epoch !== this.epoch) {
              void page.close().catch(() => {})
              return
            }
            if (!entry.pages.has(page) && entry.pages.size < MAX_PAGES) this.track(entry, page)
            else if (!entry.pages.has(page)) void page.close().catch(() => {})
          })
          return entry
        } catch (error) {
          this.retiredContexts.add(context)
          try {
            await context.close()
            this.retiredContexts.delete(context)
          } catch {
            this.cleanupRequired = true
            this.error = 'Browser session cleanup is unconfirmed.'
            this.notify()
          }
          throw error
        }
      })().catch((error) => {
        if (this.sessions.get(identity.key) === entry) this.sessions.delete(identity.key)
        throw error
      })
    }
    return entry.pending
  }

  track(session, page) {
    const item = {
      id: randomUUID(),
      page,
      epoch: 0,
      controlEpoch: 0,
      mode: 'agent',
      queue: Promise.resolve(),
      events: [],
      cursor: 0,
      inputVersion: 0,
      refs: new Map(),
      viewers: new Set(),
    }
    session.pages.set(page, item)
    const event = (kind, detail) => {
      // Twenty entries must fit the service's 64 KiB result even with JSON-escaped text.
      item.events.push({ seq: ++item.cursor, kind, detail: String(detail).slice(0, 500) })
      while (item.events.length > 200) item.events.shift()
    }
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      item.epoch++
      this.clearRefs(item)
      this.notify()
    })
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) event('console', message.text())
    })
    page.on('pageerror', (error) => event('pageerror', error.message))
    page.on('requestfailed', (request) => event('requestfailed', new URL(request.url()).origin))
    page.on('response', (response) => {
      if (response.status() >= 400) event('http', response.status() + ' ' + new URL(response.url()).origin)
    })
    page.on('dialog', (dialog) => {
      event('dialog', dialog.type())
      void dialog.dismiss().catch(() => {})
    })
    page.on('crash', () => {
      item.uncertain = true
      this.revoke(item)
      event('crash', 'Browser page crashed. Inspect before resuming.')
    })
    page.on('close', () => {
      this.revoke(item)
      this.clearRefs(item)
      for (const view of item.viewers) view.close('page-closed')
      session.pages.delete(page)
      this.notify()
    })
    this.notify()
    return item
  }

  clearRefs(item) {
    for (const handle of item.refs.values()) void handle.dispose().catch(() => {})
    item.refs.clear()
  }

  get(identity, pageId) {
    this.guard()
    if (identity?.lane !== 'main') throw failure('DENIED', 'Main session required.')
    const session = this.sessions.get(identity.key)
    const item = [...(session?.pages.values() ?? [])].find((entry) => entry.id === pageId)
    if (!item || item.page.isClosed()) throw failure('PAGE_UNAVAILABLE', 'Page is not owned by this session.')
    return item
  }

  list(identity) {
    this.guard()
    if (identity?.lane !== 'main') throw failure('DENIED', 'Main session required.')
    return [...(this.sessions.get(identity.key)?.pages.values() ?? [])].map((item) => ({
      pageId: item.id,
      url: item.page.url(),
      pageEpoch: item.epoch,
      controlEpoch: item.controlEpoch,
      mode: item.mode,
      uncertain: !!item.uncertain,
      activity: item.activity ?? 0,
    }))
  }

  activate(item) {
    if (item.mode !== 'agent') return
    item.activity = ++this.activity
    this.notify()
  }

  enqueue(item, work, signal, human = false) {
    const epoch = this.epoch,
      controlEpoch = item.controlEpoch
    const pending = item.queue.then(async () => {
      this.guard(epoch)
      signal?.throwIfAborted()
      if (item.controlEpoch !== controlEpoch || (human ? item.mode !== 'human' : item.mode !== 'agent'))
        throw failure('CONTROL_CHANGED', 'Page control changed. Inspect the current page.')
      if (item.uncertain) throw failure('UNCERTAIN', 'Inspect the page before any further operation.')
      let result
      try {
        if (!human) this.activate(item)
        item.inputVersion++
        result = await work()
      } catch (error) {
        if (!isBrowserRefusal(error)) {
          item.uncertain = true
          this.clearRefs(item)
          this.notify()
        }
        throw error
      }
      if (signal?.aborted) {
        item.uncertain = true
        throw failure('UNCERTAIN', 'Input may have completed. Inspect before continuing.')
      }
      return result
    })
    item.queue = pending.catch(() => {})
    return pending
  }

  // The host can load the entry and resource in separate module instances. Keep
  // refusal identity with the runtime that created it, never with caller error text.
  isRefusal(error) {
    return isBrowserRefusal(error)
  }

  async act(identity, input, signal) {
    this.guard()
    signal?.throwIfAborted()
    if (input.action === 'status') return { ...this.status(), pages: this.list(identity) }
    if (input.action === 'open') {
      const epoch = this.epoch
      const url = browserUrl(input.url, this.protectedOrigins)
      const session = await this.session(identity)
      this.guard(epoch)
      if (this.sessions.get(identity.key) !== session) throw failure('CLOSED', 'Session is closed.')
      signal?.throwIfAborted()
      let item = input.pageId ? this.get(identity, input.pageId) : undefined
      if (!item) {
        if (session.pages.size + session.opening >= MAX_PAGES) throw failure('CAPACITY', 'Close a tab first.')
        session.opening++
        try {
          const page = await session.context.newPage()
          try {
            this.guard(epoch)
            if (this.sessions.get(identity.key) !== session) throw failure('CLOSED', 'Session is closed.')
            signal?.throwIfAborted()
            item = session.pages.get(page)
            if (!item || page.isClosed())
              throw failure('CAPACITY', 'The new tab was closed or the tab limit was reached.')
          } catch (error) {
            await page.close().catch(() => {})
            throw error
          }
        } finally {
          session.opening--
        }
      }
      await this.enqueue(
        item,
        () => item.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }),
        signal,
      )
      return this.describe(item)
    }
    if (input.action === 'tabs') return { pages: this.list(identity) }
    const item = this.get(identity, input.pageId)
    if (input.action === 'events') {
      const remaining = item.events.filter((entry) => entry.seq > (input.cursor ?? 0))
      const events = remaining.slice(0, 20)
      return {
        events,
        cursor: events.at(-1)?.seq ?? input.cursor ?? 0,
        hasMore: remaining.length > events.length,
        gap: item.events.length > 0 && (input.cursor ?? 0) < item.events[0].seq - 1,
      }
    }
    if (input.action === 'inspect') {
      const pending = item.queue.then(async () => {
        this.guard()
        signal?.throwIfAborted()
        const epoch = item.epoch
        this.clearRefs(item)
        const handles = await item.page
          .locator('a,button,input,textarea,select,[role="button"]')
          .elementHandles()
        const elements = []
        for (const handle of handles.slice(0, 100)) {
          const ref = randomUUID()
          const label = await handle
            .evaluate((node) => ({
              tag: node.tagName.toLowerCase(),
              label:
                node.getAttribute('aria-label') ||
                node.getAttribute('placeholder') ||
                node.textContent?.trim().slice(0, 120) ||
                '',
              type: node.getAttribute('type'),
            }))
            .catch(() => null)
          if (label) {
            item.refs.set(ref, handle)
            elements.push({ ref, ...label })
          } else await handle.dispose()
        }
        for (const handle of handles.slice(100)) await handle.dispose()
        const text = (await item.page.locator('body').innerText()).slice(0, 20_000)
        this.guard()
        signal?.throwIfAborted()
        if (epoch !== item.epoch || item.page.isClosed()) {
          this.clearRefs(item)
          throw failure('STALE_TARGET', 'Page changed while observing. Inspect again.')
        }
        item.uncertain = false
        this.activate(item)
        return { ...this.describe(item), text, elements }
      })
      item.queue = pending.catch(() => {})
      return pending
    }
    if (input.action === 'screenshot') {
      this.activate(item)
      return {
        ...this.describe(item),
        bytes: await item.page.screenshot({ type: 'png', scale: 'css', timeout: 10_000 }),
      }
    }
    if (input.pageEpoch !== item.epoch)
      throw failure('STALE_TARGET', 'Inspect the page again before interacting.')
    const result = await this.enqueue(
      item,
      async () => {
        if (input.pageEpoch !== item.epoch)
          throw failure('STALE_TARGET', 'Inspect the page again before interacting.')
        const handle = input.ref ? item.refs.get(input.ref) : undefined
        if (input.action === 'fill' && !handle)
          throw failure('STALE_TARGET', 'Use a current element ref returned by inspect.')
        if (
          input.action === 'click' &&
          !handle &&
          (!Number.isFinite(input.x) ||
            !Number.isFinite(input.y) ||
            input.x < 0 ||
            input.x > 1280 ||
            input.y < 0 ||
            input.y > 800)
        )
          throw failure('STALE_TARGET', 'Use a current ref or a screenshot point within the viewport.')
        switch (input.action) {
          case 'click':
            if (handle) await handle.click({ timeout: 10_000 })
            else await item.page.mouse.click(input.x, input.y)
            break
          case 'fill':
            await handle.fill(input.text, { timeout: 10_000 })
            break
          case 'key':
            await item.page.keyboard.press(input.key)
            break
          case 'scroll':
            await item.page.mouse.wheel(input.x ?? 0, input.y ?? 0)
            break
          case 'wait':
            await item.page.getByText(input.text, { exact: true }).waitFor({ timeout: 10_000 })
            break
          case 'back':
            await item.page.goBack({ timeout: 10_000 })
            break
          case 'forward':
            await item.page.goForward({ timeout: 10_000 })
            break
          case 'reload':
            await item.page.reload({ timeout: 10_000 })
            break
          case 'close': {
            await item.page.close()
            // Release the empty context even if cancellation arrives with the close event.
            const session = this.sessions.get(identity.key)
            if (session?.context === item.page.context() && !session.pages.size && !session.opening)
              await this.closeSession(identity.key)
            break
          }
          default:
            throw failure('INVALID_ACTION', 'Unsupported browser action.')
        }
        this.clearRefs(item)
        this.notify()
        return this.describe(item)
      },
      signal,
    )
    if (signal?.aborted) {
      item.uncertain = true
      throw failure('UNCERTAIN', 'Operation may have completed. Inspect before continuing.')
    }
    return result
  }

  describe(item) {
    return {
      pageId: item.id,
      url: item.page.url(),
      pageEpoch: item.epoch,
      controlEpoch: item.controlEpoch,
      mode: item.mode,
      viewportWidth: 1280,
      viewportHeight: 800,
    }
  }

  revoke(item) {
    item.controlEpoch++
    item.control = undefined
    item.mode = 'paused'
    const input = item.inputStream
    item.inputStream = undefined
    input?.close('control-revoked')
  }

  async control(identity, input, actor, nativeGrant, signal) {
    signal?.throwIfAborted()
    const item = this.get(identity, input.pageId)
    const epoch = this.epoch
    this.revoke(item)
    const controlEpoch = item.controlEpoch
    const pending = item.queue.then(async () => {
      const current = () => {
        this.guard(epoch)
        signal?.throwIfAborted()
        this.get(identity, input.pageId)
        if (item.controlEpoch !== controlEpoch)
          throw failure('CONTROL_CHANGED', 'A newer control request superseded this handover.')
      }
      current()
      // Serialize handovers with page actions; no old release can affect a newer controller.
      for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
        current()
        await item.page.keyboard.up(key).catch(() => {})
      }
      current()
      await item.page.mouse.up().catch(() => {})
      current()
      if (input.mode === 'agent') {
        item.mode = 'agent'
        this.clearRefs(item)
        this.notify()
        return this.describe(item)
      }
      item.mode = 'human'
      item.control = {
        id: randomUUID(),
        nativeId: nativeGrant?.grantId,
        actor: JSON.stringify([actor.id, actor.org ?? '']),
        expiresAt: Math.min(this.now() + CONTROL_MS, nativeGrant?.expiresAt ?? Infinity),
        seq: -1,
      }
      item.uncertain = false
      this.notify()
      return { ...this.describe(item), controlId: item.control.id, expiresAt: item.control.expiresAt }
    })
    item.queue = pending.catch(() => {})
    return pending
  }

  controlGrant(identity, input, actor) {
    const item = this.get(identity, input.pageId),
      grant = item.control
    if (
      !grant ||
      item.mode !== 'human' ||
      grant.id !== input.controlId ||
      grant.actor !== JSON.stringify([actor.id, actor.org ?? '']) ||
      grant.expiresAt <= this.now()
    )
      throw failure('DENIED', 'Human control expired or was revoked.')
    return { grantId: grant.id, expiresAt: Math.min(grant.expiresAt, this.now() + 30_000) }
  }

  async humanInput(identity, input, actor, signal) {
    this.controlGrant(identity, input, actor)
    const item = this.get(identity, input.pageId)
    if (!Number.isSafeInteger(input.seq) || input.seq <= item.control.seq)
      throw failure('STALE_INPUT', 'Duplicate or out-of-order input.')
    if (input.pageEpoch !== item.epoch || input.controlEpoch !== item.controlEpoch)
      throw failure('STALE_INPUT', 'Refresh the page before interacting.')
    item.control.seq = input.seq
    return this.enqueue(
      item,
      async () => {
        this.controlGrant(identity, input, actor)
        if (input.pageEpoch !== item.epoch || input.controlEpoch !== item.controlEpoch)
          throw failure('STALE_INPUT', 'Refresh the page before interacting.')
        switch (input.type) {
          case 'click':
            if (
              !Number.isFinite(input.x) ||
              !Number.isFinite(input.y) ||
              input.x < 0 ||
              input.x > 1280 ||
              input.y < 0 ||
              input.y > 800
            )
              throw failure('INVALID_INPUT', 'Point outside viewport.')
            await item.page.mouse.click(input.x, input.y)
            break
          case 'text':
            if (typeof input.text !== 'string' || input.text.length > 10_000)
              throw failure('INVALID_INPUT', 'Text too long.')
            await item.page.keyboard.insertText(input.text)
            break
          case 'key':
            if (typeof input.key !== 'string' || input.key.length > 80)
              throw failure('INVALID_INPUT', 'Invalid key.')
            await item.page.keyboard.press(input.key)
            break
          case 'scroll':
            if (![input.x, input.y].every((v) => Number.isFinite(v) && Math.abs(v) <= 4000))
              throw failure('INVALID_INPUT', 'Invalid wheel delta.')
            await item.page.mouse.wheel(input.x, input.y)
            break
          case 'navigate':
            await item.page.goto(browserUrl(input.url, this.protectedOrigins), {
              waitUntil: 'domcontentloaded',
              timeout: 20_000,
            })
            break
          case 'reload':
            await item.page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 })
            break
          case 'back':
            await item.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 })
            break
          case 'forward':
            await item.page.goForward({ waitUntil: 'domcontentloaded', timeout: 10_000 })
            break
          default:
            throw failure('INVALID_INPUT', 'Unsupported input.')
        }
        return this.describe(item)
      },
      signal,
      true,
    )
  }

  async closePage(identity, pageId, signal) {
    const item = this.get(identity, pageId)
    this.revoke(item)
    const epoch = this.epoch,
      controlEpoch = item.controlEpoch
    const closing = item.queue.then(async () => {
      this.guard(epoch)
      signal?.throwIfAborted()
      if (item.controlEpoch !== controlEpoch) throw failure('CONTROL_CHANGED', 'Page control changed.')
      await item.page.close()
      const session = this.sessions.get(identity.key)
      if (session?.context === item.page.context() && !session.pages.size && !session.opening)
        await this.closeSession(identity.key)
      this.notify()
    })
    item.queue = closing.catch(() => {})
    await closing
    return { status: 'ok', closedPageId: pageId }
  }

  async closeSession(key) {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    for (const item of session.pages.values()) {
      this.revoke(item)
      for (const view of item.viewers) view.close('session-closed')
    }
    if (session.context) {
      this.retiredContexts.add(session.context)
      try {
        await session.context.close()
        this.retiredContexts.delete(session.context)
      } catch (error) {
        this.cleanupRequired = true
        this.state = 'failed'
        this.error = 'Browser session cleanup is unconfirmed.'
        this.notify()
        throw error
      }
    }
  }

  async stop() {
    this.stopping = true
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)))
    const starting = this.starting
    this.starting = undefined
    await starting?.catch(() => {})
    try {
      if (this.instance) {
        await this.instance.close()
        this.instance = undefined
        this.retiredContexts.clear()
      } else {
        await Promise.all(
          [...this.retiredContexts].map(async (context) => {
            await context.close()
            this.retiredContexts.delete(context)
          }),
        )
      }
      this.cleanupRequired = false
      this.state = 'stopped'
      this.error = undefined
    } catch {
      this.cleanupRequired = true
      this.state = 'failed'
      this.error =
        'Browser cleanup is unconfirmed. Operation remains disabled; retry cleanup before reopening.'
      this.notify()
      throw failure('CLEANUP_UNCONFIRMED', this.error)
    } finally {
      this.stopping = false
    }
  }

  async close() {
    this.enabled = false
    this.closed = true
    this.epoch++
    await this.stop()
    this.listeners.clear()
  }
}
