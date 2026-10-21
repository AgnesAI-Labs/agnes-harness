import { captureAudio } from './audio.mjs'
import { failure } from './policy.mjs'

const identity = (scope) => {
  if (scope.kind !== 'session' || scope.laneId !== 'main') throw failure('DENIED', 'Session stream required.')
  return { key: scope.sessionId, lane: scope.laneId }
}

// View routing belongs to this plugin. The existing broker still owns admission,
// session authorization and transport lifetime.
const owner = (actor) => JSON.stringify([actor.id, actor.org ?? ''])

export async function selectView(runtime, input, context) {
  if (context.session.lane !== 'main') throw failure('DENIED', 'Session view required.')
  runtime.get(context.session, input.pageId)
  const view = runtime.views.get(input.viewId)
  if (
    !view ||
    view.session !== context.session.key ||
    view.owner !== owner(context.actor) ||
    view.signal.aborted
  )
    throw failure('DENIED', 'Active owned browser view required.')
  await view.select(input.pageId, input.sequence)
  return { status: 'ok' }
}

export async function showView(runtime, input, context) {
  if (!input.viewId) return showPage(runtime, input, context)
  const session = identity(context.scope)
  runtime.get(session, input.pageId)
  // Pinned session services and current profile streams can load different module
  // instances. Their view registry must live on the shared browser resource.
  const registry = runtime.views
  if (registry.has(input.viewId)) throw failure('DENIED', 'Browser view already exists.')
  let sequence = -1,
    capture,
    cleanup,
    stopped = false,
    queue = Promise.resolve()
  const view = {
    session: session.key,
    owner: owner(context.actor),
    signal: context.signal,
    select(pageId, nextSequence) {
      if (stopped || nextSequence <= sequence) return queue
      runtime.get(session, pageId)
      sequence = nextSequence
      capture?.abort()
      queue = queue
        .catch(() => {})
        .then(async () => {
          await cleanup?.()
          cleanup = undefined
          if (stopped || nextSequence !== sequence) return
          capture = new AbortController()
          cleanup = await showPage(
            runtime,
            { pageId, displayVersion: input.displayVersion },
            { ...context, signal: capture.signal },
          )
          if (stopped || nextSequence !== sequence) await cleanup()
        })
      return queue
    },
  }
  registry.set(input.viewId, view)
  const close = () => {
    if (stopped) return
    stopped = true
    registry.delete(input.viewId)
    context.signal.removeEventListener('abort', close)
    disconnect?.()
    capture?.abort()
    void queue.then(() => cleanup?.()).catch(() => {})
  }
  const disconnect = context.stream.onDisconnect(close)
  context.signal.addEventListener('abort', close, { once: true })
  if (context.signal.aborted) close()
  try {
    await view.select(input.pageId, 0)
  } catch (error) {
    close()
    throw error
  }
}

export function showPages(runtime, _input, context) {
  const session = identity(context.scope)
  if (context.origin) runtime.protectedOrigins.add(new URL(context.origin).origin)
  let previous,
    stopped = false
  const close = () => {
    stopped = true
    runtime.listeners.delete(notify)
  }
  const notify = () => {
    if (stopped || context.signal.aborted) return
    try {
      const status = runtime.status()
      const value = { ...status, pages: runtime.list(session) }
      const serialized = JSON.stringify(value)
      if (serialized === previous) return
      // Event JSON is bounded to 4 KiB. Long URLs retain the full query fallback.
      context.stream.send(Buffer.byteLength(serialized) > 3000 ? { ...status, changed: true } : value)
      previous = serialized
    } catch {
      context.stream.close('session-unavailable')
    }
  }
  runtime.listeners.add(notify)
  context.signal.addEventListener('abort', close, { once: true })
  context.stream.onDisconnect(close)
  if (context.signal.aborted) close()
  else notify()
}

