/** @vitest-environment happy-dom */
import type { ClientContext } from '@agnes/web-client'
import { type ComponentProps, createElement, createRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BrowserAudio } from '../../package-manager/bundled-plugins/browser/src/browser-audio.js'
import {
  BrowserScreen,
  type BrowserScreenHandle,
} from '../../package-manager/bundled-plugins/browser/src/browser-screen.js'

vi.mock('@agnes/web-ui', async () => {
  const { createElement, forwardRef } = await import('react')
  return {
    SettingsTextArea: forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>((props, ref) =>
      createElement('textarea', { ...props, ref }),
    ),
  }
})

it('switches tabs on one display connection and refuses late pixels from the previous tab', async () => {
  let receive: (frame: unknown) => void = () => {}
  const effect = vi.fn(async (_name: string, _input: unknown, _options: unknown) => ({ status: 'ok' }))
  const close = vi.fn()
  const open = vi.fn(async () => ({
    close,
    onDisconnect() {},
    onFrame(fn: (frame: unknown) => void) {
      receive = fn
    },
  }))
  const ctx = { sessionStreams: { open }, agnes: { services: { effect } } } as unknown as ClientContext
  const draw = vi.fn()
  const sound = vi.spyOn(BrowserAudio.prototype, 'push').mockImplementation(() => {})
  let finish: ((value: unknown) => void) | undefined
  const bitmap = { width: 2560, height: 1600, close() {} }
  const decode = vi.fn(async (_blob: Blob) => bitmap)
  vi.stubGlobal('createImageBitmap', decode)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
    clearRect() {},
  } as unknown as CanvasRenderingContext2D)
  const host = document.createElement('div')
  const root = createRoot(host)
  const page = {
    pageId: 'one',
    url: 'http://localhost/',
    pageEpoch: 0,
    controlEpoch: 0,
    mode: 'agent' as const,
  }
  const onError = vi.fn()
  const render = (pageId: string, pageEpoch = 0) =>
    flushSync(() =>
      root.render(
        createElement(BrowserScreen, {
          ctx,
          page: { ...page, pageId, pageEpoch },
          reconnect: 0,
          t: (key) => key,
          onError,
        }),
      ),
    )
  const pixels = (pageId: string, pageEpoch = 0, media?: string) => {
    const metadata = new TextEncoder().encode(
      JSON.stringify({ ...page, pageId, pageEpoch, frameMime: 'image/png', media, sampleRate: 48000 }),
    )
    const frame = new Uint8Array(metadata.length + 5)
    new DataView(frame.buffer).setUint32(0, metadata.length)
    frame.set(metadata, 4)
    receive(frame)
  }
  try {
    render('one')
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    decode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as (value: unknown) => void
        }),
    )
    pixels('one')
    render('two')
    await vi.waitFor(() =>
      expect(effect).toHaveBeenCalledWith(
        'browser.view',
        expect.objectContaining({ pageId: 'two', sequence: 1 }),
        expect.anything(),
      ),
    )
    finish?.(bitmap)
    await Promise.resolve()
    pixels('two', 0, 'audio')
    expect(sound).not.toHaveBeenCalled()
    expect(decode.mock.calls[0]?.[0].type).toBe('image/png')
    expect(draw).not.toHaveBeenCalled()
    pixels('one')
    expect(draw).not.toHaveBeenCalled()
    pixels('two')
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
    expect(host.querySelector('canvas')?.width).toBe(2560)
    pixels('two', 0, 'audio')
    expect(sound).toHaveBeenCalledTimes(1)
    // The same page can restore a different document without producing new CDP paints.
    const priorCall = effect.mock.lastCall
    if (!priorCall) throw new Error('Missing initial view selection')
    const priorSelection = (priorCall[1] as { sequence: number }).sequence
    render('two', 1)
    pixels('two', 0, 'audio')
    expect(sound).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(effect.mock.lastCall?.[1]).toMatchObject({ pageId: 'two', sequence: priorSelection + 1 }),
    )
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).toBeNull())
    draw.mockClear()
    pixels('two', 0)
    await new Promise((done) => setTimeout(done, 0))
    expect(draw).not.toHaveBeenCalled()
    pixels('two', 1)
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
    for (let index = 0; index < 12; index++) render(index % 2 ? 'two' : 'one')
    expect(open).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(effect.mock.lastCall?.[1]).toMatchObject({ pageId: 'two' }))
    pixels('two')
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
    expect(onError).not.toHaveBeenCalled()
    flushSync(() => root.unmount())
    expect(close).toHaveBeenCalled()
  } finally {
    flushSync(() => root.unmount())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('adapts the real viewport, coalesces resizing and accepts clicks only on matching sharp frames', async () => {
  let size = { width: 540, height: 920 },
    raster = size,
    epoch = 0
  let resize = () => {},
    receive = (_frame: unknown) => {}
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, size.width, size.height),
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    clearRect() {},
  } as unknown as CanvasRenderingContext2D)
  const decode = vi.fn(async () => ({
    width: raster.width * 2,
    height: raster.height * 2,
    close() {},
  }))
  vi.stubGlobal('createImageBitmap', decode)
  const request = vi.fn(async (input: Record<string, any>) => {
    if (input.type === 'view')
      return {
        viewportWidth: input.viewport.width,
        viewportHeight: input.viewport.height,
        pageEpoch: ++epoch,
      }
    return {}
  })
  const interaction = { request, onLost: () => () => {} } as unknown as NonNullable<
    ComponentProps<typeof BrowserScreen>['interaction']
  >
  const open = vi.fn(async () => ({
    close() {},
    onDisconnect() {},
    onFrame(callback: typeof receive) {
      receive = callback
    },
  }))
  const ctx = { sessionStreams: { open } } as unknown as ClientContext
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const page = {
    pageId: 'adaptive',
    url: 'http://localhost/',
    pageEpoch: 0,
    controlEpoch: 1,
    mode: 'human' as const,
  }
  const control = { pageId: page.pageId, controlEpoch: 1, operationId: '', channel: interaction }
  const onError = vi.fn()
  const render = (fixedSize = false) =>
    flushSync(() =>
      root.render(
        createElement(BrowserScreen, {
          ctx,
          interaction,
          page,
          fixedSize,
          reconnect: 0,
          control,
          t: (key) => key,
          onError,
        }),
      ),
    )
  const pixels = (width: number, height: number, pageEpoch = epoch) => {
    raster = { width, height }
    const metadata = new TextEncoder().encode(
      JSON.stringify({
        ...page,
        pageEpoch,
        viewportWidth: width,
        viewportHeight: height,
        frameMime: 'image/png',
      }),
    )
    const frame = new Uint8Array(metadata.length + 5)
    new DataView(frame.buffer).setUint32(0, metadata.length)
    frame.set(metadata, 4)
    receive(frame)
  }
  try {
    render()
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'browser.frames',
        expect.objectContaining({ viewport: size }),
        expect.anything(),
      ),
    )
    pixels(540, 920)
    await vi.waitFor(() => expect(host.querySelector('textarea')?.disabled).toBe(false))
    const canvas = host.querySelector('canvas')!
    expect(canvas.width).toBe(1080)
    decode.mockResolvedValueOnce({ width: 1080, height: 200, close() {} })
    pixels(540, 920)
    await new Promise((done) => setTimeout(done, 0))
    expect(canvas.height).toBe(1840)
    const inset = vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(11, 11, 540, 920))
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 281, clientY: 471 }))
    await vi.waitFor(() =>
      expect(request.mock.lastCall?.[0]).toMatchObject({
        type: 'input',
        input: { x: 270, y: 460, pageEpoch: 0 },
      }),
    )
    inset.mockImplementation(() => new DOMRect(0, 0, size.width, size.height))
    size = { width: 600, height: 1000 }
    resize()
    size = { width: 650, height: 1100 }
    resize()
    await vi.waitFor(() => expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'view', viewport: size }))
    const before = request.mock.calls.length
    pixels(540, 920, 0)
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 325, clientY: 550 }))
    expect(request.mock.calls).toHaveLength(before)
    pixels(650, 1100)
    await vi.waitFor(() => expect(host.querySelector('textarea')?.disabled).toBe(false))
    expect(canvas.width).toBe(1300)
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 325, clientY: 550 }))
    await vi.waitFor(() =>
      expect(request.mock.lastCall?.[0]).toMatchObject({
        type: 'input',
        input: { x: 325, y: 550, pageEpoch: 1 },
      }),
    )
    size = { width: 0, height: 0 }
    resize()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(request.mock.calls).toHaveLength(before + 1)
    size = { width: 650, height: 1100 }
    render(true)
    await vi.waitFor(() =>
      expect(request.mock.lastCall?.[0]).toMatchObject({
        type: 'view',
        viewport: { width: 1280, height: 800 },
      }),
    )
    pixels(1280, 800)
    await vi.waitFor(() => expect(host.querySelector('textarea')?.disabled).toBe(false))
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 325, clientY: 550 }))
    await vi.waitFor(() =>
      expect(request.mock.lastCall?.[0]).toMatchObject({
        type: 'input',
        input: { x: 640, y: 400, pageEpoch: 2 },
      }),
    )
    render(false)
    await vi.waitFor(() => expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'view', viewport: size }))
    // Another window may own geometry; keep early pixels until its acknowledgement.
    let acknowledge!: (value: Record<string, number>) => void
    request.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    )
    size = { width: 600, height: 900 }
    resize()
    await vi.waitFor(() => expect(acknowledge).toBeDefined())
    pixels(1280, 800, 4)
    expect(host.querySelector('textarea')?.disabled).toBe(true)
    acknowledge({ viewportWidth: 1280, viewportHeight: 800, pageEpoch: 4 })
    await vi.waitFor(() => expect(host.querySelector('textarea')?.disabled).toBe(false))
    pixels(1280, 800, 2)
    host
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() =>
      expect(request.mock.lastCall?.[0]).toMatchObject({
        type: 'input',
        input: { pageEpoch: 4, type: 'key' },
      }),
    )
    expect(open).toHaveBeenCalledTimes(1)
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    expect(disconnect).toHaveBeenCalled()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('keeps input bound to displayed pixels when navigation acknowledgement precedes the new image', async () => {
  const callbacks = new Map<string, (value: unknown) => void>()
  const send = vi.fn((frame: unknown) => {
    callbacks.get('browser.input')?.({ status: 'ok', seq: (frame as { seq: number }).seq })
    return 'accepted'
  })
  const draw = vi.fn()
  const ctx = {
    sessionStreams: {
      open: async (name: string) => ({
        send,
        close() {},
        onDisconnect() {},
        onFrame(fn: (value: unknown) => void) {
          callbacks.set(name, fn)
        },
      }),
    },
  } as unknown as ClientContext
  vi.stubGlobal('createImageBitmap', async () => ({ width: 2560, height: 1600, close() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
    clearRect() {},
  } as unknown as CanvasRenderingContext2D)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const page = {
    pageId: 'page-one',
    url: 'http://localhost:5173/',
    pageEpoch: 0,
    controlEpoch: 7,
    mode: 'human' as const,
    pointerInput: true,
  }
  const pixels = (pageEpoch: number) => {
    const metadata = new TextEncoder().encode(JSON.stringify({ ...page, pageEpoch }))
    const frame = new Uint8Array(metadata.length + 5)
    new DataView(frame.buffer).setUint32(0, metadata.length)
    frame.set(metadata, 4)
    callbacks.get('browser.frames')?.(frame)
  }
  try {
    flushSync(() =>
      root.render(
        createElement(BrowserScreen, {
          ctx,
          page,
          reconnect: 0,
          control: { pageId: page.pageId, controlEpoch: 7, operationId: 'takeover' },
          t: (key) => key,
          onError: vi.fn(),
        }),
      ),
    )
    await vi.waitFor(() => expect(callbacks.has('browser.input')).toBe(true))
    pixels(0)
    await vi.waitFor(() => expect(host.querySelector('textarea')?.disabled).toBe(false))
    const canvas = host.querySelector('canvas')
    if (!canvas) throw new Error('Missing browser canvas')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800))
    callbacks.get('browser.input')?.({ status: 'ok', pageId: page.pageId, pageEpoch: 1, controlEpoch: 7 })
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }))
    expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'click', pageEpoch: 0, x: 20, y: 20 })
    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120, cancelable: true }))
    pixels(1)
    await vi.waitFor(() => expect(draw).toHaveBeenCalledTimes(2))
    await new Promise((done) => setTimeout(done, 150))
    expect(send.mock.calls.some(([input]) => (input as { type: string }).type === 'scroll')).toBe(false)
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }))
    expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'click', pageEpoch: 1 })
    const input = host.querySelector('textarea')!
    expect(document.activeElement).toBe(input)
    expect(input.classList.contains('agh-browser-input')).toBe(true)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.value = '中文输入'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'click' })
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文输入' }))
    expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'text', text: '中文输入', pageEpoch: 1 })
    expect(input.value).toBe('')
    // A real pointer press focuses the canvas. Drag selection must return the
    // local keyboard target without emitting a second website click.
    canvas.setPointerCapture = vi.fn()
    canvas.hasPointerCapture = () => true
    canvas.releasePointerCapture = vi.fn()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
    const pointer = (type: string, x: number, y = 30) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          button: 0,
          clientX: x,
          clientY: y,
        }),
      )
    const beforeDrag = send.mock.calls.length
    canvas.focus()
    pointer('pointerdown', 20)
    pointer('pointermove', 100)
    pointer('pointerup', 100)
    canvas.click()
    expect(document.activeElement).toBe(input)
    expect(
      send.mock.calls.slice(beforeDrag).some(([frame]) => (frame as { type: string }).type === 'click'),
    ).toBe(false)
    expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'pointer', phase: 'up' })
    // Option on macOS and AltGr on Windows produce text through native input/IME events.
    for (const { platform, ...init } of [
      { platform: 'MacIntel', key: 'Dead', altKey: true },
      { platform: 'MacIntel', key: 'é', altKey: true },
      { platform: 'Win32', key: '@', ctrlKey: true, altKey: true },
    ]) {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
      const before = send.mock.calls.length
      const key = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      if ('ctrlKey' in init && init.ctrlKey)
        Object.defineProperty(key, 'getModifierState', { value: (name: string) => name === 'AltGraph' })
      input.dispatchEvent(key)
      expect(key.defaultPrevented).toBe(false)
      expect(send.mock.calls).toHaveLength(before)
    }
    canvas.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, deltaY: 3, deltaMode: 1, cancelable: true }),
    )
    await vi.waitFor(() => expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'scroll', y: 48 }))
    for (const [deltaMode, deltaY, expected] of [
      [0, 0.75, 0.75],
      [2, 1, 800],
    ] as const) {
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY, deltaMode, cancelable: true }))
      await vi.waitFor(() => expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'scroll', y: expected }))
    }
    for (const [platform, modifier, expected] of [
      ['Win32', 'ctrlKey', 'ControlOrMeta+a'],
      ['Win32', 'metaKey', 'Meta+a'],
      ['MacIntel', 'metaKey', 'ControlOrMeta+a'],
      ['MacIntel', 'ctrlKey', 'Control+a'],
    ] as const) {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', [modifier]: true }))
      expect(send.mock.lastCall?.[0]).toMatchObject({
        type: 'key',
        key: expected,
      })
    }
    const other = document.createElement('input')
    host.appendChild(other)
    for (const outcome of [
      'blur',
      'cancel',
      'lost-capture',
      'outside',
      'other-editor',
      'hidden',
      'stale-page',
    ]) {
      canvas.focus()
      pointer('pointerdown', 20)
      pointer('pointermove', 100)
      if (outcome === 'blur') window.dispatchEvent(new Event('blur'))
      if (outcome === 'cancel') pointer('pointercancel', 100)
      if (outcome === 'lost-capture') pointer('lostpointercapture', 100)
      if (outcome === 'outside') vi.mocked(document.elementFromPoint).mockReturnValue(other)
      if (outcome === 'other-editor') other.focus()
      if (outcome === 'hidden') vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      if (outcome === 'stale-page') {
        pixels(2)
        await vi.waitFor(() => expect(draw).toHaveBeenCalledTimes(3))
      }
      pointer('pointerup', 100)
      canvas.click()
      expect(document.activeElement).toBe(outcome === 'other-editor' ? other : canvas)
      vi.mocked(document.elementFromPoint).mockReturnValue(canvas)
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    }
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it.each(['native', 'legacy'] as const)(
  'coalesces acknowledged scrolling on %s without crossing gestures or replaying failures',
  async (transport) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let holdRenewal = false,
      releaseRenewal: (() => void) | undefined
    const callbacks = new Map<string, (value: unknown) => void>()
    const sent: Record<string, any>[] = []
    const receipts = new Map<number, { resolve(value: object): void; reject(error: Error): void }>()
    const request = vi.fn(async (frame: Record<string, any>) => {
      if (frame.type !== 'input') return {}
      sent.push(frame.input)
      return new Promise<object>((resolve, reject) => receipts.set(frame.input.seq, { resolve, reject }))
    })
    const channel = { request, onLost: () => () => {} } as unknown as NonNullable<
      ComponentProps<typeof BrowserScreen>['interaction']
    >
    const ctx = {
      sessionStreams: {
        open: async (name: string) => {
          if (name === 'browser.input' && holdRenewal)
            await new Promise<void>((resolve) => {
              releaseRenewal = resolve
            })
          return {
            send(frame: Record<string, any>) {
              sent.push(frame)
              return 'accepted'
            },
            close() {},
            onDisconnect() {},
            onFrame(fn: (value: unknown) => void) {
              callbacks.set(name, fn)
            },
          }
        },
      },
    } as unknown as ClientContext
    vi.stubGlobal('createImageBitmap', async () => ({ width: 2560, height: 1600, close() {} }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage() {},
      clearRect() {},
    } as unknown as CanvasRenderingContext2D)
    const host = document.createElement('div'),
      root = createRoot(host),
      ref = createRef<BrowserScreenHandle>()
    const page = {
      pageId: 'scrolling',
      url: 'http://localhost/',
      pageEpoch: 0,
      controlEpoch: 1,
      mode: 'human' as const,
    }
    const onError = vi.fn()
    const pixels = (pageEpoch: number) => {
      const metadata = new TextEncoder().encode(JSON.stringify({ ...page, pageEpoch }))
      const frame = new Uint8Array(metadata.length + 5)
      new DataView(frame.buffer).setUint32(0, metadata.length)
      frame.set(metadata, 4)
      callbacks.get('browser.frames')?.(frame)
    }
    const acknowledge = async (seq: number, error?: string) => {
      if (transport === 'native') {
        const receipt = receipts.get(seq)
        if (error) receipt?.reject(new Error(error))
        else receipt?.resolve({})
      } else callbacks.get('browser.input')?.({ seq, status: error ? 'error' : 'ok', code: error })
      await vi.advanceTimersByTimeAsync(0)
    }
    const scroll = (y: number) => ref.current!.interact({ type: 'scroll', x: 0, y })
    try {
      flushSync(() =>
        root.render(
          createElement(BrowserScreen, {
            ref,
            ctx,
            page,
            reconnect: 0,
            control: {
              pageId: page.pageId,
              controlEpoch: 1,
              operationId: '',
              ...(transport === 'native' ? { channel } : {}),
            },
            t: (key) => key,
            onError,
          }),
        ),
      )
      await vi.waitFor(() => expect(callbacks.has('browser.frames')).toBe(true))
      pixels(0)
      await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
      for (let n = 0; n < 40; n++) scroll(0.75)
      scroll(-1.5)
      ref.current!.interact({ type: 'click', x: 20, y: 30 })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ type: 'scroll', y: 0.75, seq: 0 })
      callbacks.get('browser.input')?.({ status: 'queued', seq: 0 })
      expect(sent).toHaveLength(1)
      await acknowledge(0)
      expect(sent[1]).toMatchObject({ type: 'scroll', y: 29.25, seq: 39 })
      await acknowledge(0) // A duplicate receipt must not release the next gesture.
      expect(sent).toHaveLength(2)
      await acknowledge(39)
      expect(sent[2]).toMatchObject({ type: 'scroll', y: -1.5, seq: 40 })
      await acknowledge(40)
      expect(sent[3]).toMatchObject({ type: 'click', x: 20, y: 30, seq: 41 })
      await acknowledge(41)
      scroll(1)
      scroll(2)
      scroll(3)
      pixels(1)
      await vi.advanceTimersByTimeAsync(0)
      await acknowledge(42)
      expect(sent).toHaveLength(5) // Navigation discards the unsent old-document delta.
      scroll(1)
      scroll(2)
      scroll(3)
      expect(sent[5]).toMatchObject({ pageEpoch: 1 })
      await acknowledge(45, 'DENIED')
      expect(sent).toHaveLength(6)
      expect(onError).toHaveBeenCalledOnce()
      const beforePaste = sent.length
      for (let index = 0; index < 40; index++) ref.current!.interact({ type: 'text', text: '中'.repeat(500) })
      for (let index = beforePaste; index < sent.length; index++) {
        const input = sent[index]!
        expect(input.type).toBe('text')
        expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(4096)
        await acknowledge(input.seq)
      }
      expect(
        sent
          .slice(beforePaste)
          .map((input) => input.text)
          .join(''),
      ).toBe('中'.repeat(20_000))
      const canvas = host.querySelector('canvas')!
      const wheel = (deltaY: number, deltaMode = 0) =>
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY, deltaMode, cancelable: true }))
      // A click, shortcut or text arriving inside the wheel batching window must
      // remain behind that wheel on both transports.
      for (const input of [
        { type: 'click', x: 20, y: 30 },
        { type: 'key', key: 'ControlOrMeta+a' },
        { type: 'text', text: '中文' },
      ]) {
        const before = sent.length
        wheel(3, 1)
        ref.current!.interact(input)
        expect(sent[before]).toMatchObject({ type: 'scroll', y: 48 })
        await acknowledge(sent[before]!.seq)
        expect(sent[before + 1]).toMatchObject(input)
        await acknowledge(sent[before + 1]!.seq)
        expect(sent).toHaveLength(before + 2)
      }
      // Trackpad reversal must not cancel a preceding delta, even within 8 ms.
      const beforeReversal = sent.length
      wheel(0.75)
      wheel(-0.25)
      expect(sent[beforeReversal]).toMatchObject({ type: 'scroll', y: 0.75 })
      await acknowledge(sent[beforeReversal]!.seq)
      await vi.waitFor(() => expect(sent[beforeReversal + 1]).toMatchObject({ type: 'scroll', y: -0.25 }))
      await acknowledge(sent[beforeReversal + 1]!.seq)
      if (transport === 'legacy') {
        holdRenewal = true
        await vi.advanceTimersByTimeAsync(25_000)
        expect(releaseRenewal).toBeDefined()
        const beforeRenewal = sent.length
        scroll(12)
        expect(sent).toHaveLength(beforeRenewal)
        releaseRenewal!()
        await vi.advanceTimersByTimeAsync(0)
        expect(sent[beforeRenewal]).toMatchObject({ type: 'scroll', y: 12 })
        await acknowledge(sent[beforeRenewal]!.seq)
      }
      scroll(1)
      scroll(2)
      scroll(3)
      const outstanding = sent.slice(-1),
        beforeClose = sent.length
      wheel(0.5)
      flushSync(() => root.unmount())
      for (const input of outstanding) await acknowledge(input.seq)
      await vi.advanceTimersByTimeAsync(16)
      expect(sent).toHaveLength(beforeClose) // Late receipts never replay buffered input after closing.
    } finally {
      flushSync(() => root.unmount())
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  },
)

