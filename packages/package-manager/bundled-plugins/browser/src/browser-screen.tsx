import type { ClientContext } from '@agnes/web-client'
import { SettingsTextArea } from '@agnes/web-ui'
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { BrowserPage } from './browser-client.js'

type Stream = Awaited<ReturnType<ClientContext['sessionStreams']['open']>>
export type HumanControl = { operationId: string; pageId: string; controlEpoch: number }

/** Canvas pixels and input epochs always come from one decoded frame, never a second iframe. */
export type BrowserScreenHandle = {
  interact(input: Record<string, string | number>): void
}
export const BrowserScreen = forwardRef<
  BrowserScreenHandle,
  {
    ctx: ClientContext
    page: BrowserPage
    control?: HumanControl | undefined
    reconnect: number
    actualSize?: boolean
    t(key: string): string
    onError(message: string): void
    onRequestControl?(): Promise<HumanControl | undefined>
    onControlLost?(): void
  }
>(function BrowserScreen(
  { ctx, page, control, t, onError, onRequestControl, onControlLost, reconnect, actualSize },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  const meta = useRef<BrowserPage>(page)
  const target = useRef(page.pageId)
  target.current = page.pageId
  const selectTarget = useRef<() => void>()
  const stream = useRef<Stream>()
  const sequence = useRef(0)
  const composing = useRef(false)
  const requesting = useRef(false)
  const requestControl = useRef(onRequestControl)
  requestControl.current = onRequestControl
  const pendingInput = useRef<{
    input: Record<string, string | number>
    pageId: string
    pageEpoch: number
  }>()
  const [inputPoint, setInputPoint] = useState({ x: 0, y: 0 })
  const hintId = useId()
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(true)
  const [taking, setTaking] = useState(false)
  const [controlling, setControlling] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new tab invalidates displayed pixels and pending gestures.
  useEffect(() => {
    setConnected(false)
    setConnecting(true)
    pendingInput.current = undefined
    composing.current = false
    if (text.current) text.current.value = ''
    // Reset pixels immediately; old-page images must not remain interactive.
    if (canvas.current)
      canvas.current.getContext('2d')?.clearRect(0, 0, canvas.current.width, canvas.current.height)
    selectTarget.current?.()
  }, [page.pageId])
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
    const select = () => {
      if (!ready || abort.signal.aborted || selected === target.current) return
      selected = target.current
      const selection = ++revision
      void ctx.agnes.services
        .effect(
          'browser.view',
          { viewId, pageId: selected, sequence: selection },
          { operationId: crypto.randomUUID() },
        )
        .catch((error) => {
          if (abort.signal.aborted || selection !== revision) return
          setConnected(false)
          setConnecting(false)
          onError(String(error))
        })
    }
    selectTarget.current = select
    const paint = async () => {
      if (decoding) return
      decoding = true
      while (pending && !abort.signal.aborted) {
        const frame = pending
        pending = undefined
        try {
          const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/jpeg' }))
          try {
            if (
              abort.signal.aborted ||
              current !== frame.source ||
              frame.description.pageId !== target.current ||
              !canvas.current
            )
              continue
            // Keep one decoder and the newest pending frame. A slower decoder must
            // still paint, rather than discard every result when another frame arrives.
            if (canvas.current.width !== bitmap.width) canvas.current.width = bitmap.width
            if (canvas.current.height !== bitmap.height) canvas.current.height = bitmap.height
            canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0)
            meta.current = frame.description
            setConnected(true)
            setConnecting(false)
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
      pending = undefined
      ready = false
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
      return ctx.sessionStreams
        .open('browser.frames', { pageId: selected, viewId }, { signal: abort.signal })
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
            ready = true
            select()
            if (description.pageId !== target.current) return
            pending = { bytes: Uint8Array.from(frame.subarray(4 + size)), description, source: opened }
            void paint()
          })
        })
        .catch((error) => {
          if (!abort.signal.aborted) {
            onError(String(error))
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
  }, [ctx, reconnect, onError])

  useEffect(() => {
    sequence.current = 0
    if (!control || control.pageId !== page.pageId) {
      setControlling(false)
      pendingInput.current = undefined
      return
    }
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const connect = async () => {
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
            stream.current = undefined
            if (!abort.signal.aborted) {
              setControlling(false)
              onControlLost?.()
            }
          }
        })
        next.onFrame((frame) => {
          if (!frame || frame instanceof Uint8Array || typeof frame !== 'object') return
          if ('status' in frame && frame.status === 'error')
            onError(String('code' in frame ? frame.code : 'Input refused'))
          // Only a decoded image may advance the input target epoch. An acknowledgement
          // can arrive before the new document's pixels and must never relabel the old image.
        })
        timer = setTimeout(() => {
          void connect()
        }, 25_000)
      } catch (error) {
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
      clearTimeout(timer)
      const previous = stream.current
      stream.current = undefined
      previous?.close('control-ended')
    }
  }, [ctx, control, page.pageId, onError, onControlLost])

  const send = useCallback(
    (input: Record<string, string | number>) => {
      if (
        !connected ||
        !controlling ||
        !control ||
        meta.current.pageId !== control.pageId ||
        control.pageId !== target.current
      )
        return
      const accepted = stream.current?.send({
        ...input,
        seq: sequence.current++,
        pageEpoch: meta.current.pageEpoch,
        controlEpoch: control.controlEpoch,
      })
      if (accepted !== 'accepted') onError('Input was not delivered. Reconnect and inspect before retrying.')
    },
    [connected, controlling, control, onError],
  )
  const interact = useCallback(
    (input: Record<string, string | number>) => {
      if (!connected || meta.current.pageId !== target.current) return
      if (controlling) {
        send(input)
        if (input.type === 'click') text.current?.focus({ preventScroll: true })
        return
      }
      const request = requestControl.current
      if (control || requesting.current || !request) return
      requesting.current = true
      setTaking(true)
      pendingInput.current = { input, pageId: meta.current.pageId, pageEpoch: meta.current.pageEpoch }
      void request()
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
    if (pending.pageId !== target.current || pending.pageEpoch !== meta.current.pageEpoch) {
      onError(t('pageChanged'))
      return
    }
    send(pending.input)
    if (pending.input.type === 'click' || pending.input.type === 'key')
      text.current?.focus({ preventScroll: true })
  }, [connected, controlling, control, send, onError, t])
  useEffect(() => {
    const element = canvas.current
    if (!element || !connected) return
    let x = 0,
      y = 0,
      timer: ReturnType<typeof setTimeout> | undefined
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
      x = Math.max(-4000, Math.min(4000, x + deltaX))
      y = Math.max(-4000, Math.min(4000, y + deltaY))
      const pageEpoch = meta.current.pageEpoch
      timer ??= setTimeout(() => {
        // A batched wheel gesture still belongs to the document visible when it began.
        if (meta.current.pageEpoch === pageEpoch) send({ type: 'scroll', x, y })
        x = 0
        y = 0
        timer = undefined
      }, 50)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      clearTimeout(timer)
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
        aria-label={t('input')}
        aria-describedby={hintId}
        disabled={!controlling || !connected}
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
