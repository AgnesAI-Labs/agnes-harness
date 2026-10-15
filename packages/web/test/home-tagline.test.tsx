/** @vitest-environment happy-dom */

import { AnimatedTagline } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const text = '以可信为根基，为真实世界而生。'
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('introduces each character once and replaces every animated span with visible plain text before the sheen', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AnimatedTagline, { text })))
    const tag = host.firstElementChild as HTMLElement
    expect(tag.dataset.phase).toBe('intro')
    expect(tag.getAttribute('aria-label')).toBe(text)
    expect(tag.children).toHaveLength(Array.from(text).length)
    expect([...tag.children].every((char) => char.getAttribute('aria-hidden') === 'true')).toBe(true)
    await act(async () => vi.advanceTimersByTime(500))
    await act(async () => root.render(createElement(AnimatedTagline, { text })))
    await act(async () => vi.advanceTimersByTime(800))
    expect(tag.dataset.phase).toBe('sheen')
    expect(tag.children).toHaveLength(0)
    expect(tag.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(tag.textContent).toBe(text)
    expect(tag.hidden).toBe(false)
    expect(getComputedStyle(tag).display).not.toBe('none')
    expect(getComputedStyle(tag).visibility).not.toBe('hidden')
    expect(tag.hasAttribute('aria-label')).toBe(false)
    await act(async () => root.render(createElement(AnimatedTagline, { text })))
    await act(async () => vi.advanceTimersByTime(10000))
    expect(tag.children).toHaveLength(0)
    expect(tag.textContent).toBe(text)
  } finally {
    await act(async () => root.unmount())
  }
})

it('renders a static sentence for reduced motion without intro or sheen', async () => {
  const original = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const media = original(query)
    Object.defineProperty(media, 'matches', { value: true })
    return media
  })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AnimatedTagline, { text })))
    expect(host.firstElementChild?.getAttribute('data-phase')).toBe('static')
    expect(host.firstElementChild?.children).toHaveLength(0)
    expect(host.textContent).toBe(text)
  } finally {
    await act(async () => root.unmount())
  }
})
