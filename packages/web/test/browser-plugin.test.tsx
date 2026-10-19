/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import { Context } from '@agnes/cordis'
import {
  browserViews,
  PresentationRoleRegistry,
  SessionService,
  workbenchNavigation,
  workbenchPanels,
} from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
// @ts-expect-error Shipped plugin ESM.
import { autoOpenBrowser } from '../../package-manager/bundled-plugins/browser-runtime/src/auto-open.js'
// @ts-expect-error Shipped ESM is exercised directly, without release-generated declarations.
import * as transport from '../../package-manager/bundled-plugins/browser-runtime/src/client.js'
// @ts-expect-error Shipped ESM is exercised directly, without release-generated declarations.
import * as viewer from '../../package-manager/bundled-plugins/browser-ui/src/client.js'

it('enables transport and panel together, tolerates the legacy viewer, and disconnects on switch or disable', async () => {
  const roles = new PresentationRoleRegistry()
  const session = new SessionService(new Context(), 'one')
  const closed = vi.fn()
  const query = vi.fn(async (_name, { sessionId }) => ({
    state: 'ready',
    ticket: `ticket-${sessionId}`,
    url: `https://${sessionId}.example`,
  }))
  let sendFrame: (frame: unknown) => void = () => {}
  let disconnect: (info: { reason: string }) => void = () => {}
  const bitmapClose = vi.fn()
  const draw = vi.fn()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1280, height: 800, close: bitmapClose })),
  )
  const canvasContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
  const open = vi.fn(async () => ({
    onFrame: (fn: typeof sendFrame) => {
      sendFrame = fn
      return () => {}
    },
    onDisconnect: (fn: typeof disconnect) => {
      disconnect = fn
      return () => {}
    },
    close: closed,
  }))
  const ctx = (owner: string) => ({
    session,
    locale: { locale: 'zh-CN' },
    profile: { services: { query }, streams: { open } },
    workbenchPanels,
    presentationRoles: {
      register: (provider: { role: string; mount: (context: unknown) => () => void }) =>
        roles.register(owner, { ...provider, mount: () => provider.mount(ctx(owner)) }),
    },
  })
  expect(workbenchPanels.get('browser')).toBeUndefined()
  const stopTransport = transport.apply(ctx('backend'))
  expect(browserViews.entries()).toHaveLength(1)
  expect(workbenchPanels.get('browser')).toBeDefined()
  expect(query).not.toHaveBeenCalled()
  const ownPanel = workbenchPanels.get('browser')
  const stopViewer = viewer.apply(ctx('viewer'))
  expect(workbenchPanels.get('browser')).toBe(ownPanel)
  expect(roles.getSnapshot()).toEqual([])
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const panel = workbenchPanels.get('browser')
    if (!panel) throw new Error('Browser panel missing')
    await act(async () => {
      root.render(createElement(panel.component, { context: { t: (key) => key } }))
    })
    expect(query).toHaveBeenCalledWith('browser.observe', { sessionId: 'one' }, { sessionReads: ['one'] })
    expect(open).toHaveBeenCalledWith(
      'browser.frames',
      { ticket: 'ticket-one' },
      { signal: expect.any(AbortSignal) },
    )
    expect(host.textContent).toContain('https://one.example')
    expect(host.textContent).toContain('仅观看')
    await act(async () => sendFrame(new Uint8Array(32000)))
    expect(draw).toHaveBeenCalled()
    expect(bitmapClose).toHaveBeenCalled()
    expect(host.textContent).not.toContain('正在连接独立浏览器')
    vi.useFakeTimers()
    await act(async () => disconnect({ reason: 'protocol' }))
    const before = open.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999)
    })
    expect(open).toHaveBeenCalledTimes(before)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(open).toHaveBeenCalledTimes(before + 1)
    await act(async () => disconnect({ reason: 'protocol' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999)
    })
    expect(open).toHaveBeenCalledTimes(before + 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(open).toHaveBeenCalledTimes(before + 2)
    for (const wait of [20000, 30000]) {
      await act(async () => disconnect({ reason: 'protocol' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait)
      })
    }
    await act(async () => disconnect({ reason: 'protocol' }))
    const stoppedAt = open.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
    })
    expect(open).toHaveBeenCalledTimes(stoppedAt)
    expect(host.textContent).toContain('自动重连已暂停')
    vi.useRealTimers()
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === '重试')
    if (!retry) throw new Error('Browser retry control missing')
    await act(async () => retry.click())
    expect(open).toHaveBeenCalledTimes(stoppedAt + 1)
    expect(host.querySelector<HTMLElement>('[data-testid="browser-panel"]')?.style.display).toBe('flex')
    expect(host.querySelector('canvas')?.style.width).toBe('100%')
    const resize = host.querySelector<HTMLButtonElement>('button[aria-pressed]')
    if (!resize) throw new Error('Browser size control missing')
    await act(async () => resize.click())
    expect(host.querySelector('canvas')?.style.width).toBe('auto')
    await act(async () => resize.click())
    expect(host.querySelector('canvas')?.style.width).toBe('100%')
    await act(async () => session.setSession('two'))
    expect(closed).toHaveBeenCalledWith('viewer-closed')
    expect(host.textContent).toContain('https://two.example')
    expect(host.textContent).not.toContain('https://one.example')
    await act(async () => {
      root.unmount()
    })
    expect(workbenchPanels.get('browser')).toBe(ownPanel)
    // Even an installed legacy viewer must disappear when the browser plugin is disabled.
    stopTransport()
    expect(workbenchPanels.get('browser')).toBeUndefined()
    expect(browserViews.entries()).toHaveLength(0)
  } finally {
    stopViewer()
    stopTransport()
    host.remove()
    vi.useRealTimers()
    canvasContext.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('opens only for live browser calls, once per turn, and never for ordinary messages or history', () => {
  const listeners = new Set<(method: string, params: unknown) => void>()
  const handle = { cursor: () => ({ fromSeq: 10 }), listeners }
  const session = new SessionService(new Context(), 'one')
  session.setReadiness('ready')
  const openPanel = vi.fn(() => true)
  const offNavigation = workbenchNavigation.register(openPanel)
  const stop = autoOpenBrowser({ session, agnes: { sessions: { get: () => handle } } })
  let seq = 10
  const emit = (type: string, name = 'browser_open', lane = 'main', sessionId = 'one') => {
    const event = { seq: ++seq, type, lane, origin: 'model', trust: 'trusted', data: { name } }
    for (const listener of listeners) listener('_agnes/v1/session.event', { sessionId, event })
  }
  try {
    expect(openPanel).not.toHaveBeenCalled()
    emit('user/message')
    emit('assistant/message')
    emit('tool/call', 'web_fetch')
    emit('tool/call', 'browser_open', 'child')
    emit('tool/call', 'browser_open', 'main', 'other')
    expect(openPanel).not.toHaveBeenCalled()
    emit('tool/call')
    expect(openPanel).toHaveBeenCalledExactlyOnceWith('browser')
    emit('tool/call', 'browser_fill')
    expect(openPanel).toHaveBeenCalledTimes(1)
    emit('turn/start')
    emit('user/message')
    expect(openPanel).toHaveBeenCalledTimes(1)
    emit('tool/call', 'browser_snapshot')
    expect(openPanel).toHaveBeenCalledTimes(2)
    session.setReadiness('connecting')
    emit('tool/call')
    expect(openPanel).toHaveBeenCalledTimes(2)
    session.setReadiness('ready')
    seq = 0
    emit('tool/call')
    expect(openPanel).toHaveBeenCalledTimes(2)
    stop()
    seq = 50
    emit('tool/call')
    expect(openPanel).toHaveBeenCalledTimes(2)
  } finally {
    stop()
    offNavigation()
  }
})
