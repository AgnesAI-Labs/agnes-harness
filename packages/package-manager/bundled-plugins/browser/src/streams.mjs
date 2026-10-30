import { captureAudio } from './audio.mjs'
import { viewportInput } from './contracts.mjs'
import { releaseInput } from './pointer.mjs'
import { failure } from './policy.mjs'

const identity = (scope) => {
  if (scope.kind !== 'session' || scope.laneId !== 'main') throw failure('DENIED', 'Session stream required.')
  return { key: scope.sessionId, lane: scope.laneId }
}

// View routing belongs to this plugin. The existing broker still owns admission,
// session authorization and transport lifetime.
const owner = (actor) => JSON.stringify([actor.id, actor.org ?? ''])

// Read only the native PNG/JPEG dimensions, as in the CLI's image smoke fixture.
// Chromium's metadata can precede the compositor surface during a resize.
function matchesRaster(bytes, viewport) {
  let width, height
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset++] !== 255) break
      const marker = bytes[offset++]
      if ([192, 193, 194].includes(marker)) {
        width = bytes.readUInt16BE(offset + 5)
        height = bytes.readUInt16BE(offset + 3)
        break
      }
      const size = bytes.readUInt16BE(offset)
      if (size < 2) break
      offset += size
    }
  }
  return width === undefined || (width === viewport.width * 2 && height === viewport.height * 2)
}

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
  validateViewport(input.viewport)
  await view.select(input.pageId, input.sequence, input.viewport)
  return { status: 'ok', ...runtime.describe(runtime.get(context.session, input.pageId)) }
}

function validateViewport(viewport) {
  if (viewport === undefined) return
  if (
    !viewport ||
    typeof viewport !== 'object' ||
    Array.isArray(viewport) ||
    Object.keys(viewport).length !== 2 ||
    Object.entries(viewportInput.properties).some(
      ([key, bounds]) =>
        !Number.isSafeInteger(viewport[key]) ||
        viewport[key] < bounds.minimum ||
        viewport[key] > bounds.maximum,
    )
  )
    throw failure('INVALID_INPUT', 'Invalid browser viewport.')
}

