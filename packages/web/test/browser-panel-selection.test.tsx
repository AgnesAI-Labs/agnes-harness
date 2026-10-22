/** @vitest-environment happy-dom */
import type { ClientContext } from '@agnes/web-client'
import { act, type ComponentType, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../../package-manager/bundled-plugins/browser/src/browser.js'

vi.mock('@agnes/web-ui', async () => {
  const { createElement } = await import('react')
  const button = ({ children, label, onClick }: any) =>
    createElement('button', { onClick, 'aria-label': label }, children ?? label)
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
  const { createElement, forwardRef } = await import('react')
  return {
    BrowserScreen: forwardRef((props: { fixedSize?: boolean; actualSize?: boolean }, _ref) =>
      createElement('div', {
        'data-viewport': props.fixedSize ? 'fixed' : 'adaptive',
        'data-scale': props.actualSize ? 'actual' : 'fit',
      }),
    ),
  }
})

it('keeps the user-selected tab while the model changes activity or opens another tab', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const callbacks = new Map<string, (frame: unknown) => void>()
  const stream = {
    open: async (name: string) => ({
      send() {
        return 'accepted'
      },
      close() {},
      onDisconnect() {},
      onFrame(fn: (frame: unknown) => void) {
        callbacks.set(name, fn)
      },
    }),
  }
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
      sessionId: 'test',
      readiness: {
        subscribe: () => () => {},
        getSnapshot: () => ({ status: 'ready', sessionId: 'test', epoch: 1 }),
      },
    },
    sessionStreams: stream,
    profile: { streams: stream },
    agnes: { services: { effect: async () => ({ status: 'ok' }), call: async () => ({ pages: [] }) } },
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
  try {
    await act(async () => root.render(createElement(Panel)))
    await vi.waitFor(() => expect(callbacks.has('browser.pages')).toBe(true))
    await publish([page('user', 1), page('model', 2)])
    expect(container.querySelector('[data-viewport="adaptive"]')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-option="viewport"]')!.click())
    expect(container.querySelector('[data-viewport="fixed"]')).not.toBeNull()
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
  } finally {
    await act(async () => {
      root.unmount()
      dispose()
    })
    container.remove()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  }
})
