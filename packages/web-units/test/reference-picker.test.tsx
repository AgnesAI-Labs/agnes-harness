/** @vitest-environment happy-dom */
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerLocaleCatalog } from '../src/locales/composer.js'
import { createComposerReferences, ReferencePicker } from '../src/reference-picker.js'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('navigates a combobox, selects locators without submitting', async () => {
  const candidates = [
    { source: 'file', id: 'first.txt', label: 'First' },
    { source: 'session', id: 'previous', label: 'Previous' },
  ]
  const adapter = createComposerReferences(async () => ({ items: candidates, truncated: false }))
  const textarea = createRef<HTMLTextAreaElement>()
  const submit = vi.fn()
  const t = (key: string) => composerLocaleCatalog.en[key] ?? key
  await act(async () =>
    root.render(
      createElement(
        'form',
        { onSubmit: submit },
        createElement('textarea', { ref: textarea }),
        createElement(ReferencePicker, { textarea, adapter, t, disabled: false }),
      ),
    ),
  )
  const input = textarea.current!
  const query = async (value: string) => {
    await act(async () => {
      input.value = value
      input.setSelectionRange(value.length, value.length)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120)
    })
  }
  const key = async (name: string) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    await act(async () => {
      input.dispatchEvent(event)
    })
    return event
  }
  await query('@')
  expect(input.getAttribute('role')).toBe('combobox')
  expect(input.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(input.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('listbox')
  await key('ArrowDown')
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('Previous')
  expect((await key('Enter')).defaultPrevented).toBe(true)
  expect(adapter.getSnapshot()).toEqual([candidates[1]])
  expect(input.value).toBe('')
  expect(submit).not.toHaveBeenCalled()
  await query('@file')
  await key('Escape')
  expect(input.hasAttribute('aria-controls')).toBe(false)
  await act(async () => adapter.remove('session', 'previous'))
  expect(host.querySelector('[data-testid="reference-draft-chips"]')).toBeNull()
})

it('bounds and deduplicates draft references and refuses stale search results after a scope change', async () => {
  let resolve!: (value: { items: []; truncated: false }) => void
  let entered!: () => void
  const started = new Promise<void>((done) => {
    entered = done
  })
  const adapter = createComposerReferences(
    () =>
      new Promise((done) => {
        resolve = done
        entered()
      }),
  )
  for (let id = 0; id < 8; id++)
    expect(adapter.select({ source: 'file', id: String(id), label: String(id) })).toBe(true)
  expect(adapter.select({ source: 'file', id: 'overflow', label: 'Overflow' })).toBe(false)
  const pending = adapter.search('file')
  const rejected = expect(pending).rejects.toThrow('scope changed')
  await started
  adapter.clear()
  resolve({ items: [], truncated: false })
  await rejected
  adapter.restore([
    { source: 'file', id: 'same', label: 'Same' },
    { source: 'file', id: 'same', label: 'Same' },
  ])
  expect(adapter.getSnapshot()).toHaveLength(1)
})