export async function showPage(runtime, input, context) {
  const session = identity(context.scope)
  if (context.origin) runtime.protectedOrigins.add(new URL(context.origin).origin)
  const item = runtime.get(session, input.pageId)
  let stopped = false
  item.viewers.add(context.stream)
  item.modernViewers ??= new Set()
  if (input.displayVersion === 2) item.modernViewers.add(context.stream)
  const serialize = (work) => {
    const next = (item.captureQueue ?? Promise.resolve()).then(work)
    item.captureQueue = next.catch(() => {})
    return next
  }
  const close = async () => {
    if (stopped) return
    stopped = true
    context.signal.removeEventListener('abort', abort)
    disconnect?.()
    item.viewers.delete(context.stream)
    item.modernViewers.delete(context.stream)
    item.capture?.dropped?.delete(context.stream)
    await serialize(async () => {
      if (!item.modernViewers.size && item.capture?.stopAudio) {
        await item.capture.stopAudio()
        item.capture.stopAudio = undefined
      }
      if (item.viewers.size || !item.capture) return
      const capture = item.capture
      item.capture = undefined
      clearTimeout(capture.timer)
      clearTimeout(capture.retry)
      clearTimeout(capture.settle)
      runtime.listeners.delete(capture.broadcast)
      await capture.stopAudio?.()
      await capture.cdp.send('Page.stopScreencast').catch(() => {})
      await capture.cdp.detach().catch(() => {})
    })
  }
  const abort = () => void close()
  context.signal.addEventListener('abort', abort, { once: true })
  const disconnect = context.stream.onDisconnect(close)
  try {
    await serialize(async () => {
      if (stopped || context.signal.aborted) return
      if (!item.capture) {
        const cdp = await item.page.context().newCDPSession(item.page)
        // A secondary CDP session otherwise uses its default 1x capture metrics.
        // Keep this session aligned with the context's existing CSS viewport/DPR.
        try {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1280,
            height: 800,
            deviceScaleFactor: 2,
            mobile: false,
          })
        } catch (error) {
          await cdp.detach().catch(() => {})
          throw error
        }
        const capture = {
          cdp,
          bytes: undefined,
          pageEpoch: -1,
          last: -Infinity,
          dropped: new Set(),
          liveWidth: 2560,
          broadcast: () => {},
        }
        let paintVersion = 0,
          snapshotting = false
        const settle = (first = false) => {
          clearTimeout(capture.settle)
          capture.settle = setTimeout(
            async () => {
              capture.settle = undefined
              if (snapshotting || item.capture !== capture || !item.viewers.size) return
              const epoch = item.epoch,
                version = paintVersion,
                inputVersion = item.inputVersion,
                agentRevision = item.agentRevision,
                liveBytes = capture.liveEpoch === item.epoch ? capture.liveBytes : undefined
              snapshotting = true
              try {
                runtime.get(session, input.pageId)
                // Let the pinned engine resolve the scrolled viewport and device scale together.
                // Raw CDP capture without that normalization can return only CSS-sized pixels.
                let bytes, mime
                // Preserve text edges without sacrificing bounded transport on photo-heavy pages.
                for (const options of [
                  ...(item.modernViewers.size === item.viewers.size ? [{ type: 'png' }] : []),
                  ...[90, 65, 35, 15].map((quality) => ({ type: 'jpeg', quality })),
                ]) {
                  bytes = await item.page.screenshot({
                    ...options,
                    fullPage: false,
                    scale: 'device',
                  })
                  mime = options.type === 'png' ? 'image/png' : 'image/jpeg'
                  if (bytes.length <= 1_000_000) break
                  if (item.capture !== capture || item.epoch !== epoch || item.inputVersion !== inputVersion)
                    return
                }
                runtime.get(session, input.pageId)
                if (
                  item.capture !== capture ||
                  item.epoch !== epoch ||
                  paintVersion !== version ||
                  item.inputVersion !== inputVersion
                )
                  return
                if (bytes.length > 1_000_000) return
                clearTimeout(capture.timer)
                capture.pending = undefined
                capture.bytes = bytes
                capture.agentRevision = agentRevision
                capture.mime = mime
                capture.pageEpoch = epoch
                capture.sharpLiveBytes = liveBytes
                capture.sharpInputVersion = inputVersion
                capture.snapshotFailures = 0
                capture.broadcast()
              } catch {
                // A transient capture failure must not strand a static tab at its
                // live quality. Retry a bounded number of times without blocking input.
                capture.snapshotFailures = (capture.snapshotFailures ?? 0) + 1
                if (item.capture === capture && capture.snapshotFailures <= 3) settle()
              } finally {
                snapshotting = false
                // A screenshot can itself repaint Chromium. If a paint invalidates
                // this attempt, retry after idle instead of losing the last timer
                // while the screenshot is still running. Identical live pixels are
                // deduplicated below; asynchronous page changes remain observable.
                if (
                  item.capture === capture &&
                  (item.epoch !== epoch || item.inputVersion !== inputVersion || paintVersion !== version)
                )
                  settle(item.epoch !== epoch || !capture.bytes)
              }
              // Static tabs may not emit a screencast paint. Supply their first image
              // immediately; only sharpening an already visible page waits for idle.
            },
            first ? 0 : 250,
          )
        }
        const publish = () => {
          capture.timer = undefined
          const pending = capture.pending
          capture.pending = undefined
          if (!pending || item.capture !== capture || pending.pageEpoch !== item.epoch) return
          capture.last = performance.now()
          capture.bytes = pending.bytes
          capture.sharpLiveBytes = undefined
          capture.agentRevision = pending.agentRevision
          capture.mime = 'image/jpeg'
          capture.pageEpoch = pending.pageEpoch
          capture.broadcast()
        }
        capture.broadcast = (recipients = item.viewers) => {
          try {
            runtime.get(session, input.pageId)
            // Never stamp cached pixels from the previous document with a new target epoch.
            if (capture.pageEpoch !== item.epoch) {
              // History restoration can change documents without a screencast paint.
              // Capture new pixels; never relabel the old image with the new epoch.
              if (!snapshotting && !capture.settle) settle(true)
              return
            }
            if (!capture.bytes) return
            // URLs belong to the session page list, not to every image envelope.
            // Omitting them also keeps long addresses below the decoder's metadata limit.
            const { url: _url, ...description } = runtime.describe(item)
            const metadata = Buffer.from(
              JSON.stringify({
                ...description,
                agentRevision: capture.agentRevision ?? description.agentRevision,
                frameMime: capture.mime ?? 'image/jpeg',
              }),
              'utf8',
            )
            const header = Buffer.alloc(4)
            header.writeUInt32BE(metadata.length)
            const envelope = Buffer.concat([header, metadata, capture.bytes])
            for (const viewer of recipients) {
              if (!item.viewers.has(viewer)) {
                capture.dropped.delete(viewer)
                continue
              }
              if (capture.mime === 'image/png' && !item.modernViewers.has(viewer)) {
                settle(true)
                continue
              }
              if (viewer.send(envelope) === 'dropped') capture.dropped.add(viewer)
              else capture.dropped.delete(viewer)
            }
            // A static page may have no later paint. Retry only the newest image
            // after backpressure, using the existing media budget and bounded buffers.
            if (capture.dropped.size)
              capture.retry ??= setTimeout(() => {
                capture.retry = undefined
                if (item.capture === capture) capture.broadcast(new Set(capture.dropped))
              }, 100)
          } catch {
            for (const viewer of item.viewers) viewer.close('page-unavailable')
          }
        }
        cdp.on('Page.screencastFrame', (frame) => {
          void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
          if (item.capture !== capture) return
          const bytes = Buffer.from(frame.data, 'base64')
          // Large photographic frames must not freeze the view or build latency.
          // Reduce live cost; the idle image retains the context's full 2x detail.
          if (bytes.length > 150_000 && capture.liveWidth > 1280 && !capture.tuning) {
            capture.tuning = true
            capture.liveWidth = capture.liveWidth === 2560 ? 1920 : 1280
            void cdp
              .send('Page.stopScreencast')
              .then(async () => {
                if (item.capture !== capture) return
                await cdp.send('Page.startScreencast', {
                  format: 'jpeg',
                  quality: 65,
                  maxWidth: capture.liveWidth,
                  maxHeight: (capture.liveWidth * 800) / 1280,
                  everyNthFrame: 1,
                })
              })
              .catch(() => {})
              .finally(() => {
                capture.tuning = false
              })
          }
          if (bytes.length > 1_000_000) return
          // Screenshot capture can provoke an identical screencast repaint. Do not
          // downgrade the sharp image or repeatedly schedule captures for those pixels.
          if (capture.liveEpoch === item.epoch && capture.liveBytes?.equals(bytes)) return
          capture.liveBytes = bytes
          capture.liveEpoch = item.epoch
          // Surface screenshots can briefly repaint before restoring the exact
          // prior live pixels. Coalesce that repaint pair:
          // retain the sharp image when the final pixels are unchanged. Genuine
          // input bypasses this window; an asynchronous scene change still wins.
          const sharp =
            capture.pageEpoch === item.epoch && capture.sharpInputVersion === item.inputVersion
              ? capture.sharpLiveBytes
              : undefined
          if (sharp?.equals(bytes)) {
            clearTimeout(capture.timer)
            clearTimeout(capture.settle)
            capture.timer = undefined
            capture.settle = undefined
            capture.pending = undefined
            return
          }
          paintVersion++
          settle()
          // Keep the final paint of a burst: dropping it can leave a static page showing old pixels.
          capture.pending = { bytes, pageEpoch: item.epoch, agentRevision: item.agentRevision }
          // Match the existing 4 MiB/s media allowance without growing its queue or budget.
          const interval = Math.max(1000 / 60, bytes.length / 3500)
          const delay = Math.max(sharp ? 50 : 0, interval - (performance.now() - capture.last))
          if (delay <= 0) {
            clearTimeout(capture.timer)
            publish()
          } else capture.timer ??= setTimeout(publish, Math.ceil(delay))
        })
        item.capture = capture
        if (item.modernViewers.size)
          capture.stopAudio = await captureAudio(runtime, item, capture).catch(() => undefined)
        runtime.listeners.add(capture.broadcast)
        try {
          await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 85,
            maxWidth: 2560,
            maxHeight: 1600,
            // Coalesce at publish(), where the final paint is retained. Sampling
            // here can discard a static page's only update after a click.
            everyNthFrame: 1,
          })
          settle(true)
        } catch (error) {
          clearTimeout(capture.timer)
          clearTimeout(capture.retry)
          clearTimeout(capture.settle)
          runtime.listeners.delete(capture.broadcast)
          item.capture = undefined
          await capture.stopAudio?.()
          await cdp.detach().catch(() => {})
          throw error
        }
      } else {
        if (item.modernViewers.size && !item.capture.stopAudio)
          item.capture.stopAudio = await captureAudio(runtime, item, item.capture).catch(() => undefined)
        item.capture.broadcast()
      }
    })
    if (context.signal.aborted) await close()
    return close
  } catch (error) {
    await close()
    throw error
  }
}

