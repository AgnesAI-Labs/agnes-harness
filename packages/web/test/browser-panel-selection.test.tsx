/** @vitest-environment happy-dom */
import type { ClientContext } from '@agnes/web-client'
import { act, type ComponentType, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../../package-manager/bundled-plugins/browser/src/browser.js'
import { browserAddress } from '../../package-manager/bundled-plugins/browser/src/browser-address.js'

const screenInteract = vi.hoisted(() => vi.fn())

vi.mock('@agnes/web-ui', async () => {
  const { createElement } = await import('react')
  const button = ({ children, label, onClick, disabled, htmlType }: any) =>
    createElement('button', { onClick, disabled, type: htmlType, 'aria-label': label }, children ?? label)
  return {
    Button: button,
    IconButton: button,
    Menu: ({ items }: { items: { id: string; label: string; onSelect(): void }[] }) =>
      createElement(
        'div',
        {},
        items.map((item) =>
          createElement(
            'button',
            { key: item.id, 'data-option': item.id, onClick: item.onSelect },
            item.label,
          ),
        ),
      ),
    SettingsInput: (props: any) => createElement('input', props),
    Tabs: ({ items, activeKey, onChange }: any) =>
      createElement(
        'div',
        { role: 'tablist' },
        items.map((item: any) =>
          createElement(
            'button',
            {
              key: item.key,
              role: 'tab',
              'data-tab': item.key,
              'aria-selected': activeKey === item.key,
              onClick: () => onChange(item.key),
            },
            item.label,
          ),
        ),
      ),
  }
})
vi.mock('../../package-manager/bundled-plugins/browser/src/browser-screen.js', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react')
  return {
    BrowserScreen: forwardRef((props: { fixedSize?: boolean; actualSize?: boolean }, ref) => {
      useImperativeHandle(ref, () => ({ interact: screenInteract }))
      return createElement('div', {
        'data-viewport': props.fixedSize ? 'fixed' : 'adaptive',
        'data-scale': props.actualSize ? 'actual' : 'fit',
      })
    }),
  }
})

it.each([
  [' www.baidu.com ', 'https://www.baidu.com/'],
  ['baidu.com/a?q=1#part', 'https://baidu.com/a?q=1#part'],
  ['localhost:5173', 'http://localhost:5173/'],
  ['127.0.0.1:5173', 'http://127.0.0.1:5173/'],
  ['[::1]:5173', 'http://[::1]:5173/'],
  ['http://example.com', 'http://example.com/'],
  ['index.html', 'index.html'],
  ['docs.v1/index.html', 'docs.v1/index.html'],
  ['./example.com', './example.com'],
  ['C:\\workspace\\index.html', 'C:\\workspace\\index.html'],
  ['file:///workspace/index.html', 'file:///workspace/index.html'],
  ['https://', undefined],
  ['www..example.com', undefined],
  ['https://account:token@example.com/', undefined],
  ['javascript:alert(1)', undefined],
])('converts address-bar input %s to %s', (input, output) => {
  expect(browserAddress(input)).toBe(output)
})

