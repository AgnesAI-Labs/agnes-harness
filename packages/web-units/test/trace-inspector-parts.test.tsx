/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TraceCode } from '../src/trace-inspector-parts.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function mount(value: string, copyValue?: string) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  act(() =>
    root.render(
      createElement(TraceCode, { label: 'JSON', value, ...(copyValue === undefined ? {} : { copyValue }) }),
    ),
  )
  return host
}

it('shows a short block whole, without a fold control', () => {
  const host = mount('{\n  "path": "report.md"\n}')
  expect(host.querySelector('.trace-code')?.hasAttribute('data-folded')).toBe(false)
  expect(host.querySelector('.trace-code-fold')).toBeNull()
})

it('folds a long block but keeps all of its text in the document, and unfolds on request', () => {
  const value = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
  const host = mount(value)
  const fold = host.querySelector<HTMLButtonElement>('.trace-code-fold')
  expect(host.querySelector('.trace-code')?.getAttribute('data-folded')).toBe('true')
  expect(host.querySelector('.trace-pre')?.textContent).toBe(value)
  expect(fold?.getAttribute('aria-expanded')).toBe('false')
  act(() => fold?.click())
  expect(host.querySelector('.trace-code')?.hasAttribute('data-folded')).toBe(false)
  expect(host.querySelector('.trace-code-fold')?.getAttribute('aria-expanded')).toBe('true')
})

it('copies the value it was given to copy, not the formatted text on screen', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const host = mount('{\n  "a": 1\n}', '{"a":1}')
  await act(async () => host.querySelector<HTMLButtonElement>('.trace-code-copy')?.click())
  expect(writeText).toHaveBeenCalledWith('{"a":1}')
})
