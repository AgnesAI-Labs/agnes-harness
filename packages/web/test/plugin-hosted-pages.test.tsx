/** @vitest-environment happy-dom */

import * as ui from '@agnes/web-ui'
import { PushStack, searchParamRoute } from '@agnes/web-ui'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginView } from '../src/pages/plugins/admin-view.js'
import { type HostedOpen, HostedPage, useHostedDialog } from '../src/pages/plugins/hosted-pages.js'
import { InstallReviewPage } from '../src/pages/plugins/install-page.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
beforeEach(() => {
  history.replaceState(null, '', '/?page=plugins')
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

/** A controller's host, kept outside the page the way the workbench keeps it. */
function controllerHost(id: string, onCancel: (host: HTMLDialogElement) => void) {
  const host = document.createElement('dialog')
  host.id = id
  host.addEventListener('cancel', (event) => {
    event.preventDefault()
    onCancel(host)
  })
  const shell = document.createElement('div')
  shell.id = `${id}-shell`
  shell.append(host)
  document.body.append(shell)
  return host
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const view = () => new URL(location.href).searchParams.get('view')

function Pages({
  open,
  formOpen = () => 'opened',
}: {
  open(segment: string): HostedOpen
  formOpen?(): HostedOpen
}) {
  const detail = useHostedDialog({
    id: 'detail',
    returnFocus: () => document.getElementById('list'),
    ready: 0,
    owns: (segment) => segment.startsWith('item:'),
    pageOf: (host) => `item:${host.dataset.item}`,
    open,
  })
  const form = useHostedDialog({
    id: 'form',
    ready: 0,
    owns: (segment) => segment === 'add',
    pageOf: () => 'add',
    open: formOpen,
  })
  return createElement(
    Fragment,
    null,
    createElement(HostedPage, { segment: 'add', host: form, title: 'Add' }),
    ['item:a', 'item:b'].map((segment) =>
      createElement(HostedPage, { key: segment, segment, host: detail, title: segment }),
    ),
  )
}

async function mount(open: (segment: string) => HostedOpen = () => 'opened') {
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(
        PushStack,
        { rootTitle: 'Plugins', route: searchParamRoute('view') },
        createElement('button', { id: 'list', type: 'button' }, 'Open item'),
        createElement(Pages, { open }),
      ),
    ),
  )
  await settle()
}

it('shows an opened detail as a page with 返回 and its address, and 返回 closes it the way Escape does', async () => {
  const closed = vi.fn((host: HTMLDialogElement) => host.close())
  const detail = controllerHost('detail', closed)
  await mount()
  expect(detail.dataset.presentation).toBe('page')
  detail.dataset.item = 'a'
  await act(async () => detail.show())
  await settle()
  expect(view()).toBe('item:a')
  // The host sits in the page's body while the page is open, and the list is hidden under it.
  expect(document.querySelector('[data-testid="push-page-item:a"]')?.contains(detail)).toBe(true)
  expect(document.getElementById('list')?.closest('[hidden]')).not.toBeNull()
  expect(document.querySelector('[data-testid="push-header"]')?.textContent).toContain('Plugins')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="push-back"]')?.click())
  await settle()
  await settle()
  expect(closed).toHaveBeenCalledOnce()
  expect(detail.open).toBe(false)
  expect(document.activeElement).toBe(document.getElementById('list'))
  expect(view()).toBeNull()
  // Back where the controller keeps it once its page has gone.
  expect(document.getElementById('detail-shell')?.contains(detail)).toBe(true)
})

it('leaves the page when the controller closes its detail, and when the browser goes back', async () => {
  const detail = controllerHost('detail', (host) => host.close())
  await mount()
  detail.dataset.item = 'a'
  await act(async () => detail.show())
  await settle()
  expect(view()).toBe('item:a')
  await act(async () => detail.close())
  await settle()
  await settle()
  expect(view()).toBeNull()
  expect(document.querySelector('[data-testid="push-page-item:a"]')).toBeNull()
  expect(document.activeElement).toBe(document.getElementById('list'))
  // Completing the controller flow keeps its parent page and leaves no finished detail ahead.
  await act(async () => history.forward())
  await settle()
  await settle()
  expect(new URL(location.href).searchParams.get('page')).toBe('plugins')
  expect(view()).toBeNull()
  expect(detail.open).toBe(false)

  await act(async () => detail.show())
  await settle()
  expect(view()).toBe('item:a')
  await act(async () => {
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }))
    history.back()
    await popped
  })
  await settle()
  await settle()
  expect(detail.open).toBe(false)
  expect(view()).toBeNull()
})

it('asks the controller to open what a link names, and leaves a page whose item is gone', async () => {
  const detail = controllerHost('detail', (host) => host.close())
  history.replaceState(null, '', '/?page=plugins&view=item%3Ab')
  let found = true
  const open = vi.fn((segment: string): HostedOpen => {
    if (!found) return 'missing'
    detail.dataset.item = segment.slice('item:'.length)
    detail.show()
    return 'opened'
  })
  await mount(open)
  expect(open).toHaveBeenCalledWith('item:b')
  expect(detail.open).toBe(true)
  expect(view()).toBe('item:b')
  // The page's title keeps focus, not the host that opened under it.
  expect(document.activeElement?.tagName).toBe('H2')
  await act(async () => root?.unmount())
  root = undefined
  detail.close()

  found = false
  history.replaceState(null, '', '/?page=plugins&view=item%3Agone')
  await mount(open)
  await settle()
  expect(detail.open).toBe(false)
  expect(view()).toBeNull()
  expect(document.querySelector('[data-testid="push-page-item:gone"]')).toBeNull()
})

it('lets a form give way to the detail it produced: back then leaves the flow', async () => {
  const form = controllerHost('form', (host) => host.close())
  const detail = controllerHost('detail', (host) => host.close())
  await mount()
  await act(async () => form.show())
  await settle()
  expect(view()).toBe('add')
  const depth = history.length
  // The controller closes the form and opens the detail in the same turn.
  await act(async () => {
    form.close()
    detail.dataset.item = 'a'
    detail.show()
  })
  await settle()
  await settle()
  expect(view()).toBe('item:a')
  expect(history.length).toBe(depth)
  expect(document.querySelector('[data-testid="push-page-add"]')).toBeNull()
})

it('keeps a completed check until its review route commits, then respects a real back step', async () => {
  const cancelReview = vi.fn()
  const navigation = {
    stack: ['add-plugin'],
    open: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    backTo: vi.fn(),
    finish: vi.fn(),
    reset: vi.fn(),
  }
  const readNavigation = vi.spyOn(ui, 'usePushStack').mockImplementation(() => ({ ...navigation }))
  const view = {
    state: { loading: false },
    review: { preview: { id: '@fixture/checked', source: { type: 'file' } }, mode: 'install' },
    t: (key: string) => key,
    cancelReview,
  } as unknown as PluginView
  root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = () => act(async () => root?.render(createElement(InstallReviewPage, { view })))
  try {
    await render()
    // A controller update can arrive while React still exposes the preceding route snapshot.
    navigation.stack = ['add-plugin']
    await render()
    expect(cancelReview).not.toHaveBeenCalled()
    expect(navigation.replace).toHaveBeenCalledWith('install:@fixture/checked')
    navigation.stack = ['install:@fixture/checked']
    await render()
    expect(cancelReview).not.toHaveBeenCalled()
    navigation.stack = []
    await render()
    expect(cancelReview).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root?.unmount())
    root = undefined
    readNavigation.mockRestore()
  }
})