it('automatically displays agent pages without a load button or an input connection for empty history', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  let selected = { status: 'ready', sessionId: 'test', epoch: 1 }
  const readinessListeners = new Set<() => void>()
  const callbacks = new Map<string, (frame: unknown) => void>()
  const stream = {
    open: vi.fn(async (name: string) => ({
      send() {
        return 'accepted'
      },
      close() {},
      onDisconnect() {},
      onFrame(fn: (frame: unknown) => void) {
        callbacks.set(name, fn)
      },
    })),
  }
  const effect = vi.fn(async () => ({ status: 'ok' }))
  const call = vi.fn(async () => ({ pages: [] }))
  const query = vi.fn(async () => ({ enabled: true, state: 'ready' }))
  let Panel: ComponentType = () => null
  const ctx = {
    locale: {
      t: (key: string) => key,
      register: () => () => {},
      subscribe: () => () => {},
      getSnapshot: () => 'en',
    },
    workbenchPanels: {
      register(value: { component: ComponentType }) {
        Panel = value.component
        return () => {}
      },
    },
    session: {
      get sessionId() {
        return selected.sessionId
      },
      readiness: {
        subscribe: (listener: () => void) => {
          readinessListeners.add(listener)
          return () => readinessListeners.delete(listener)
        },
        getSnapshot: () => selected,
      },
    },
    sessionStreams: stream,
    profile: { streams: stream, services: { query } },
    agnes: { services: { effect, call } },
  } as unknown as ClientContext
  const dispose = apply(ctx)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const page = (id: string, activity: number) => ({
    pageId: id,
    activity,
    url: 'http://localhost/' + id,
    pageEpoch: 0,
    controlEpoch: 0,
    mode: 'agent',
  })
  const publish = async (pages: unknown[]) =>
    act(async () => callbacks.get('browser.pages')?.({ enabled: true, state: 'ready', pages }))
  const submitAddress = async (value: string) => {
    const input = container.querySelector('input')
    if (!input?.form) throw new Error('missing address bar')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input.form?.dispatchEvent(new Event('submit', { bubbles: true })))
  }
  try {
    await act(async () => root.render(createElement(Panel)))
    await publish([])
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(container.textContent).not.toContain('browser.load')
    expect(container.textContent).toContain('browser.empty')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(stream.open.mock.calls.map(([name]) => name)).toEqual(['browser.pages'])
    expect(effect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    const open = container.querySelector<HTMLButtonElement>('[aria-label="browser.open"]')
    if (!open) throw new Error('Missing browser address submit button')
    const failed = (errorCode: string, cleanupRequired = false) =>
      act(async () =>
        callbacks.get('browser.pages')?.({ enabled: true, state: 'failed', errorCode, cleanupRequired, pages: [] }),
      )
    await failed('UNSUPPORTED_MACOS')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.unsupportedMacOS')
    expect(open.disabled).toBe(true)
    await submitAddress('localhost:5173')
    await failed('LAUNCH_FAILED', true)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.cleanupUnconfirmed')
    expect(open.disabled).toBe(true)
    await submitAddress('localhost:5173')
    expect(effect).not.toHaveBeenCalled()
    await failed('LAUNCH_FAILED')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.launchFailed')
    expect(open.disabled).toBe(false)
    effect.mockImplementationOnce(async () => ({ status: 'refused', code: 'LAUNCH_FAILED' }))
    await submitAddress('  localhost:5173  ')
    expect(effect).toHaveBeenCalledWith('browser.open', { url: 'http://localhost:5173/' }, expect.anything())
    expect(container.textContent).not.toContain('browser.checkAction')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.launchFailed')
    effect.mockClear()
    await submitAddress('localhost:5173')
    expect(effect).toHaveBeenCalledWith('browser.open', { url: 'http://localhost:5173/' }, expect.anything())
    effect.mockClear()
    await publish([])
    call.mockRejectedValueOnce(new Error('Session pages unavailable'))
    await act(async () => callbacks.get('browser.pages')?.({ enabled: true, state: 'ready', changed: true }))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain('browser.empty')
    expect(effect).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.textContent).toContain('browser.empty')
    await submitAddress('https://')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.invalidUrl')
    expect(effect).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('browser.checkAction')
    await submitAddress('www.baidu.com')
    expect(effect).toHaveBeenCalledWith('browser.open', { url: 'https://www.baidu.com/' }, expect.anything())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    effect.mockResolvedValueOnce({ status: 'refused', code: 'FILE_DENIED' } as never)
    await submitAddress('index.html')
    expect(effect).toHaveBeenCalledWith('browser.open', { url: 'index.html' }, expect.anything())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.fileDenied')
    expect(container.textContent).not.toContain('browser.checkAction')
    effect.mockRejectedValueOnce(new Error('response lost'))
    await submitAddress('example.com')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.actionStatusUnavailable')
    const afterLoss = effect.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(effect).toHaveBeenCalledTimes(afterLoss)
    expect(container.textContent).not.toContain('browser.checkAction')
    call.mockRejectedValueOnce(
      Object.assign(new Error('Superseded'), { kind: 'json-rpc', data: { code: 'GENERATION_STALE' } }),
    )
    await act(async () => callbacks.get('browser.pages')?.({ enabled: true, state: 'ready', changed: true }))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('browser.sessionIncompatible')
    expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
    const afterRefusal = call.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(call).toHaveBeenCalledTimes(afterRefusal)
    effect.mockClear()
    call.mockClear()
    stream.open.mockClear()
    await act(async () => {
      selected = { status: 'history-only', sessionId: 'test', epoch: selected.epoch + 1 }
      for (const listener of readinessListeners) listener()
    })
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('browser.sessionUnavailable')
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(stream.open).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    await act(async () => {
      selected = { status: 'ready', sessionId: 'test', epoch: selected.epoch + 1 }
      for (const listener of readinessListeners) listener()
    })
    expect(stream.open).toHaveBeenCalledWith('browser.pages', {}, expect.anything())
    await vi.waitFor(() => expect(callbacks.has('browser.pages')).toBe(true))
    await publish([page('user', 1), page('model', 2)])
    expect(effect).toHaveBeenCalledWith('browser.connect', {}, expect.anything())
    await submitAddress('example.com/path')
    expect(screenInteract).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com/path' })
    expect(container.querySelector('[data-viewport="adaptive"][data-scale="fit"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-option="viewport"]')!.click())
    expect(container.querySelector('[data-viewport="fixed"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-option="viewport"]')!.click())
    expect(container.querySelector('[data-viewport="adaptive"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-option="scale"]')!.click())
    expect(container.querySelector('[data-scale="actual"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-option="viewport"]')!.click())
    expect(container.querySelector('[data-viewport="adaptive"][data-scale="fit"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-tab="user"]')!.click())
    await publish([page('user', 1), page('model', 10), page('new-test', 11)])
    expect(container.querySelector('[data-tab="user"]')?.getAttribute('aria-selected')).toBe('true')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-tab="model"]')!.click())
    await publish([page('user', 20), page('model', 10), page('new-test', 21)])
    expect(container.querySelector('[data-tab="model"]')?.getAttribute('aria-selected')).toBe('true')
    await publish([page('user', 20), page('new-test', 21)])
    expect(container.querySelector('[data-tab="user"]')?.getAttribute('aria-selected')).toBe('true')
    for (const sessionId of ['test', 'other', 'test']) {
      stream.open.mockClear()
      effect.mockClear()
      call.mockClear()
      query.mockClear()
      await act(async () => {
        selected = { status: 'ready', sessionId, epoch: selected.epoch + 1 }
        for (const listener of readinessListeners) listener()
      })
      await publish([])
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(container.querySelector('[role="tablist"]')).toBeNull()
      expect(stream.open.mock.calls.map(([name]) => name)).toEqual(['browser.pages'])
      expect(effect).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
    }
    // Closing the final page then opening a new one can prepare a fresh input channel.
    await publish([page('reopened', 1)])
    expect(effect).toHaveBeenCalledWith('browser.connect', {}, expect.anything())
    await publish([])
    await act(async () => root.render(null))
    stream.open.mockClear()
    effect.mockClear()
    call.mockClear()
    query.mockClear()
    await act(async () => root.render(createElement(Panel)))
    await publish([])
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(stream.open.mock.calls.map(([name]) => name)).toEqual(['browser.pages'])
    expect(effect).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  } finally {
    await act(async () => {
      root.unmount()
      dispose()
    })
    container.remove()
    vi.useRealTimers()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  }
})
