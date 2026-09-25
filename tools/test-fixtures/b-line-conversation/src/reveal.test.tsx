import { act, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMarkdownRenderer, type MarkdownRenderer } from '../../../../packages/web/src/markdown.js'

function MarkdownHost({
  source,
  streaming = true,
  marker = 'a',
}: {
  source: string
  streaming?: boolean
  marker?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRef<MarkdownRenderer | undefined>(undefined)
  const initialSource = useRef(source)
  useLayoutEffect(() => {
    if (!host.current) return
    renderer.current = createMarkdownRenderer(host.current, initialSource.current)
    return () => {
      renderer.current?.dispose()
      renderer.current = undefined
    }
  }, [])
  useLayoutEffect(() => renderer.current?.update(source), [source])
  return (
    <article className="assistant" data-streaming={String(streaming)} data-marker={marker}>
      <div ref={host} />
    </article>
  )
}

let container: HTMLDivElement
let root: Root
let now = 0
let reducedMotion = false

const render = async (source: string, options: { streaming?: boolean; marker?: string } = {}) => {
  await act(async () => root.render(<MarkdownHost source={source} {...options} />))
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  now = 0
  reducedMotion = false
  vi.spyOn(window.performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.getSelection()?.removeAllRanges()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('B-0 / S3 current text reveal inside a stable React shell', () => {
  it('animates only appended suffixes for 480ms and keeps stable text and prior animation nodes', async () => {
    await render('hello')
    const paragraph = container.querySelector('p')
    expect(container.querySelector('.message-reveal-fragment')).toBeNull()
    now = 100
    await render('hello world')
    const first = container.querySelector<HTMLElement>('.message-reveal-fragment')
    expect(container.querySelector('p')).toBe(paragraph)
    expect(first?.textContent).toBe(' world')
    expect(first?.style.animationDuration).toBe('480ms')
    now = 180
    await render('hello world', { marker: 'unrelated-parent-update' })
    expect(container.querySelector('.message-reveal-fragment')).toBe(first)
    now = 200
    await render('hello world again')
    const fragments = Array.from(container.querySelectorAll<HTMLElement>('.message-reveal-fragment'))
    expect(container.querySelector('p')).toBe(paragraph)
    expect(fragments.map((item) => item.textContent)).toEqual([' world', ' again'])
    expect(fragments[0]).toBe(first)
    expect(container.querySelector('p')?.textContent).toBe('hello world again')
  })

  it('does not animate initial history, background updates or reduced-motion updates', async () => {
    await render('history')
    expect(container.querySelector('.message-reveal-fragment')).toBeNull()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await render('history background')
    expect(container.querySelector('p')?.textContent).toBe('history background')
    expect(container.querySelector('.message-reveal-fragment')).toBeNull()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    reducedMotion = true
    await render('history background reduced')
    expect(container.querySelector('p')?.textContent).toBe('history background reduced')
    expect(container.querySelector('.message-reveal-fragment')).toBeNull()
  })

  it('defers a selected block and shows the accumulated update without a delayed animation', async () => {
    await render('selected')
    const paragraph = container.querySelector('p')
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(paragraph ?? container)
    selection?.addRange(range)
    await render('selected more')
    expect(container.querySelector('p')).toBe(paragraph)
    expect(paragraph?.textContent).toBe('selected')
    selection?.removeAllRanges()
    await act(async () => document.dispatchEvent(new Event('selectionchange')))
    expect(container.querySelector('p')?.textContent).toBe('selected more')
    expect(container.querySelector('.message-reveal-fragment')).toBeNull()
  })

  it('keeps code-copy controls stable and defers focused code changes without animating controls', async () => {
    await render('intro\n\n```ts\nconst old = 1\n```')
    const copy = container.querySelector<HTMLButtonElement>('.code-copy')
    const code = container.querySelector('pre code')
    copy?.focus()
    await render('intro\n\n```ts\nconst next = 2\n```')
    expect(container.querySelector('.code-copy')).toBe(copy)
    expect(container.querySelector('pre code')).toBe(code)
    expect(code?.textContent).toBe('const old = 1')
    copy?.blur()
    await act(async () => document.dispatchEvent(new Event('focusout')))
    expect(container.querySelector('pre code')?.textContent).toBe('const next = 2')
    expect(container.querySelector('.code-block .message-reveal-fragment')).toBeNull()
  })
})
