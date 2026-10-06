/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 */

// happy-dom enforces neither sandbox nor CSP, and its page loading is off here so no test reaches
// the network (it prints one notice per refused load). These tests drive the frame's load events
// and stand in for its window; the policies themselves are real-browser evidence.
import { RuntimeClientTransportPolicy } from '@agnes/protocol/gen/runtime-client-transport'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  HtmlViewer,
  type HtmlViewerProps,
  type HtmlViewerRequest,
  htmlViewerRefusal,
} from '../src/conversation/html-viewer.js'
import { zhT } from './locale.js'

const VIEWER = '/__agnes/viewer/html'
const MAX = RuntimeClientTransportPolicy.maxRangeBytes

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.documentElement.className = ''
  vi.restoreAllMocks()
})

function viewerRequest(overrides: Record<string, unknown> = {}): HtmlViewerRequest {
  return {
    html: '<p>chart</p>',
    title: 'Chart',
    height: 240,
    scripts: false,
    ...overrides,
  } as HtmlViewerRequest
}

async function render(props: Partial<HtmlViewerProps> = {}) {
  await act(async () =>
    root.render(createElement(HtmlViewer, { request: viewerRequest(), viewerUrl: VIEWER, t: zhT, ...props })),
  )
}

function frame(): HTMLIFrameElement {
  const iframe = host.querySelector('iframe')
  if (!iframe) throw new Error('no viewer frame')
  return iframe
}

function standInWindow(iframe: HTMLIFrameElement) {
  const postMessage = vi.fn()
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { postMessage } })
  return postMessage
}

async function load(iframe: HTMLIFrameElement) {
  await act(async () => {
    iframe.dispatchEvent(new Event('load'))
  })
}

it('frames the viewer with only allow-scripts and posts the content once on the first load', async () => {
  host.style.setProperty('--agnes-text-primary', '#111')
  await render({ lang: 'zh-CN' })
  const iframe = frame()
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
  expect(iframe.sandbox.contains('allow-same-origin')).toBe(false)
  expect(iframe.getAttribute('allow')).toBe('')
  expect(iframe.getAttribute('src')).toBe(`${VIEWER}?scripts=0`)
  expect(iframe.getAttribute('title')).toBe('Chart')
  expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(iframe.style.height).toBe('240px')
  const postMessage = standInWindow(iframe)
  expect(postMessage).not.toHaveBeenCalled()
  await load(iframe)
  expect(postMessage.mock.calls).toEqual([
    [
      {
        kind: 'agnes.html-viewer/v1',
        html: '<p>chart</p>',
        lang: 'zh-CN',
        colorScheme: 'light',
        tokens: { '--agnes-text-primary': '#111' },
      },
      '*',
    ],
  ])
})

it('removes a frame that loads a second time, keeps the same content removed and frames new content', async () => {
  const onNavigatedAway = vi.fn()
  await render({ onNavigatedAway })
  const iframe = frame()
  const postMessage = standInWindow(iframe)
  await load(iframe)
  await load(iframe)
  expect(host.querySelector('iframe')).toBeNull()
  const notice = host.querySelector('[role="alert"]')
  expect(notice?.getAttribute('data-html-viewer-refused')).toBe('navigated')
  expect(notice?.textContent).toBe(zhT('htmlViewer.navigated'))
  expect(onNavigatedAway).toHaveBeenCalledTimes(1)
  expect(postMessage).toHaveBeenCalledTimes(1)
  // The same content, re-rendered or re-themed, is not loaded again to leave again.
  await render({ onNavigatedAway })
  await act(async () => document.documentElement.classList.add('dark'))
  expect(host.querySelector('iframe')).toBeNull()
  expect(host.querySelector('[role="alert"]')?.getAttribute('data-html-viewer-refused')).toBe('navigated')
  await render({ onNavigatedAway, request: viewerRequest({ html: '<p>next</p>' }) })
  expect(host.querySelector('[role="alert"]')).toBeNull()
  const next = frame()
  const nextPostMessage = standInWindow(next)
  await load(next)
  expect(nextPostMessage.mock.calls[0]?.[0]).toMatchObject({ html: '<p>next</p>', colorScheme: 'dark' })
  expect(onNavigatedAway).toHaveBeenCalledTimes(1)
})

