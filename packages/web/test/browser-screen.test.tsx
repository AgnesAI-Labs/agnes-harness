/** @vitest-environment happy-dom */
import type { ClientContext } from '@agnes/web-client'
import { type ComponentProps, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BrowserScreen } from '../../package-manager/bundled-plugins/browser/src/browser-screen.js'

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
  let finish: ((value: unknown) => void) | undefined
  const bitmap = { width: 1280, height: 800, close() {} }
  const decode = vi.fn(async () => bitmap)
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
  const pixels = (pageId: string, pageEpoch = 0) => {
    const metadata = new TextEncoder().encode(JSON.stringify({ ...page, pageId, pageEpoch }))
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
    expect(draw).not.toHaveBeenCalled()
    pixels('one')
    expect(draw).not.toHaveBeenCalled()
    pixels('two')
    await vi.waitFor(() => expect(host.querySelector('[data-connected="true"]')).not.toBeNull())
    // The same page can restore a different document without producing new CDP paints.
    const priorCall = effect.mock.lastCall
    if (!priorCall) throw new Error('Missing initial view selection')
    const priorSelection = (priorCall[1] as { sequence: number }).sequence
    render('two', 1)
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

it('keeps input bound to displayed pixels when navigation acknowledgement precedes the new image', async () => {
  const callbacks = new Map<string, (value: unknown) => void>()
  const send = vi.fn((_frame: unknown) => 'accepted')
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
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it.each(['granted', 'denied', 'navigated', 'agent-changed', 'wheel'] as const)(
  'admits the first page click through native control and handles %s handover',
  async (outcome) => {
    const callbacks = new Map<string, (value: unknown) => void>()
    const send = vi.fn((_frame: unknown) => 'accepted')
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
      if (outcome === 'wheel')
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 240, cancelable: true }))
      else canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 50 }))
      expect(request).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      if (outcome !== 'wheel') {
        const editor = host.querySelector('textarea')!
        expect(editor.disabled).toBe(false)
        expect(document.activeElement).toBe(editor)
        editor.value = 'first-characters'
        editor.dispatchEvent(new Event('input', { bubbles: true }))
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
        expect(send).not.toHaveBeenCalled()
      }
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
      } else {
        await vi.waitFor(() => expect(send).toHaveBeenCalled())
        expect(send.mock.calls[0]?.[0]).toMatchObject({
          type: outcome === 'wheel' ? 'scroll' : 'click',
          x: outcome === 'wheel' ? 0 : 80,
          y: outcome === 'wheel' ? 240 : 100,
          pageEpoch: 0,
          controlEpoch: 1,
        })
        if (outcome === 'granted')
          expect(send.mock.calls.slice(1).map(([frame]) => frame)).toMatchObject([
            { type: 'text', text: 'first-characters', pageEpoch: 0 },
            { type: 'key', key: 'Backspace', pageEpoch: 0 },
          ])
        if (outcome !== 'wheel') expect(document.activeElement).toBe(host.querySelector('textarea'))
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
