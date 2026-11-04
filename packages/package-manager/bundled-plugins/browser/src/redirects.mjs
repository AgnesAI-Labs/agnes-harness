import { browserUrl, failure } from './policy.mjs'

const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

// Chromium redirects bypass Playwright's route callback after the first hop.
// Pause new page/frame targets before their first request and install a
// CDP request guard. This browser is exclusively owned by the plugin. No host
// protocol, browser private API, personal profile or external CDP endpoint.
export async function guardRedirects(browser, protectedOrigins) {
  const root = await browser.newBrowserCDPSession()
  const filter = ['page', 'iframe', 'shared_worker'].map((type) => ({ type, exclude: false }))
  filter.push({ exclude: true })
  let stopped = false
  let navigationVersion = 0
  const frames = new Map(),
    owners = new Map(),
    targets = new Map()
  const remember = (tree, since) => {
    const previous = frames.get(tree.frame.id)
    if (since === undefined || !(previous?.navigationVersion > since))
      frames.set(tree.frame.id, {
        ...previous,
        ...tree.frame,
        navigationVersion: since === undefined ? ++navigationVersion : navigationVersion,
      })
    for (const child of tree.childFrames ?? []) remember(child, since)
  }
  const forget = (id) => {
    for (const frame of frames.values()) if (frame.parentId === id) forget(frame.id)
    frames.delete(id)
  }
  const ancestry = (id) => {
    const result = [],
      seen = new Set()
    for (let frame = frames.get(id); frame && !seen.has(frame.id); frame = frames.get(frame.parentId)) {
      seen.add(frame.id)
      result.push(frame)
    }
    return result
  }
  const authorize = (event, targetInfo, document) => {
    const { request, frameId, resourceType } = event
    const target = new URL(request.url),
      chain = ancestry(frameId)
    const item = chain.map((frame) => owners.get(frame.id)).find(Boolean)
    const owned = item && !item.page.isClosed()
    const pdfExtension = target.protocol + '//' + target.host === PDF_VIEWER_ORIGIN
    const pdfResources = target.protocol === 'chrome:' && target.hostname === 'resources'
    if (pdfExtension || pdfResources) {
      if (
        !owned ||
        !chain.some((frame) => frame.pdf && frame.pdfLoader === frame.loaderId) ||
        (pdfResources && !chain[0]?.url?.startsWith(PDF_VIEWER_ORIGIN + '/'))
      )
        throw failure('FILE_DENIED', 'Internal PDF viewer requires a PDF document.')
      return
    }
    let trustedNavigation = false
    if (owned && resourceType === 'Document' && owners.get(frameId) === item) {
      const pending = item.pendingNavigation
      item.pendingNavigation = undefined
      if (pending) {
        const planned = pending === 'history' ? undefined : new URL(pending)
        if (planned) planned.hash = ''
        trustedNavigation = pending === 'history' || planned.href === target.href
      }
    }
    if (resourceType === 'Document' && frames.has(frameId)) frames.get(frameId).pdf = false
    // Search all owned previews, including other contexts: a worker or foreign
    // page never acquires a file capability merely by discovering its URL.
    for (const candidate of owners.values()) {
      const preview = candidate.filePreviews?.get(target.origin)
      if (!preview) continue
      if (resourceType !== 'Document') {
        if (
          !document ||
          typeof document.documentURL !== 'string' ||
          !document.documentURL ||
          document.frameId !== frameId ||
          !chain.length
        )
          throw failure('FILE_DENIED', 'File request document is unavailable.')
        // Bind to the document that initiated THIS request. A newly committed
        // remote iframe must not borrow its predecessor's about:blank ancestry.
        if (['about:blank', 'about:srcdoc'].includes(document.documentURL)) {
          if (!document.loaderId || document.loaderId !== chain[0].loaderId)
            throw failure('FILE_DENIED', 'File request document changed.')
        } else chain[0] = { ...chain[0], url: document.documentURL }
      }
      let fileAncestor = false
      for (const frame of chain) {
        const url = frame.url ?? ''
        if (url && new URL(url).origin === target.origin) {
          fileAncestor = true
          break
        }
        if (!['', 'about:blank', 'about:srcdoc'].includes(url) && !url.startsWith(PDF_VIEWER_ORIGIN + '/'))
          break
      }
      if (
        !owned ||
        candidate !== item ||
        targetInfo.type === 'shared_worker' ||
        (!trustedNavigation && !fileAncestor)
      )
        throw failure('FILE_DENIED', 'Foreign file preview.')
      const headers = new Map(
        Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
      )
      for (const [name, value] of Object.entries(preview.headers)) headers.set(name.toLowerCase(), value)
      return [...headers].map(([name, value]) => ({ name, value }))
    }
    browserUrl(request.url, protectedOrigins)
  }
  const fail = () => {
    if (!stopped) {
      stopped = true
      void browser.close().catch(() => {})
    }
  }
  const wire = (sendMessage) => {
    let id = 0
    let closed = false
    const pending = new Map(),
      listeners = new Map()
    return {
      send(method, params = {}) {
        if (closed) return Promise.reject(new Error('Browser target closed'))
        return new Promise((resolve, reject) => {
          const key = ++id
          const timer = setTimeout(() => {
            pending.delete(key)
            reject(new Error('Browser request guard timed out'))
          }, 5000)
          timer.unref()
          pending.set(key, { resolve, reject, timer })
          void sendMessage(JSON.stringify({ id: key, method, params })).catch((error) => {
            pending.delete(key)
            clearTimeout(timer)
            reject(error)
          })
        })
      },
      on(event, callback) {
        listeners.set(event, callback)
      },
      receive(message) {
        const value = JSON.parse(message)
        if (value.id) {
          const operation = pending.get(value.id)
          pending.delete(value.id)
          clearTimeout(operation?.timer)
          if (value.error) operation?.reject(new Error(value.error.message))
          else operation?.resolve(value.result)
        } else listeners.get(value.method)?.(value.params)
      },
      close() {
        if (closed) return
        closed = true
        listeners.get('close')?.()
        listeners.clear()
        for (const operation of pending.values()) {
          clearTimeout(operation.timer)
          operation.reject(new Error('Browser target closed'))
        }
        pending.clear()
      },
    }
  }
  const attach = async (parent, browserLevel = false, dispose = () => {}) => {
    const seen = new Set()
    const children = new Map()
    const close = () => {
      for (const child of children.values()) child.close()
      children.clear()
      seen.clear()
      dispose()
    }
    parent.on('close', close)
    parent.on('Target.receivedMessageFromTarget', ({ sessionId, message }) =>
      children.get(sessionId)?.receive(message),
    )
    parent.on('Target.detachedFromTarget', ({ sessionId }) => {
      const child = children.get(sessionId)
      if (child) seen.delete(child.targetId)
      if (child && targets.get(child.targetId) === child) targets.delete(child.targetId)
      child?.close()
      children.delete(sessionId)
    })
    parent.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
      if (seen.has(targetInfo.targetId)) return
      seen.add(targetInfo.targetId)
      const setup = async () => {
        const automaticSession = sessionId
        if (browserLevel) {
          const attached = await parent.send('Target.attachToTarget', {
            targetId: targetInfo.targetId,
            flatten: false,
          })
          sessionId = attached.sessionId
        }
        const child = wire((message) => parent.send('Target.sendMessageToTarget', { sessionId, message }))
        child.targetId = targetInfo.targetId
        children.set(sessionId, child)
        targets.set(child.targetId, child)
        // Request IDs are scoped to this protocol session. Retain only active
        // requests; closing a target releases metadata and wakes pending checks.
        const requests = new Map(),
          awaitingRequests = new Map()
        const completeRequest = (id, value) => {
          for (const finish of awaitingRequests.get(id) ?? []) finish(value)
          awaitingRequests.delete(id)
        }
        const requestDocument = (event) => {
          if (!event.networkId) return Promise.resolve(undefined)
          const known = requests.get(event.networkId)
          if (known) return Promise.resolve(known)
          return new Promise((resolve) => {
            const finish = (value) => {
              clearTimeout(timer)
              awaitingRequests.get(event.networkId)?.delete(finish)
              if (!awaitingRequests.get(event.networkId)?.size) awaitingRequests.delete(event.networkId)
              resolve(value)
            }
            const timer = setTimeout(() => finish(undefined), 5000)
            timer.unref()
            if (!awaitingRequests.has(event.networkId)) awaitingRequests.set(event.networkId, new Set())
            awaitingRequests.get(event.networkId).add(finish)
          })
        }
        child.on('Fetch.requestPaused', (event) => {
          const dispatch = async () => {
            const { requestId } = event
            let allowed = true
            let headers
            try {
              let document
              const previewRequest = [...owners.values()].some((item) =>
                item.filePreviews?.has(new URL(event.request.url).origin),
              )
              if (previewRequest && event.resourceType !== 'Document') document = await requestDocument(event)
              // Chromium can request PDF-viewer styles before its navigation
              // event reaches this session. Read the browser's committed frame
              // tree; never infer a privileged origin from Referer/page content.
              if (
                (document && ['about:blank', 'about:srcdoc'].includes(document.documentURL)) ||
                (event.request.url.startsWith('chrome://resources/') &&
                  !frames.get(event.frameId)?.url?.startsWith(PDF_VIEWER_ORIGIN + '/'))
              ) {
                child.refresh ??= (async () => {
                  const since = navigationVersion
                  remember((await child.send('Page.getFrameTree')).frameTree, since)
                })().finally(() => {
                  child.refresh = undefined
                })
                await child.refresh
              }
              headers = authorize(event, targetInfo, document)
            } catch {
              allowed = false
            }
            void child
              .send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
                requestId,
                ...(headers ? { headers } : {}),
                ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
              })
              .catch(() => {
                if (children.has(sessionId)) fail()
              })
          }
          void dispatch().catch(() => {
            if (children.has(sessionId)) fail()
          })
        })
        child.ready = (async () => {
          // Guard before releasing startup. Renderer-dependent commands such as
          // cache configuration cannot finish while the target is debugger-paused.
          await child.send('Fetch.enable', {
            patterns: [{ urlPattern: '*', requestStage: 'Request' }],
          })
          // Retain the previous routing cache behavior. No implicit cache or
          // service-worker policy change is part of consolidating interception.
          child.on('Network.responseReceived', ({ type, frameId, loaderId, response }) => {
            if (type === 'Document' && frameId)
              frames.set(frameId, {
                ...frames.get(frameId),
                id: frameId,
                pdf: /^application\/pdf(?:;|$)/i.test(response.mimeType),
                pdfLoader: loaderId,
              })
          })
          child.on('Network.requestWillBeSent', ({ requestId, frameId, loaderId, documentURL }) => {
            const value = { frameId, loaderId, documentURL }
            requests.set(requestId, value)
            completeRequest(requestId, value)
          })
          for (const event of ['Network.loadingFinished', 'Network.loadingFailed'])
            child.on(event, ({ requestId }) => {
              requests.delete(requestId)
              completeRequest(requestId, undefined)
            })
          if (targetInfo.type !== 'shared_worker') {
            child.on('Page.frameAttached', ({ frameId, parentFrameId }) => {
              frames.set(frameId, { ...frames.get(frameId), id: frameId, parentId: parentFrameId })
            })
            child.on('Page.frameNavigated', ({ frame }) => remember({ frame }))
            child.on('Page.frameDetached', ({ frameId, reason }) => {
              if (reason === 'remove') forget(frameId)
            })
          }
          await attach(child, false, () => {
            requests.clear()
            for (const id of awaitingRequests.keys()) completeRequest(id, undefined)
          })
          if (browserLevel) await parent.send('Target.detachFromTarget', { sessionId: automaticSession })
          // Queue recording before resuming: a new cross-origin iframe can
          // issue its first subresources immediately when startup is released.
          const recording = child.send('Network.enable')
          const navigation =
            targetInfo.type === 'shared_worker' ? Promise.resolve() : child.send('Page.enable')
          const cache = child.send('Network.setCacheDisabled', { cacheDisabled: true })
          await Promise.all([recording, navigation, cache, child.send('Runtime.runIfWaitingForDebugger')])
          if (targetInfo.type !== 'shared_worker') {
            const since = navigationVersion
            const { frameTree } = await child.send('Page.getFrameTree')
            child.frameId = frameTree.frame.id
            remember(frameTree, since)
          }
        })()
        void child.ready.catch(() => {
          if (children.has(sessionId)) fail()
        })
      }
      void setup().catch(async () => {
        seen.delete(targetInfo.targetId)
        // A popup may be closed by the tab limit while attaching. A live target
        // without its guard is fatal; normal target destruction is not.
        const exists = await root.send('Target.getTargetInfo', { targetId: targetInfo.targetId }).then(
          () => true,
          () => false,
        )
        if (exists) fail()
      })
    })
    await parent.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: browserLevel,
      filter,
    })
    return close
  }
  // Playwright also auto-attaches every new target and resumes it once its own page session is
  // ready, which can be before this guard's target session enables interception. A popup opened
  // with a URL then sends its first request and every redirect hop unguarded. Interception on the
  // browser target sees each request of every target from its first byte, so it refuses protected
  // http(s) destinations here as well; the target sessions keep the file and PDF decisions.
  root.on('Fetch.requestPaused', ({ requestId, request }) => {
    let allowed = true
    // File previews are decided per document by the target sessions below.
    if (
      /^https?:/i.test(request.url) &&
      ![...owners.values()].some((item) => item.filePreviews?.has(new URL(request.url).origin))
    )
      try {
        browserUrl(request.url, protectedOrigins)
      } catch {
        allowed = false
      }
    // A request cancelled by its page (a closed popup) can no longer be continued; that is not a
    // guard failure, and a refused one is never sent either way.
    void root
      .send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId,
        ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
      })
      .catch(() => {})
  })
  await root.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  const close = await attach(root, true)
  browser.on('disconnected', () => {
    stopped = true
    close()
    frames.clear()
    owners.clear()
    targets.clear()
  })
  return {
    async bind(item) {
      const session = await item.page.context().newCDPSession(item.page)
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo')
        const target = targets.get(targetInfo.targetId)
        if (!target) throw failure('CLOSED', 'Browser request guard unavailable.')
        await target.ready
        if (stopped || item.page.isClosed()) throw failure('CLOSED', 'Browser page closed.')
        if (!target.frameId) throw failure('CLOSED', 'Browser page frame unavailable.')
        owners.set(target.frameId, item)
      } finally {
        await session.detach().catch(() => {})
      }
    },
    unbind(item) {
      for (const [id, owner] of owners)
        if (owner === item) {
          owners.delete(id)
          forget(id)
        }
    },
  }
}
