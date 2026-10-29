/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ReceiptSummary } from '../src/intelligent-ui/surface.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function mount(text: string) {
  const host = document.body.appendChild(document.createElement('div'))
  act(() => createRoot(host).render(createElement(ReceiptSummary, { text })))
  return host
}

it('shows a JSON receipt as a formatted block with a copy action, not as running text', () => {
  const host = mount('{"receipt":{"status":"simulated-approved","posted":false}}')
  const block = host.querySelector('[data-testid="ui-receipt-data"]')
  expect(block?.querySelector('pre')?.textContent).toBe(
    JSON.stringify({ receipt: { status: 'simulated-approved', posted: false } }, null, 2),
  )
  expect(block?.querySelector('button.agh-copy')).not.toBeNull()
  expect(host.querySelector('p')).toBeNull()
})

it('leaves a sentence, or text that only looks like JSON, as the paragraph it was', () => {
  expect(mount('Posted 3 entries.').querySelector('p')?.textContent).toBe('Posted 3 entries.')
  const broken = mount('{not json')
  expect(broken.querySelector('p')?.textContent).toBe('{not json')
  expect(broken.querySelector('[data-testid="ui-receipt-data"]')).toBeNull()
})