it.each([
  ['the largest html', { html: 'x'.repeat(MAX) }, undefined],
  ['an oversized html', { html: 'x'.repeat(MAX + 1) }, 'invalid_request'],
  ['html oversized only in UTF-8 bytes', { html: '界'.repeat(Math.floor(MAX / 3) + 1) }, 'invalid_request'],
  ['a missing title', { title: undefined }, 'invalid_request'],
  ['an empty title', { title: '' }, 'invalid_request'],
  ['a title that is not text', { title: null }, 'invalid_request'],
  ['the longest title', { title: 'x'.repeat(256) }, undefined],
  ['a title over 256 UTF-8 bytes', { title: 'é'.repeat(129) }, 'invalid_request'],
  ['the lowest height', { height: 64 }, undefined],
  ['the highest height', { height: 4096 }, undefined],
  ['a height under 64', { height: 63 }, 'invalid_request'],
  ['a height over 4096', { height: 4097 }, 'invalid_request'],
  ['a fractional height', { height: 64.5 }, 'invalid_request'],
  ['a height as text', { height: '240' }, 'invalid_request'],
  ['a missing scripts flag', { scripts: undefined }, 'invalid_request'],
  ['a scripts flag as text', { scripts: 'false' }, 'invalid_request'],
  ['a URL field', { url: 'https://example.test/' }, 'invalid_request'],
  ['scripts without the host policy', { scripts: true }, 'scripts_not_allowed'],
] as const)('answers %s with %s', (_name, overrides, expected) => {
  const request = viewerRequest(overrides) as Record<string, unknown>
  for (const key of Object.keys(overrides))
    if ((overrides as Record<string, unknown>)[key] === undefined) delete request[key]
  expect(htmlViewerRefusal(request, false)).toBe(expected)
})

it('refuses a value that is not a request object', () => {
  for (const value of [null, undefined, [], 'html', 42])
    expect(htmlViewerRefusal(value, true)).toBe('invalid_request')
})

it('renders a refused request as a notice and never as a frame', async () => {
  const { title: _omitted, ...untitled } = viewerRequest()
  for (const [request, refusal] of [
    [untitled, 'invalid_request'],
    [viewerRequest({ html: 'x'.repeat(MAX + 1) }), 'invalid_request'],
    [viewerRequest({ scripts: true }), 'scripts_not_allowed'],
  ] as const) {
    await render({ request: request as HtmlViewerRequest })
    expect(host.querySelector('iframe')).toBeNull()
    const notice = host.querySelector('[role="alert"]')
    expect(notice?.getAttribute('data-html-viewer-refused')).toBe(refusal)
    expect(notice?.textContent).toBe(zhT('htmlViewer.unavailable'))
  }
})

it('runs content scripts only under a host policy that allows them', async () => {
  expect(htmlViewerRefusal(viewerRequest({ scripts: true }), true)).toBeUndefined()
  await render({ request: viewerRequest({ scripts: true }), allowScripts: true })
  const iframe = frame()
  expect(iframe.getAttribute('src')).toBe(`${VIEWER}?scripts=1`)
  expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
})

it('passes only allowlisted theme tokens with short, inert values', async () => {
  const style = host.style
  style.setProperty('--agnes-text-primary', '#111')
  style.setProperty('--agnes-color-white', '#fff')
  style.setProperty('--other-token', 'red')
  style.setProperty('--agnes-bg-page', '{ color: red; }')
  style.setProperty('--agnes-bg-card', 'a'.repeat(257))
  await render({ lang: 'zh_CN' })
  const iframe = frame()
  const postMessage = standInWindow(iframe)
  await load(iframe)
  expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
    lang: '',
    tokens: { '--agnes-text-primary': '#111' },
  })
  expect(Object.keys(postMessage.mock.calls[0]?.[0].tokens)).toEqual(['--agnes-text-primary'])
})

it('mounts a fresh frame for a theme switch or new content without reading it as navigation', async () => {
  const onNavigatedAway = vi.fn()
  await render({ onNavigatedAway, allowScripts: true })
  let previous = frame()
  const first = standInWindow(previous)
  await load(previous)
  // An equal request in a new render keeps the live frame and posts nothing more.
  await render({ onNavigatedAway, allowScripts: true })
  expect(frame()).toBe(previous)
  expect(first).toHaveBeenCalledTimes(1)
  for (const [change, expected] of [
    [() => document.documentElement.classList.add('dark'), { colorScheme: 'dark' }],
    [
      () => render({ onNavigatedAway, allowScripts: true, request: viewerRequest({ html: '<p>next</p>' }) }),
      { html: '<p>next</p>' },
    ],
    [
      () =>
        render({
          onNavigatedAway,
          allowScripts: true,
          request: viewerRequest({ html: '<p>next</p>', scripts: true }),
        }),
      { html: '<p>next</p>' },
    ],
  ] as const) {
    await act(async () => {
      await change()
    })
    const next = frame()
    expect(next).not.toBe(previous)
    const postMessage = standInWindow(next)
    await load(next)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject(expected)
    previous = next
  }
  expect(previous.getAttribute('src')).toBe(`${VIEWER}?scripts=1`)
  expect(onNavigatedAway).not.toHaveBeenCalled()
  expect(host.querySelector('[role="alert"]')).toBeNull()
})
