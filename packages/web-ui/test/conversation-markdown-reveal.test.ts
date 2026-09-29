/** @vitest-environment happy-dom */
import { ConversationMarkdown } from '@agnes/web-ui/assistant-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let host: HTMLDivElement
let root: Root
let now: number
let reduced: boolean
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  now = 0
  reduced = false
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: reduced }) as MediaQueryList)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  document.getSelection()?.removeAllRanges()
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const render = (source: string, streaming = true) =>
  act(async () => root.render(createElement(ConversationMarkdown, { source, streaming, part: 'body' })))
const fades = () => [...host.querySelectorAll<HTMLElement>('.message-reveal-fragment')]
it('animates only appended text, retaining old nodes and the original animation time', async () => {
  await render('old')
  expect(fades()).toHaveLength(0)
  const paragraph = host.querySelector('p')
  const oldText = paragraph?.firstChild
  now = 20
  await render('old new')
  expect(fades().map((x) => x.textContent)).toEqual([' new'])
  const first = fades()[0]
  expect(first?.style.animationDuration).toBe('480ms')
  const initialStyle = first?.getAttribute('style')
  now = 90
  await render('old new tail')
  expect(host.querySelector('p')).toBe(paragraph)
  expect(paragraph?.firstChild).toBe(oldText)
  expect(fades()[0]).toBe(first)
  expect(first?.getAttribute('style')).toBe(initialStyle)
  expect(fades().map((x) => x.textContent)).toEqual([' new', ' tail'])
  await render('old new tail')
  expect(fades()[0]).toBe(first)
  now = 600
  await render('old new tail done')
  expect(fades().map((x) => x.textContent)).toEqual([' done'])
  expect(host.querySelector('p')?.textContent).toBe('old new tail done')
})
it('uses semantic output offsets across formatting closure and a new block', async () => {
  await render('old')
  await render('old **bold**\n\nnew paragraph')
  expect(
    fades()
      .map((x) => x.textContent)
      .join(''),
  ).toBe(' boldnew paragraph')
  expect(host.querySelector('strong')?.textContent).toBe('bold')
  expect(host.querySelectorAll('p')).toHaveLength(2)
})
it('does not fade history, replacements, terminal snapshots, hidden content or reduced motion', async () => {
  await render('history', false)
  await render('history updated', false)
  expect(fades()).toHaveLength(0)
  await render('replacement')
  expect(fades()).toHaveLength(0)
  reduced = true
  await render('replacement reduced')
  expect(fades()).toHaveLength(0)
  reduced = false
  host.hidden = true
  await render('replacement reduced hidden')
  expect(fades()).toHaveLength(0)
  host.hidden = false
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await render('replacement reduced hidden background')
  expect(fades()).toHaveLength(0)
})
it('flushes selection-deferred suffixes directly and resumes with the next delta', async () => {
  await render('old')
  const range = document.createRange()
  range.selectNodeContents(host.querySelector('p') ?? host)
  document.getSelection()?.addRange(range)
  await render('old backlog')
  expect(host.querySelector('p')?.textContent).toBe('old')
  await act(async () => {
    document.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(host.querySelector('p')?.textContent).toBe('old backlog')
  expect(fades()).toHaveLength(0)
  await render('old backlog live')
  expect(fades().map((x) => x.textContent)).toEqual([' live'])
})
it('bounds ranges, text, traversal and intersections and never splits a surrogate pair', async () => {
  let source = 'a'
  await render(source)
  for (let i = 0; i < 40; i++) {
    source += 'b'
    await render(source)
  }
  expect(fades()).toHaveLength(32)
  expect(host.querySelector('p')?.textContent).toBe(source)
  await render('x'.repeat(65536))
  await render(`${'x'.repeat(65536)}y`)
  expect(fades()).toHaveLength(0)
  await render('prefix')
  await render(`prefix ${'**x** '.repeat(2100)}`)
  expect(fades()).toHaveLength(0)
  await render('prefix')
  await render(`prefix ${'**x** '.repeat(130)}`)
  expect(fades()).toHaveLength(0)
  await render('prefix \uD83D')
  await render('prefix 😀')
  expect(fades()).toHaveLength(0)
  await render('prefix 😀 suffix')
  expect(fades().map((x) => x.textContent)).toEqual([' suffix'])
})
it('animates the first delta after an empty mounted message and resets after clearing content', async () => {
  await render('')
  await render('first live')
  expect(fades().map((x) => x.textContent)).toEqual(['first live'])
  await render('', false)
  expect(host.textContent).toBe('')
  await render('first live again')
  expect(host.querySelector('p')?.textContent).toBe('first live again')
  expect(fades().map((x) => x.textContent)).toEqual(['first live again'])
})
it('does not animate the backlog on copy-focus release and excludes copy/language controls', async () => {
  await render('```ts\ncode\n```')
  const copy = host.querySelector<HTMLButtonElement>('.code-copy')
  expect(copy).not.toBeNull()
  await act(async () => copy?.focus())
  await render('```ts\ncode\n```\n\nbacklog')
  expect(host.textContent).not.toContain('backlog')
  await act(async () => {
    copy?.blur()
    await Promise.resolve()
  })
  expect(host.textContent).toContain('backlog')
  expect(fades()).toHaveLength(0)
  await render('```ts\ncode\n```\n\nbacklog live')
  expect(fades().map((x) => x.textContent)).toEqual([' live'])
  expect(host.querySelector('.code-toolbar .message-reveal-fragment')).toBeNull()
})
it('keeps literal HTML readable while revealing its newly appended suffix', async () => {
  await render('plain')
  await render('plain \\<img src="https://example.test/a">')
  expect(host.querySelector('p')?.textContent).toBe('plain <img src="https://example.test/a">')
  expect(
    fades()
      .map((x) => x.textContent)
      .join(''),
  ).toBe(' <img src="https://example.test/a">')
  expect(host.querySelector('img,a')).toBeNull()
})
it('treats forged reveal attributes and ownership tags as user text', async () => {
  const source =
    '<agnes-reveal-root data-agnes-plan="broken">literal owner</agnes-reveal-root>\n\n<span data-agnes-pieces="broken">literal leaf</span>'
  await render(source, false)
  expect(host.textContent).toContain(
    '<agnes-reveal-root data-agnes-plan="broken">literal owner</agnes-reveal-root>',
  )
  expect(host.textContent).toContain('<span data-agnes-pieces="broken">literal leaf</span>')
  expect(host.querySelector('[data-agnes-plan],[data-agnes-pieces],agnes-reveal-root')).toBeNull()
  expect(fades()).toHaveLength(0)
})
