import type { ClientContext } from '@agnes/web-client'
import { SettingsTextArea } from '@agnes/web-ui'
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { BrowserAudio } from './browser-audio.js'
import type { BrowserPage } from './browser-client.js'
import type { BrowserInteraction } from './browser-interaction.js'

type Stream = Awaited<ReturnType<ClientContext['sessionStreams']['open']>>
export type HumanControl = {
  operationId: string
  pageId: string
  controlEpoch: number
  channel?: BrowserInteraction
}

/** Canvas pixels and input epochs always come from one decoded frame, never a second iframe. */
export type BrowserScreenHandle = {
  interact(input: Record<string, string | number>): void
}
export const BrowserScreen = forwardRef<
  BrowserScreenHandle,
  {
    ctx: ClientContext
    interaction?: BrowserInteraction
    page: BrowserPage
    control?: HumanControl | undefined
    reconnect: number
    actualSize?: boolean
    fixedSize?: boolean
    t(key: string): string
    onError(message: string): void
    onRequestControl?(pageEpoch?: number): Promise<HumanControl | undefined>
    onControlLost?(): void
  }
>(function BrowserScreen(
  {
    ctx,
    interaction,
    page,
    control,
    t,
    onError,
    onRequestControl,
    onControlLost,
    reconnect,
    actualSize,
    fixedSize,
  },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const viewport = useRef({ width: 1280, height: 800 })
  const expectedViewport = useRef<{ width: number; height: number }>()
  const geometryPending = useRef(false)
  const [displayWidth, setDisplayWidth] = useState(page.viewportWidth ?? 1280)
  const [audio] = useState(() => new BrowserAudio())
  useEffect(() => () => audio.close(), [audio])
  const text = useRef<HTMLTextAreaElement>(null)
  const meta = useRef<BrowserPage>(page)
  const target = useRef(page.pageId)
  target.current = page.pageId
  const expectedEpoch = useRef(page.pageEpoch)
  const epochPage = useRef(page.pageId)
  expectedEpoch.current =
    epochPage.current === page.pageId ? Math.max(expectedEpoch.current, page.pageEpoch) : page.pageEpoch
  epochPage.current = page.pageId
  const selectTarget = useRef<(refresh?: boolean) => void>()
  const stream = useRef<Stream>()
  const enqueueInput = useRef<(input: Record<string, string | number>) => void>()
  const flushWheel = useRef<() => void>()
  const sequence = useRef(0)
  const composing = useRef(false)
  const requesting = useRef(false)
  const requestControl = useRef(onRequestControl)
  requestControl.current = onRequestControl
  const pendingInput = useRef<{
    input: Record<string, string | number>
    following: Record<string, string | number>[]
    pageId: string
    pageEpoch: number
    agentRevision?: number
  }>()
  const [inputPoint, setInputPoint] = useState({ x: 0, y: 0 })
  const hintId = useId()
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(true)
  const [taking, setTaking] = useState(false)
  const [controlling, setControlling] = useState(false)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = (initial = false) => {
      clearTimeout(timer)
      // The frame border is outside the actual CSS viewport. client dimensions
      // also exclude native scrollbars in fixed/actual-size mode.
      const box = { width: element.clientWidth, height: element.clientHeight }
      if (!fixedSize && (box.width < 1 || box.height < 1)) return
      const next = fixedSize
        ? { width: 1280, height: 800 }
        : {
            width: Math.max(240, Math.min(2560, Math.round(box.width))),
            height: Math.max(160, Math.min(1600, Math.round(box.height))),
          }
      const update = () => {
        if (viewport.current.width === next.width && viewport.current.height === next.height) return
        viewport.current = next
        pendingInput.current = undefined
        selectTarget.current?.(true)
      }
      if (initial) update()
      else timer = setTimeout(update, 120)
    }
    measure(true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => measure())
    observer?.observe(element)
    return () => {
      clearTimeout(timer)
      observer?.disconnect()
    }
  }, [fixedSize])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new tab invalidates displayed pixels and pending gestures.
  useEffect(() => {
    setConnected(false)
    setConnecting(true)
    audio.reset()
    pendingInput.current = undefined
    composing.current = false
    if (text.current) text.current.value = ''
    // Reset pixels immediately; old-page images must not remain interactive.
    if (canvas.current)
      canvas.current.getContext('2d')?.clearRect(0, 0, canvas.current.width, canvas.current.height)
    selectTarget.current?.()
  }, [page.pageId, audio])
  useEffect(() => {
    if (meta.current.pageId !== page.pageId || meta.current.pageEpoch >= page.pageEpoch) return
    audio.reset()
    // History restores can stop the existing CDP capture. Rebind through the same
    // admitted view stream, and keep old pixels non-interactive until the new image.
    setConnected(false)
    setConnecting(true)
    selectTarget.current?.(true)
  }, [page.pageId, page.pageEpoch, audio])
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect explicitly requests a new display subscription.
  useEffect(() => {
    const abort = new AbortController()
    let current: Stream | undefined
    let pending: { bytes: Uint8Array<ArrayBuffer>; description: BrowserPage; source: Stream } | undefined
    let decoding = false
    let timer: ReturnType<typeof setTimeout>
    let attempts = 0
    let viewId = '',
      selected = '',
      revision = 0,
      ready = false
    let selecting = false,
      refresh = false,
      awaitingGeometry = false
    const select = (renew = false) => {
      refresh ||= renew
      if (!ready || abort.signal.aborted || (selected === target.current && !refresh) || selecting) return
      refresh = false
      selected = target.current
      const selection = ++revision
      const source = current
      selecting = true
      const requestedViewport = { ...viewport.current }
      expectedViewport.current = requestedViewport
      geometryPending.current = true
      awaitingGeometry = true
      setConnected(false)
      void (
        interaction
          ? interaction.request({
              type: 'view',
              viewId,
              pageId: selected,
              sequence: selection,
              viewport: requestedViewport,
            })
          : ctx.agnes.services.effect(
              'browser.view',
              { viewId, pageId: selected, sequence: selection, viewport: requestedViewport },
              { operationId: crypto.randomUUID() },
            )
      )
        .then((reply) => {
          if (abort.signal.aborted || selection !== revision || current !== source) return
          const result = ((reply as { result?: unknown }).result ?? reply) as BrowserPage
          if (Number.isSafeInteger(result.viewportWidth) && Number.isSafeInteger(result.viewportHeight)) {
            // A second viewer follows the owning view's geometry instead of fighting it.
            expectedViewport.current = { width: result.viewportWidth!, height: result.viewportHeight! }
            expectedEpoch.current = Math.max(expectedEpoch.current, result.pageEpoch)
          }
          awaitingGeometry = false
          void paint()
        })
        .catch((error) => {
          if (abort.signal.aborted || selection !== revision || current !== source) return
          setConnected(false)
          setConnecting(false)
          // Closing the selected tab can retire its view before the page list
          // switches targets. Recover that read-only view before surfacing an error.
          if (attempts >= 4) onError(String(error))
          // A failed selection must not leave `selected` pointing at an unseen page
          // forever. Reopen only the read-only display; never replay website input.
          const failed = current
          current = undefined
          failed?.close('view-selection-failed')
          retry()
        })
        .finally(() => {
          selecting = false
          select()
        })
    }
    selectTarget.current = select
    const paint = async () => {
      if (decoding) return
      decoding = true
      while (pending && !abort.signal.aborted && !awaitingGeometry) {
        const frame = pending
        pending = undefined
        try {
          const bitmap = await createImageBitmap(
            new Blob([frame.bytes], { type: frame.description.frameMime ?? 'image/jpeg' }),
          )
          try {
            const width = frame.description.viewportWidth ?? 1280
            const height = frame.description.viewportHeight ?? 800
            // Reject an old compositor surface; tolerate one pixel of raster rounding.
            if (Math.abs(bitmap.width * height - bitmap.height * width) > width + height) continue
            if (
              abort.signal.aborted ||
              awaitingGeometry ||
              current !== frame.source ||
              frame.description.pageId !== target.current ||
              frame.description.pageEpoch < expectedEpoch.current ||
              (expectedViewport.current &&
                ((frame.description.viewportWidth ?? 1280) !== expectedViewport.current.width ||
                  (frame.description.viewportHeight ?? 800) !== expectedViewport.current.height)) ||
              !canvas.current
            )
              continue
            // Keep one decoder and the newest pending frame. A slower decoder must
            // still paint, rather than discard every result when another frame arrives.
            if (canvas.current.width !== bitmap.width) canvas.current.width = bitmap.width
            if (canvas.current.height !== bitmap.height) canvas.current.height = bitmap.height
            canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0)
            meta.current = frame.description
            expectedEpoch.current = Math.max(expectedEpoch.current, frame.description.pageEpoch)
            setDisplayWidth(frame.description.viewportWidth ?? 1280)
            geometryPending.current = false
            setConnected(true)
            attempts = 0
          } finally {
            bitmap.close()
          }
        } catch {
          if (!abort.signal.aborted && current === frame.source) {
            setConnected(false)
            setConnecting(false)
          }
        }
      }
      decoding = false
    }
    const retry = () => {
      if (abort.signal.aborted) return
      audio.reset()
      pending = undefined
      ready = false
      awaitingGeometry = false
      geometryPending.current = true
      current = undefined
      setConnected(false)
      setConnecting(false)
      if (attempts < 4) {
        // Preserve native admission limits. One final read-only retry waits out
        // the minute window instead of leaving the display permanently offline.
        const delay = attempts < 3 ? 1000 * 2 ** attempts : 60_000
        attempts++
        timer = setTimeout(() => {
          void open()
        }, delay)
      }
    }
    setConnected(false)
    const open = () => {
      setConnecting(true)
      viewId = crypto.randomUUID()
      selected = target.current
      revision = 0
      ready = false
      expectedViewport.current = { ...viewport.current }
      geometryPending.current = true
      return ctx.sessionStreams
        .open(
          'browser.frames',
          { pageId: selected, viewId, displayVersion: 2, viewport: viewport.current },
          { signal: abort.signal },
        )
        .then((opened) => {
          if (abort.signal.aborted) {
            opened.close('cancelled')
            return
          }
          current = opened
          opened.onDisconnect(() => {
            if (current === opened) retry()
          })
          opened.onFrame((frame) => {
            if (abort.signal.aborted || current !== opened) return
            if (!(frame instanceof Uint8Array) || frame.byteLength < 5) return
            const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0)
            if (size > 4096 || size + 4 >= frame.length) return
            let description: BrowserPage
            try {
              description = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + size))) as BrowserPage
              if (
                !Number.isSafeInteger(description.pageEpoch) ||
                !Number.isSafeInteger(description.controlEpoch)
              )
                return
            } catch {
              setConnected(false)
              return
            }
            // The first image confirms that the plugin registered this view.
            // A tab may have changed while the transport was opening.
            if (description.media === 'audio') {
              if (
                description.pageId === target.current &&
                meta.current.pageId === target.current &&
                description.pageEpoch >= expectedEpoch.current &&
                description.pageEpoch === meta.current.pageEpoch
              )
                audio.push(frame.subarray(4 + size), description.sampleRate ?? 0)
              return
            }
            if (!ready && description.pageId === selected)
              expectedViewport.current = {
                width: description.viewportWidth ?? 1280,
                height: description.viewportHeight ?? 800,
              }
            ready = true
            select()
            if (description.pageId !== target.current) return
            pending = { bytes: Uint8Array.from(frame.subarray(4 + size)), description, source: opened }
            if (!awaitingGeometry) void paint()
          })
        })
        .catch((error) => {
          if (!abort.signal.aborted) {
            if (attempts >= 4) onError(String(error))
            retry()
          }
        })
    }
    void open()
    return () => {
      abort.abort()
      selectTarget.current = undefined
      clearTimeout(timer)
      pending = undefined
      current?.close('view-closed')
    }
  }, [ctx, interaction, reconnect, onError, audio])

  useEffect(() => {
    sequence.current = 0
    if (!control || control.pageId !== page.pageId) {
      setControlling(false)
      pendingInput.current = undefined
      return
    }
    const abort = new AbortController()
    const queued: Record<string, string | number>[] = []
    let waiting: Record<string, string | number> | undefined
    let receipt: ReturnType<typeof setTimeout> | undefined
    let renewing = false
    const discard = () => {
      queued.length = 0
      waiting = undefined
      clearTimeout(receipt)
    }
    const complete = (seq: unknown, error?: string) => {
      if (abort.signal.aborted || !waiting || waiting.seq !== seq) return
      waiting = undefined
      clearTimeout(receipt)
      if (error) {
        queued.length = 0
        onError(error)
      } else pump()
    }
    const pump = () => {
      if (abort.signal.aborted || renewing || waiting || !stream.current) return
      const next = queued.shift()
      if (!next) return
      // Keep the captured target; never rebase queued gestures onto newer pixels.
      if (
        geometryPending.current ||
        target.current !== control.pageId ||
        next.pageEpoch !== meta.current.pageEpoch ||
        next.agentRevision !== meta.current.agentRevision
      ) {
        queued.length = 0
        return
      }
      waiting = next
      receipt = setTimeout(
        () => complete(next.seq, 'Input result unavailable. Inspect before retrying.'),
        25_000,
      )
      if (stream.current.send(next as Parameters<Stream['send']>[0]) !== 'accepted')
        complete(next.seq, 'Input was not delivered. Reconnect and inspect before retrying.')
    }
    const enqueue = (input: Record<string, string | number>) => {
      const tail = queued.at(-1)
      if (
        tail?.type === 'scroll' &&
        input.type === 'scroll' &&
        tail.pageEpoch === input.pageEpoch &&
        tail.controlEpoch === input.controlEpoch &&
        tail.agentRevision === input.agentRevision &&
        ['x', 'y'].every((key) => {
          const before = Number(tail[key]),
            after = Number(input[key])
          return before * after >= 0 && Math.abs(before + after) <= 4000
        })
      ) {
        input = { ...input, x: Number(tail.x) + Number(input.x), y: Number(tail.y) + Number(input.y) }
        queued.pop()
      } else if (
        tail?.type === 'text' &&
        input.type === 'text' &&
        tail.pageEpoch === input.pageEpoch &&
        tail.controlEpoch === input.controlEpoch &&
        tail.agentRevision === input.agentRevision &&
        typeof tail.text === 'string' &&
        typeof input.text === 'string' &&
        new TextEncoder().encode(JSON.stringify(tail.text + input.text)).length <= 3400
      ) {
        input = { ...input, text: tail.text + input.text }
        queued.pop()
      }
      if (queued.length >= 64) {
        queued.length = 0
        onError('Input queue is full. Buffered input was discarded; please retry.')
        return
      }
      queued.push(input)
      pump()
    }
    enqueueInput.current = enqueue
    if (control.channel) {
      const channel = control.channel
      const off = channel.onLost((pageId) => {
        if (!pageId || pageId === control.pageId) {
          discard()
          if (enqueueInput.current === enqueue) enqueueInput.current = undefined
          setControlling(false)
          onControlLost?.()
        }
      })
      stream.current = {
        send(input) {
          void channel.request({ type: 'input', pageId: control.pageId, input }).then(
            () => complete((input as { seq: number }).seq),
            (error) => complete((input as { seq: number }).seq, String(error)),
          )
          return 'accepted'
        },
      } as Stream
      setControlling(true)
      return () => {
        abort.abort()
        discard()
        if (enqueueInput.current === enqueue) enqueueInput.current = undefined
        off()
        stream.current = undefined
        void channel
          .request({ type: 'pause', pageId: control.pageId, controlEpoch: control.controlEpoch })
          .catch(() => {})
      }
    }
    let timer: ReturnType<typeof setTimeout>
    const connect = async () => {
      renewing = true
      try {
        const next = await ctx.sessionStreams.open(
          'browser.input',
          { pageId: control.pageId, mode: 'human' },
          { signal: abort.signal, controlOperationId: control.operationId },
        )
        if (abort.signal.aborted) {
          next.close('cancelled')
          return
        }
        const previous = stream.current
        stream.current = next
        previous?.close('renewed')
        setControlling(true)
        next.onDisconnect(() => {
          if (stream.current === next) {
            discard()
            stream.current = undefined
            if (!abort.signal.aborted) {
              setControlling(false)
              onControlLost?.()
            }
          }
        })
        next.onFrame((frame) => {
          if (!frame || frame instanceof Uint8Array || typeof frame !== 'object') return
          if ('status' in frame && (frame.status === 'ok' || frame.status === 'error'))
            complete(
              'seq' in frame ? frame.seq : undefined,
              frame.status === 'error' ? String('code' in frame ? frame.code : 'Input refused') : undefined,
            )
          // Only a decoded image may advance the input target epoch. An acknowledgement
          // can arrive before the new document's pixels and must never relabel the old image.
        })
        renewing = false
        pump()
        const renew = () => {
          if (waiting) {
            timer = setTimeout(renew, 100)
            return
          }
          void connect()
        }
        timer = setTimeout(renew, 25_000)
      } catch (error) {
        discard()
        if (!abort.signal.aborted) {
          setControlling(false)
          onError(String(error))
          onControlLost?.()
        }
      }
    }
    void connect()
    return () => {
      abort.abort()
      discard()
      if (enqueueInput.current === enqueue) enqueueInput.current = undefined
      clearTimeout(timer)
      const previous = stream.current
      stream.current = undefined
      previous?.close('control-ended')
    }
  }, [ctx, control, page.pageId, onError, onControlLost])

  const send = useCallback(
    (input: Record<string, string | number>) => {
      if (input.type !== 'scroll') flushWheel.current?.()
      const pending = pendingInput.current
      if (!controlling && pending) {
        if (connected && pending.pageId === target.current && pending.pageEpoch === meta.current.pageEpoch) {
          if (pending.following.length < 32) pending.following.push(input)
          else {
            pendingInput.current = undefined
            onError('Input connection is not ready. Buffered input was discarded; please retry.')
          }
        }
        return
      }
      if (
        !connected ||
        geometryPending.current ||
        !controlling ||
        !control ||
        meta.current.pageId !== control.pageId ||
        control.pageId !== target.current
      )
        return
      enqueueInput.current?.({
        ...input,
        seq: sequence.current++,
        pageEpoch: meta.current.pageEpoch,
        controlEpoch: control.controlEpoch,
        ...(meta.current.agentRevision === undefined ? {} : { agentRevision: meta.current.agentRevision }),
      })
    },
    [connected, controlling, control, onError],
  )
  const interact = useCallback(
    (input: Record<string, string | number>) => {
      if (!connected || geometryPending.current || meta.current.pageId !== target.current) return
      if (controlling) {
        send(input)
        if (input.type === 'click') text.current?.focus({ preventScroll: true })
        return
      }
      const request = requestControl.current
      if (control || requesting.current || !request) return
      requesting.current = true
      setTaking(true)
      pendingInput.current = {
        input,
        following: [],
        pageId: meta.current.pageId,
        pageEpoch: meta.current.pageEpoch,
        ...(meta.current.agentRevision === undefined ? {} : { agentRevision: meta.current.agentRevision }),
      }
      // Focus the local IME target immediately; native admission can finish after
      // the user has already started typing. Nothing is sent before it succeeds.
      if (input.type === 'click' || input.type === 'key') text.current?.focus({ preventScroll: true })
      void request(meta.current.pageEpoch)
        .then((granted) => {
          if (!granted) pendingInput.current = undefined
        })
        .catch((error) => {
          pendingInput.current = undefined
          onError(String(error))
        })
        .finally(() => {
          requesting.current = false
          setTaking(false)
        })
    },
    [connected, controlling, control, onError, send],
  )
  useImperativeHandle(ref, () => ({ interact }))
  useEffect(() => {
    if (!connected || !controlling || !control) return
    const pending = pendingInput.current
    if (!pending) return
    pendingInput.current = undefined
    // A handover must never apply the original click to a newly navigated document.
    if (
      pending.pageId !== target.current ||
      pending.pageEpoch !== meta.current.pageEpoch ||
      pending.agentRevision !== meta.current.agentRevision
    ) {
      onError(t('pageChanged'))
      return
    }
    send(pending.input)
    for (const input of pending.following) send(input)
    if (pending.input.type === 'click' || pending.input.type === 'key')
      text.current?.focus({ preventScroll: true })
  }, [connected, controlling, control, send, onError, t])
  useEffect(() => {
    const element = canvas.current
    if (!element || !connected) return
    let x = 0,
      y = 0,
      observed: BrowserPage | undefined,
      timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      clearTimeout(timer)
      const previous = observed,
        input = { type: 'scroll', x, y }
      x = y = 0
      timer = undefined
      observed = undefined
      // A batch belongs to the pixels visible at its first event.
      if (
        previous &&
        meta.current.pageId === previous.pageId &&
        meta.current.pageEpoch === previous.pageEpoch &&
        meta.current.agentRevision === previous.agentRevision
      )
        send(input)
    }
    flushWheel.current = flush
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const unitX =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (meta.current.viewportWidth ?? 1280) : 1
      const unitY =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (meta.current.viewportHeight ?? 800) : 1
      const deltaX = Math.max(-4000, Math.min(4000, event.deltaX * unitX))
      const deltaY = Math.max(-4000, Math.min(4000, event.deltaY * unitY))
      if (!controlling) {
        interact({
          type: 'scroll',
          x: deltaX,
          y: deltaY,
        })
        return
      }
      if (x * deltaX < 0 || y * deltaY < 0 || Math.abs(x + deltaX) > 4000 || Math.abs(y + deltaY) > 4000)
        flush()
      observed ??= meta.current
      x += deltaX
      y += deltaY
      timer ??= setTimeout(flush, 8) // Receipts bound the processing queue.
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      clearTimeout(timer)
      if (flushWheel.current === flush) flushWheel.current = undefined
      element.removeEventListener('wheel', wheel)
    }
  }, [connected, controlling, send, interact])
  const flushText = (element: HTMLTextAreaElement) => {
    if (composing.current) return
    const characters = Array.from(element.value)
    element.value = ''
    for (let i = 0; i < characters.length; i += 500)
      send({ type: 'text', text: characters.slice(i, i + 500).join('') })
  }
  return (
    <div
      className="agh-browser-screen"
      ref={container}
      data-controlling={controlling}
      data-scale={actualSize ? 'actual' : 'fit'}
    >
      <span
        className="agh-browser-connection"
        role="status"
        data-connected={connected && !taking && (!control || controlling)}
      >
        {t(
          !connected
            ? connecting
              ? 'connecting'
              : 'disconnected'
            : taking
              ? 'requestingControl'
              : control && !controlling
                ? 'connectingInput'
                : 'connected',
        )}
      </span>
      <span id={hintId} className="agh-browser-sr-only">
        {t('inputHint')}
      </span>
      <canvas
        ref={canvas}
        role="img"
        width={1280}
        height={800}
        style={actualSize ? { width: displayWidth } : undefined}
        aria-label={t('screen')}
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (controlling) text.current?.focus({ preventScroll: true })
          else interact({ type: 'key', key: 'Tab' })
        }}
        onClick={(event) => {
          if (!connected) return
          audio.resume()
          const box = event.currentTarget.getBoundingClientRect()
          const border = event.currentTarget.clientLeft
          const width = meta.current.viewportWidth ?? 1280
          const height = meta.current.viewportHeight ?? 800
          const x = ((event.clientX - box.left - border) * width) / (box.width - border * 2)
          const y = ((event.clientY - box.top - border) * height) / (box.height - border * 2)
          setInputPoint({
            x: Math.max(0, event.clientX - box.left),
            y: Math.max(0, event.clientY - box.top),
          })
          interact({ type: 'click', x, y })
        }}
      />
      <SettingsTextArea
        ref={text}
        className="agh-browser-input"
        style={{ left: inputPoint.x, top: inputPoint.y }}
        rows={1}
        tabIndex={-1}
        aria-label={t('input')}
        aria-describedby={hintId}
        disabled={!connected}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          flushText(event.currentTarget)
        }}
        onInput={(event) => flushText(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current) return
          audio.resume()
          // Keep native composition and layout-specific text on the input path.
          // macOS Option characters and Windows AltGr are not remote shortcuts.
          if (
            event.key === 'Dead' ||
            event.key === 'Process' ||
            event.getModifierState('AltGraph') ||
            (navigator.platform.includes('Mac') &&
              event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              event.key.length === 1)
          )
            return
          if (event.key === 'Escape') {
            event.preventDefault()
            send({ type: 'key', key: 'Escape' })
            event.currentTarget
              .closest('section')
              ?.querySelector<HTMLButtonElement>('[data-browser-control]')
              ?.focus()
            return
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
          if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 1) {
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
            event.preventDefault()
            // Resolve the user's primary shortcut on the backend OS too: WebUI may
            // be on a Mac while Chromium runs on Windows, or the other way round.
            const mac = navigator.platform.includes('Mac')
            const prefix = [
              event.ctrlKey && (mac ? 'Control' : 'ControlOrMeta'),
              event.metaKey && (mac ? 'ControlOrMeta' : 'Meta'),
              event.altKey && 'Alt',
              event.shiftKey && 'Shift',
            ].filter(Boolean)
            send({ type: 'key', key: [...prefix, event.key === ' ' ? 'Space' : event.key].join('+') })
          }
        }}
      />
    </div>
  )
})