it.each([
  'granted',
  'denied',
  'navigated',
  'agent-changed',
  'wheel',
  'drag-granted',
  'drag-denied',
  'drag-navigated',
  'drag-agent-changed',
  'drag-focus-moved',
  'drag-cancelled',
] as const)(
  'admits the first page gesture through native control and handles %s handover',
  async (scenario) => {
    const dragging = scenario.startsWith('drag-')
    const outcome = scenario.replace(/^drag-/, '')
    const callbacks = new Map<string, (value: unknown) => void>()
    const send = vi.fn((frame: unknown) => {
      callbacks.get('browser.input')?.({ status: 'ok', seq: (frame as { seq: number }).seq })
      return 'accepted'
    })
    const ctx = {
      sessionStreams: {
        open: async (name: string) => ({
          send,
          close() {},
          onDisconnect() {},
          onFrame(fn: (value: unknown) => void) {
            callbacks.set(name, fn)
          },
        }),
      },
    } as unknown as ClientContext
    vi.stubGlobal('createImageBitmap', async () => ({ width: 1280, height: 800, close() {} }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage() {},
      clearRect() {},
    } as unknown as CanvasRenderingContext2D)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const page = {
      pageId: 'one',
      url: 'http://localhost/',
      pageEpoch: 0,
      controlEpoch: 0,
      mode: 'agent' as const,
      pointerInput: true,
    }
    const grant = { pageId: 'one', controlEpoch: 1, operationId: 'native-effect' }
    let resolve!: (value: typeof grant | undefined) => void
    const waiting = new Promise<typeof grant | undefined>((done) => {
      resolve = done
    })
    const onError = vi.fn()
    const request = vi.fn(async () => {
      const result = await waiting
      if (result) flushSync(() => render(result))
      return result
    })
    const render = (control?: typeof grant) =>
      root.render(
        createElement(BrowserScreen, {
          ctx,
          page,
          reconnect: 0,
          control,
          onRequestControl: () => request(),
          onError,
          t: (key) => key,
        }),
      )
    const pixels = (pageEpoch: number, agentRevision = 0) => {
      const metadata = new TextEncoder().encode(JSON.stringify({ ...page, pageEpoch, agentRevision }))
      const frame = new Uint8Array(metadata.length + 5)
      new DataView(frame.buffer).setUint32(0, metadata.length)
      frame.set(metadata, 4)
      callbacks.get('browser.frames')?.(frame)
    }
    try {
      flushSync(() => render())
      await vi.waitFor(() => expect(callbacks.has('browser.frames')).toBe(true))
      pixels(0)
      await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
      const canvas = host.querySelector('canvas')!
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 400))
      const other = document.createElement('input')
      host.appendChild(other)
      if (outcome === 'wheel')
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 240, cancelable: true }))
      else if (dragging) {
        canvas.setPointerCapture = vi.fn()
        canvas.hasPointerCapture = () => true
        canvas.releasePointerCapture = vi.fn()
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
        const pointer = (type: string, x: number) =>
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              isPrimary: true,
              pointerId: 1,
              button: 0,
              clientX: x,
              clientY: 50,
            }),
          )
        canvas.focus()
        pointer('pointerdown', 40)
        pointer('pointermove', 80)
        if (outcome === 'cancelled') window.dispatchEvent(new Event('blur'))
        pointer('pointerup', 80)
        canvas.click()
      } else canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 50 }))
      expect(request).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      if (outcome !== 'wheel' && outcome !== 'cancelled') {
        const editor = host.querySelector('textarea')!
        expect(editor.disabled).toBe(false)
        expect(document.activeElement).toBe(editor)
        editor.value = 'first-characters'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
        expect(send).not.toHaveBeenCalled()
      }
      if (outcome === 'focus-moved' || outcome === 'cancelled') other.focus()
      if (outcome === 'navigated' || outcome === 'agent-changed') {
        pixels(outcome === 'navigated' ? 1 : 0, 1)
        // Let the replacement frame decode before the native admission resolves.
        await new Promise((done) => setTimeout(done, 0))
      }
      resolve(outcome === 'denied' ? undefined : grant)
      if (outcome === 'denied') {
        await waiting
        expect(callbacks.has('browser.input')).toBe(false)
        expect(send).not.toHaveBeenCalled()
      } else if (outcome === 'navigated' || outcome === 'agent-changed') {
        await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('pageChanged'))
        expect(send).not.toHaveBeenCalled()
      } else if (outcome === 'cancelled') {
        await vi.waitFor(() => expect(callbacks.has('browser.input')).toBe(true))
        expect(send).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(other)
      } else {
        await vi.waitFor(() => expect(send).toHaveBeenCalled())
        expect(send.mock.calls[0]?.[0]).toMatchObject({
          type: outcome === 'wheel' ? 'scroll' : dragging ? 'pointer' : 'click',
          x: outcome === 'wheel' ? 0 : 80,
          y: outcome === 'wheel' ? 240 : 100,
          pageEpoch: 0,
          controlEpoch: 1,
        })
        if (outcome === 'granted') {
          expect(send.mock.calls.slice(-2).map(([frame]) => frame)).toMatchObject([
            { type: 'text', text: 'first-characters', pageEpoch: 0 },
            { type: 'key', key: 'Backspace', pageEpoch: 0 },
          ])
          if (dragging) {
            expect(send.mock.calls.at(-3)?.[0]).toMatchObject({ type: 'pointer', phase: 'up' })
            expect(send.mock.calls.some(([frame]) => (frame as { type: string }).type === 'click')).toBe(
              false,
            )
          }
        }
        if (outcome !== 'wheel')
          expect(document.activeElement).toBe(
            outcome === 'focus-moved' ? other : host.querySelector('textarea'),
          )
        if (outcome === 'granted') {
          send.mockClear()
          canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 240, cancelable: true }))
          flushSync(() => render(grant))
          await vi.waitFor(() =>
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'scroll', y: 240 })),
          )
        }
      }
      if (outcome === 'denied' || outcome === 'navigated') expect(send).not.toHaveBeenCalled()
    } finally {
      flushSync(() => root.unmount())
      host.remove()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  },
)