export function acceptInput(runtime, input, context) {
  const session = identity(context.scope)
  const item = runtime.get(session, input.pageId)
  if (!context.control || item.control?.nativeId !== context.control.grantId)
    throw failure('DENIED', 'Native page control grant required.')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    // Lease rollover can connect first; only the current stream may pause control.
    if (item.inputStream === context.stream) {
      item.inputStream = undefined
      item.mode = 'paused'
      for (const key of ['Shift', 'Control', 'Alt', 'Meta']) void item.page.keyboard.up(key).catch(() => {})
      void item.page.mouse.up().catch(() => {})
    }
  }
  const previous = item.inputStream
  item.inputStream = context.stream
  previous?.close('control-replaced')
  item.mode = 'human'
  context.signal.addEventListener('abort', close, { once: true })
  context.stream.onDisconnect(close)
  context.stream.onFrame((frame) => {
    if (
      closed ||
      item.inputStream !== context.stream ||
      context.signal.aborted ||
      frame instanceof Uint8Array ||
      !frame ||
      typeof frame !== 'object'
    )
      return
    void runtime
      .humanInput(
        session,
        {
          ...frame,
          pageId: input.pageId,
          controlId: item.control?.id,
        },
        context.actor,
        context.signal,
      )
      .then(
        (result) => context.stream.send({ seq: frame.seq, status: 'ok', ...result }),
        (error) => context.stream.send({ seq: frame.seq, status: 'error', code: error.code ?? 'UNCERTAIN' }),
      )
  })
}