async function resizeViewport(runtime, session, item, view, viewport) {
  if (viewport === undefined) return
  validateViewport(viewport)
  const pending = item.queue.then(async () => {
    runtime.get(session, item.id)
    if (view.signal.aborted) return
    // One visible view owns geometry. Other windows display the same page without resize fights.
    if (item.viewportView && item.viewportView !== view && !item.viewportView.signal.aborted) return
    item.viewportView = view
    if (item.viewport.width === viewport.width && item.viewport.height === viewport.height) return
    item.resizing = true
    item.epoch++
    item.inputVersion++
    item.humanRevision++
    runtime.clearRefs(item)
    try {
      if (item.gesture) {
        await item.page.mouse.up()
        item.gesture = undefined
      }
      await item.capture?.pause()
      view.signal.throwIfAborted()
      runtime.get(session, item.id)
      await item.page.setViewportSize(viewport)
      item.viewport = { ...viewport }
      // Geometry invalidates the page epoch too. Reuse the audio tap with the
      // new epoch; accepting old packets would weaken navigation isolation.
      const capture = item.capture
      if (capture?.stopAudio) {
        await capture.stopAudio()
        capture.stopAudio = undefined
        if (item.capture === capture && item.modernViewers?.size)
          capture.stopAudio = await captureAudio(runtime, item, capture).catch(() => undefined)
      }
      await item.capture?.resume()
    } catch (error) {
      item.uncertain = true
      for (const viewer of item.viewers) viewer.close('viewport-unavailable')
      throw error
    } finally {
      item.resizing = false
      runtime.notify()
    }
  })
  item.queue = pending.catch(() => {})
  await pending
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
    capturedPageId,
    capture,
    cleanup,
    stopped = false,
    queue = Promise.resolve()
  const view = {
    session: session.key,
    owner: owner(context.actor),
    signal: context.signal,
    pageId: input.pageId,
    select(pageId, nextSequence, viewport) {
      if (stopped || nextSequence <= sequence) return queue
      runtime.get(session, pageId)
      sequence = nextSequence
      view.pageId = pageId
      if (capturedPageId !== pageId) capture?.abort()
      queue = queue
        .catch(() => {})
        .then(async () => {
          if (capturedPageId !== pageId) {
            await cleanup?.()
            cleanup = undefined
            capturedPageId = undefined
            for (const page of runtime.list(session)) {
              const item = runtime.get(session, page.pageId)
              if (item.viewportView === view && item.id !== pageId) item.viewportView = undefined
            }
          }
          if (stopped || nextSequence !== sequence) return
          await resizeViewport(runtime, session, runtime.get(session, pageId), view, viewport)
          if (stopped || nextSequence !== sequence) return
          if (capturedPageId === pageId) {
            runtime.get(session, pageId).capture?.broadcast()
            return
          }
          capture = new AbortController()
          cleanup = await showPage(
            runtime,
            { pageId, displayVersion: input.displayVersion },
            { ...context, signal: capture.signal },
          )
          capturedPageId = pageId
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
    for (const entry of runtime.sessions.get(session.key)?.pages.values() ?? [])
      if (entry.viewportView === view) entry.viewportView = undefined
    context.signal.removeEventListener('abort', close)
    disconnect?.()
    capture?.abort()
    void queue.then(() => cleanup?.()).catch(() => {})
  }
  const disconnect = context.stream.onDisconnect(close)
  context.signal.addEventListener('abort', close, { once: true })
  if (context.signal.aborted) close()
  try {
    await view.select(input.pageId, 0, input.viewport)
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
      capture.paused = true
      capture.cdp.off('Page.screencastFrame', capture.onFrame)
      runtime.listeners.delete(capture.broadcast)
      await capture.stopAudio?.()
      capture.releaseAcks?.()
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
        const capture = {
          cdp,
          bytes: undefined,
          pageEpoch: -1,
          last: -Infinity,
          dropped: new Set(),
          paused: false,
          liveFormat: 'jpeg',
          liveQuality: 90,
          averageBytes: 0,
          tunedAt: -Infinity,
          broadcast: () => {},
        }
        let paintVersion = 0,
          snapshotting = false
        const settle = (first = false) => {
          clearTimeout(capture.settle)
          capture.settle = setTimeout(
            async () => {
              capture.settle = undefined
              if (
                snapshotting ||
                item.resizing ||
                capture.paused ||
                item.capture !== capture ||
                !item.viewers.size
              )
                return
              // A current, full-density lossless live frame needs no second
              // surface capture. Keep the fallback for missing frames, JPEG,
              // legacy viewers and input that has not produced new pixels yet.
              if (
                capture.mime === 'image/png' &&
                capture.bytes === capture.liveBytes &&
                capture.bytes?.length >= 24 &&
                capture.bytes.readUInt32BE(0) === 0x89504e47 &&
                capture.bytes.readUInt32BE(4) === 0x0d0a1a0a &&
                capture.liveEpoch === item.epoch &&
                capture.liveInputVersion === item.inputVersion &&
                item.modernViewers.size === item.viewers.size
              )
                return
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
                if (!matchesRaster(bytes, item.viewport)) throw new Error('Screenshot surface is resizing.')
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
                // Recover lossless live text after a complex scene becomes cheap again.
                if (mime === 'image/png' && bytes.length <= 250_000 && capture.liveFormat !== 'png')
                  retune('png', 90)
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
              // Allow one compositor frame to supply lossless pixels before a
              // fallback screenshot. Legacy/JPEG still gets an immediate fallback.
            },
            first
              ? capture.liveFormat === 'png' && item.modernViewers.size === item.viewers.size
                ? 16
                : 0
              : 250,
          )
        }
        const publish = () => {
          capture.timer = undefined
          const pending = capture.pending
          capture.pending = undefined
          if (
            !pending ||
            item.resizing ||
            capture.paused ||
            item.capture !== capture ||
            pending.pageEpoch !== item.epoch
          )
            return
          capture.last = performance.now()
          capture.bytes = pending.bytes
          capture.sharpLiveBytes = undefined
          capture.agentRevision = pending.agentRevision
          capture.mime = pending.mime
          capture.pageEpoch = pending.pageEpoch
          capture.broadcast()
        }
        capture.broadcast = (recipients = item.viewers) => {
          try {
            runtime.get(session, input.pageId)
            if (item.resizing || capture.paused) return
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
        const retune = (format, quality) => {
          if (capture.tuning || item.capture !== capture) return
          capture.tunedAt = performance.now()
          const pending = item.queue.then(async () => {
            if (item.capture !== capture || !item.viewers.size) return
            await capture.pause()
            await capture.resume(format, quality)
          })
          item.queue = pending.catch(() => {})
          capture.tuning = pending
            .catch(() => {
              for (const viewer of item.viewers) viewer.close('capture-unavailable')
            })
            .finally(() => {
              capture.tuning = undefined
            })
        }
        const acknowledgements = new Map()
        capture.releaseAcks = () => {
          for (const [ack, timer] of acknowledgements) {
            clearTimeout(timer)
            void cdp.send('Page.screencastFrameAck', { sessionId: ack.id }).catch(() => {})
          }
          acknowledgements.clear()
        }
        capture.onFrame = (frame) => {
          // Chromium bounds in-flight screencast frames. Delay acknowledgement
          // instead of throwing away every Nth paint (which loses final updates).
          const ackDelay = runtime.now() - (item.lastInputAt ?? -Infinity) < 600 ? 30 : 100
          const ack = { id: frame.sessionId }
          acknowledgements.set(
            ack,
            setTimeout(() => {
              acknowledgements.delete(ack)
              void cdp.send('Page.screencastFrameAck', { sessionId: ack.id }).catch(() => {})
            }, ackDelay),
          )
          if (item.capture !== capture || capture.paused || item.resizing) return
          // The compositor can deliver the previous surface after a resize.
          // Its pixels must never acquire the new viewport's epoch or coordinates.
          if (
            frame.metadata &&
            (frame.metadata.deviceWidth !== item.viewport.width ||
              frame.metadata.deviceHeight !== item.viewport.height)
          )
            return
          const bytes = Buffer.from(frame.data, 'base64')
          if (!matchesRaster(bytes, item.viewport)) {
            if (!snapshotting && !capture.settle) settle(true)
            return
          }
          // Keep 2x resolution while scrolling. Compress photo-heavy scenes rather
          // than permanently reducing the number of pixels after one large paint.
          if (capture.liveFormat === 'png' && bytes.length > 250_000) retune('jpeg', 90)
          else if (bytes.length > 1_000_000 && capture.liveQuality > 25)
            retune('jpeg', Math.max(25, capture.liveQuality - 20))
          if (bytes.length > 1_000_000) return
          // Screenshot capture can provoke an identical screencast repaint. Do not
          // downgrade the sharp image or repeatedly schedule captures for those pixels.
          if (capture.liveEpoch === item.epoch && capture.liveBytes?.equals(bytes)) return
          capture.averageBytes = capture.averageBytes
            ? capture.averageBytes * 0.8 + bytes.length * 0.2
            : bytes.length
          // Aim at 30 moving frames inside the existing allowance, reserving
          // capacity for audio/envelopes. Keep 2x pixels and a quality floor;
          // static text still gets the lossless idle screenshot above.
          if (capture.liveFormat === 'jpeg' && performance.now() - capture.tunedAt >= 750) {
            if (capture.averageBytes > 126_000 && capture.liveQuality > 70)
              retune('jpeg', Math.max(70, capture.liveQuality - (capture.averageBytes > 180_000 ? 20 : 10)))
            // Recover an oversized-frame fallback, but leave ordinary moving
            // scenes stable. Idle PNG restores detail without quality oscillation.
            else if (capture.averageBytes < 70_000 && capture.liveQuality < 70)
              retune('jpeg', Math.min(70, capture.liveQuality + 20))
          }
          capture.liveBytes = bytes
          capture.liveEpoch = item.epoch
          capture.liveInputVersion = item.inputVersion
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
          capture.pending = {
            bytes,
            mime: 'image/' + capture.liveFormat,
            pageEpoch: item.epoch,
            agentRevision: item.agentRevision,
          }
          // Match the existing 4 MiB/s media allowance without growing its queue or budget.
          const interval = Math.max(1000 / 60, bytes.length / 3800)
          const delay = Math.max(sharp ? 50 : 0, interval - (performance.now() - capture.last))
          if (delay <= 0) {
            clearTimeout(capture.timer)
            publish()
          } else capture.timer ??= setTimeout(publish, Math.ceil(delay))
        }
        capture.pause = async () => {
          capture.paused = true
          capture.releaseAcks?.()
          cdp.off('Page.screencastFrame', capture.onFrame)
          for (const timer of ['timer', 'retry', 'settle']) {
            clearTimeout(capture[timer])
            capture[timer] = undefined
          }
          capture.pending = undefined
          capture.bytes = undefined
          capture.liveBytes = undefined
          capture.sharpLiveBytes = undefined
          await cdp.send('Page.stopScreencast')
        }
        capture.resume = async (
          format = item.modernViewers.size === item.viewers.size ? 'png' : 'jpeg',
          quality = 90,
        ) => {
          if (item.capture !== capture || !item.viewers.size) return
          // The secondary CDP session needs the same CSS viewport and 2x density.
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            ...item.viewport,
            deviceScaleFactor: 2,
            mobile: false,
          })
          capture.liveFormat = format
          capture.liveQuality = quality
          capture.averageBytes = 0
          cdp.off('Page.screencastFrame', capture.onFrame)
          cdp.on('Page.screencastFrame', capture.onFrame)
          capture.paused = false
          await cdp.send('Page.startScreencast', {
            format,
            quality,
            maxWidth: item.viewport.width * 2,
            maxHeight: item.viewport.height * 2,
            everyNthFrame: 1,
          })
          settle(true)
        }
        capture.retune = retune
        item.capture = capture
        if (item.modernViewers.size)
          capture.stopAudio = await captureAudio(runtime, item, capture).catch(() => undefined)
        runtime.listeners.add(capture.broadcast)
        try {
          await capture.resume()
        } catch (error) {
          clearTimeout(capture.timer)
          clearTimeout(capture.retry)
          clearTimeout(capture.settle)
          runtime.listeners.delete(capture.broadcast)
          capture.paused = true
          capture.releaseAcks?.()
          cdp.off('Page.screencastFrame', capture.onFrame)
          item.capture = undefined
          await capture.stopAudio?.()
          await cdp.detach().catch(() => {})
          throw error
        }
      } else {
        if (item.modernViewers.size !== item.viewers.size && item.capture.liveFormat === 'png')
          item.capture.retune('jpeg', 90)
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
      void releaseInput(item)
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