it('keeps painting under slow decoding and skips superseded queued images', async () => {
  const callbacks = new Map<string, (value: unknown) => void>()
  const decoded: { blob: Blob; finish(bitmap: ImageBitmap): void }[] = []
  const ctx = {
    sessionStreams: {
      open: async (name: string) => ({
        close() {},
        onDisconnect() {},
        onFrame(fn: (value: unknown) => void) {
          callbacks.set(name, fn)
        },
      }),
    },
  } as unknown as ClientContext
  vi.stubGlobal(
    'createImageBitmap',
    (blob: Blob) =>
      new Promise<ImageBitmap>((finish) => {
        decoded.push({ blob, finish })
      }),
  )
  const draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: draw,
    clearRect() {},
  } as unknown as CanvasRenderingContext2D)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const page = {
    pageId: 'slow-page',
    url: 'http://localhost/',
    pageEpoch: 0,
    controlEpoch: 0,
    mode: 'agent' as const,
  }
  const emit = (id: number) => {
    const metadata = new TextEncoder().encode(JSON.stringify(page))
    const frame = new Uint8Array(metadata.length + 5)
    new DataView(frame.buffer).setUint32(0, metadata.length)
    frame.set(metadata, 4)
    frame[frame.length - 1] = id
    callbacks.get('browser.frames')!(frame)
  }
  const bitmap = () => ({ width: 1280, height: 800, close: vi.fn() }) as unknown as ImageBitmap
  try {
    flushSync(() =>
      root.render(
        createElement(BrowserScreen, { ctx, page, reconnect: 0, t: (key) => key, onError: vi.fn() }),
      ),
    )
    await vi.waitFor(() => expect(callbacks.has('browser.frames')).toBe(true))
    emit(1)
    emit(2)
    emit(3)
    const first = bitmap()
    decoded[0]!.finish(first)
    await vi.waitFor(() => expect(draw).toHaveBeenCalledWith(first, 0, 0))
    expect(decoded).toHaveLength(2)
    expect([...new Uint8Array(await decoded[1]!.blob.arrayBuffer())]).toEqual([3])
    const latest = bitmap()
    decoded[1]!.finish(latest)
    await vi.waitFor(() => expect(draw).toHaveBeenCalledWith(latest, 0, 0))
    expect(first.close).toHaveBeenCalled()
    emit(4)
    const afterClose = bitmap()
    flushSync(() => root.unmount())
    decoded[2]!.finish(afterClose)
    await vi.waitFor(() => expect(afterClose.close).toHaveBeenCalled())
    expect(draw).toHaveBeenCalledTimes(2)
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('recovers the read-only display after admission cooldown and stops retrying when closed', async () => {
  vi.useFakeTimers()
  let receive: ((frame: unknown) => void) | undefined
  let disconnect: (() => void) | undefined
  let available = false
  const open = vi.fn(async (_name: string) => {
    if (!available) throw new Error('stream admission refused')
    return {
      close() {},
      onDisconnect(fn: () => void) {
        disconnect = fn
      },
      onFrame(fn: (frame: unknown) => void) {
        receive = fn
      },
    }
  })
  const effect = vi.fn(async () => {
    throw new Error('selection connection lost')
  })
  const ctx = { sessionStreams: { open }, agnes: { services: { effect } } } as unknown as ClientContext
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1280, height: 800, close() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    clearRect() {},
  } as unknown as CanvasRenderingContext2D)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const page = {
    pageId: 'cooldown-page',
    url: 'http://localhost/',
    pageEpoch: 0,
    controlEpoch: 0,
    mode: 'agent' as const,
  }
  const onError = vi.fn()
  const render = (pageId: string) =>
    flushSync(() =>
      root.render(
        createElement(BrowserScreen, {
          ctx,
          page: { ...page, pageId },
          reconnect: 0,
          t: (key) => key,
          onError,
        }),
      ),
    )
  try {
    render(page.pageId)
    await vi.advanceTimersByTimeAsync(7000)
    expect(host.querySelector('[data-connected="true"]')).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    // The native admission window is one minute. The display must recover after it,
    // without issuing a new input effect or increasing the server's allowance.
    available = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(receive).toBeDefined()
    const metadata = new TextEncoder().encode(JSON.stringify(page))
    const frame = new Uint8Array(metadata.length + 5)
    new DataView(frame.buffer).setUint32(0, metadata.length)
    frame.set(metadata, 4)
    receive!(frame)
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
    render('next-page')
    await vi.advanceTimersByTimeAsync(1100)
    const nextMetadata = new TextEncoder().encode(JSON.stringify({ ...page, pageId: 'next-page' }))
    const nextFrame = new Uint8Array(nextMetadata.length + 5)
    new DataView(nextFrame.buffer).setUint32(0, nextMetadata.length)
    nextFrame.set(nextMetadata, 4)
    receive!(nextFrame)
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
    expect(effect).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(open.mock.calls.every(([name]) => name === 'browser.frames')).toBe(true)
    disconnect?.()
    flushSync(() => root.unmount())
    const stopped = open.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(open).toHaveBeenCalledTimes(stopped)
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
