import type { ClientContext } from '@agnes/web-client'
import type { KeyboardEvent, PointerEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { BrowserPage } from './browser-client.js'

type Stream = Awaited<ReturnType<ClientContext['sessionStreams']['open']>>
type Result = Record<string, unknown>

/** One native, renewable lease for a visible panel. No website input is retried. */
export class BrowserInteraction {
  #stream: Stream | undefined
  #opening: Promise<void> | undefined
  #abort = new AbortController()
  #operationId = crypto.randomUUID()
  #grantedAt = 0
  #sequence = 0
  #dispatch = Promise.resolve()
  #queued = 0
  #nextSendAt = 0
  #timer?: ReturnType<typeof setTimeout>
  #pending = new Map<
    number,
    { resolve(value: Result): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  #lost = new Set<(pageId?: string) => void>()
  constructor(private ctx: ClientContext) {}
  prepare() {
    if (this.#opening) return this.#opening
    if (this.#stream) return Promise.resolve()
    this.#opening = this.#connect().finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }
  async #connect(renew = false) {
    this.#abort.signal.throwIfAborted()
    if (!this.#grantedAt || Date.now() - this.#grantedAt >= 270_000) {
      // A new authorization follows an explicit panel opening/gesture, never a timer.
      if (renew) throw new Error('Browser control expired. Click the page to reconnect.')
      this.#operationId = crypto.randomUUID()
      await this.ctx.agnes.services.effect('browser.connect', {}, { operationId: this.#operationId })
      this.#grantedAt = Date.now()
    }
    const next = await this.ctx.sessionStreams.open(
      'browser.interaction',
      {},
      {
        signal: this.#abort.signal,
        controlOperationId: this.#operationId,
      },
    )
    if (this.#abort.signal.aborted) {
      next.close('cancelled')
      return
    }
    const previous = this.#stream
    this.#stream = next
    next.onFrame((frame) => {
      if (this.#stream !== next || !frame || frame instanceof Uint8Array || typeof frame !== 'object') return
      const value = frame as Result
      if (value.type === 'controlLost') {
        for (const fn of this.#lost) fn(String(value.pageId))
        return
      }
      const entry = this.#pending.get(Number(value.id))
      if (!entry) return
      this.#pending.delete(Number(value.id))
      clearTimeout(entry.timer)
      if (value.status === 'ok') entry.resolve((value.result ?? {}) as Result)
      else entry.reject(Object.assign(new Error(String(value.code)), { code: value.code }))
    })
    next.onDisconnect(() => {
      if (this.#stream === next) this.#disconnect()
    })
    previous?.close('renewed')
    clearTimeout(this.#timer)
    const renewAfterDrain = () => {
      if (this.#abort.signal.aborted || this.#stream !== next) return
      // Do not discard acknowledgements while replacing a healthy connection.
      if (this.#pending.size || this.#queued) {
        this.#timer = setTimeout(renewAfterDrain, 100)
        return
      }
      this.#opening = this.#connect(true)
        .catch(() => this.#disconnect())
        .finally(() => {
          this.#opening = undefined
        })
    }
    this.#timer = setTimeout(renewAfterDrain, 22_000)
  }
  #disconnect() {
    clearTimeout(this.#timer)
    const previous = this.#stream
    this.#stream = undefined
    previous?.close('control-ended')
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(
        new Error('Connection lost; the action was not retried. Check the page before continuing.'),
      )
    }
    this.#pending.clear()
    for (const fn of this.#lost) fn()
  }
  async request(input: Result): Promise<Result> {
    await this.prepare()
    this.#abort.signal.throwIfAborted()
    if (this.#queued >= 64) throw new Error('Browser input queue is full. No input was replayed.')
    const stream = this.#stream
    this.#queued++
    const dispatch = this.#dispatch.then(async () => {
      const wait = Math.max(0, this.#nextSendAt - performance.now())
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
      this.#abort.signal.throwIfAborted()
      if (!stream || stream !== this.#stream)
        throw new Error('Browser input connection changed. No input was replayed.')
      // All callers share 30 control messages/second. 4 KiB is the per-frame
      // limit; the native byte rate is 120 KiB/second. Leave message headroom
      // without making a valid paste delay every following input for a second.
      this.#nextSendAt = performance.now() + 40
    })
    this.#dispatch = dispatch.catch(() => {})
    try {
      await dispatch
    } finally {
      this.#queued--
    }
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Action result unavailable. Check the page before continuing.'))
      }, 25_000)
      this.#pending.set(id, { resolve, reject, timer })
      if (this.#stream?.send({ ...input, id } as Parameters<Stream['send']>[0]) !== 'accepted') {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error('Input was not delivered. Reconnect before continuing.'))
      }
    })
  }
  onLost(fn: (pageId?: string) => void) {
    this.#lost.add(fn)
    return () => {
      this.#lost.delete(fn)
    }
  }
  close() {
    this.#abort.abort()
    this.#disconnect()
    this.#lost.clear()
  }
}

type Input = Record<string, string | number>

/** Keep native composition, macOS Option and Windows AltGr on the text path. */
export function isNativeTextKey(event: KeyboardEvent<HTMLTextAreaElement>) {
  return (
    event.key === 'Dead' ||
    event.key === 'Process' ||
    event.getModifierState('AltGraph') ||
    (navigator.platform.includes('Mac') &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.length === 1)
  )
}

export function forwardShortcut(event: KeyboardEvent<HTMLTextAreaElement>, send: (input: Input) => void) {
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
}

export function flushText(element: HTMLTextAreaElement, composing: boolean, send: (input: Input) => void) {
  if (composing) return
  const characters = Array.from(element.value)
  element.value = ''
  for (let i = 0; i < characters.length; i += 500)
    send({ type: 'text', text: characters.slice(i, i + 500).join('') })
}

/** Restore only local typing; an extra website click would collapse its selection. */
export function restoreDragFocus(
  event: PointerEvent<HTMLCanvasElement>,
  input: HTMLTextAreaElement | null,
  observed: BrowserPage | undefined,
  current: BrowserPage,
  ready: boolean,
  setPoint: (point: { x: number; y: number }) => void,
) {
  const active = document.activeElement
  if (
    !ready ||
    !input ||
    !observed ||
    observed.pageId !== current.pageId ||
    observed.pageEpoch !== current.pageEpoch ||
    observed.agentRevision !== current.agentRevision ||
    document.hidden ||
    !document.hasFocus() ||
    ![event.currentTarget, input, document.body].includes(active as HTMLElement) ||
    document.elementFromPoint(event.clientX, event.clientY) !== event.currentTarget
  )
    return
  const box = event.currentTarget.getBoundingClientRect()
  setPoint({ x: event.clientX - box.left, y: event.clientY - box.top })
  input.focus({ preventScroll: true })
}

/** Only adjacent gestures captured against the same pixels may be coalesced. */
export function mergeInput(tail: Input | undefined, input: Input): Input | undefined {
  if (
    !tail ||
    tail.pageEpoch !== input.pageEpoch ||
    tail.controlEpoch !== input.controlEpoch ||
    tail.agentRevision !== input.agentRevision
  )
    return
  if (
    tail.type === 'scroll' &&
    input.type === 'scroll' &&
    ['x', 'y'].every((key) => {
      const before = Number(tail[key]),
        after = Number(input[key])
      return before * after >= 0 && Math.abs(before + after) <= 4000
    })
  )
    return { ...input, x: Number(tail.x) + Number(input.x), y: Number(tail.y) + Number(input.y) }
  if (
    (input.type === 'hover' && tail.type === 'hover') ||
    (input.type === 'pointer' &&
      tail.type === 'pointer' &&
      input.phase === 'move' &&
      tail.phase === 'move' &&
      input.gesture === tail.gesture)
  )
    return input
  if (
    tail.type === 'text' &&
    input.type === 'text' &&
    typeof tail.text === 'string' &&
    typeof input.text === 'string' &&
    new TextEncoder().encode(JSON.stringify(tail.text + input.text)).length <= 3400
  )
    return { ...input, text: tail.text + input.text }
}

/** CSS coordinates only: device pixels, OS mouse APIs and file dialogs stay out. */
export function useBrowserPointer(options: {
  enabled: boolean
  pageId: string
  width: () => number
  height: () => number
  send(input: Input): void
  interact(input: Input): void
}) {
  const latest = useRef(options)
  latest.current = options
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; active: boolean }>()
  const suppressClick = useRef(false)
  const movedAt = useRef(0)
  const position = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect(),
      border = event.currentTarget.clientLeft
    return {
      x: Math.max(
        0,
        Math.min(
          options.width(),
          ((event.clientX - box.left - border) * options.width()) / (box.width - border * 2),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          options.height(),
          ((event.clientY - box.top - border) * options.height()) / (box.height - border * 2),
        ),
      ),
    }
  }
  const cancel = useCallback(() => {
    const current = drag.current
    drag.current = undefined
    if (current?.active) latest.current.send({ type: 'pointer', phase: 'cancel', gesture: current.id })
  }, [])
  useEffect(() => {
    if (!options.enabled || !options.pageId) cancel()
    const hidden = () => {
      if (document.hidden) cancel()
    }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      cancel()
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [options.pageId, options.enabled, cancel])
  return {
    onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
      if (!options.enabled || event.button !== 0 || !event.isPrimary) return
      suppressClick.current = false
      drag.current = { id: crypto.randomUUID(), pointer: event.pointerId, ...position(event), active: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return true
    },
    onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
      if (!options.enabled) return
      const point = position(event),
        current = drag.current
      if (current && current.pointer !== event.pointerId) return
      if (current && !current.active && Math.hypot(point.x - current.x, point.y - current.y) >= 4) {
        current.active = true
        suppressClick.current = true
        options.interact({ type: 'pointer', phase: 'down', gesture: current.id, x: current.x, y: current.y })
      }
      if (performance.now() - movedAt.current < 100) return
      movedAt.current = performance.now()
      if (current?.active) options.send({ type: 'pointer', phase: 'move', gesture: current.id, ...point })
      else if (!current) options.send({ type: 'hover', ...point })
    },
    onPointerUp(event: PointerEvent<HTMLCanvasElement>) {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId) return
      drag.current = undefined
      if (current.active)
        options.send({ type: 'pointer', phase: 'up', gesture: current.id, ...position(event) })
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId)
      // Only a completed drag restores local typing. Ordinary clicks retain
      // their existing path; cancelled/foreign pointers have no completion.
      return current.active ? current.id : undefined
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    consumeClick() {
      const value = suppressClick.current
      suppressClick.current = false
      return value
    },
  }
}
