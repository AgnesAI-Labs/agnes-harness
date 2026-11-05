/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserFixture } from './fresh-browser-fixture.js'

let page: ReturnType<typeof createBrowserFixture> | undefined
afterEach(async () => {
  await page?.close()
  page = undefined
})

it('destroys the owned document and restores browser globals after an idempotent close', async () => {
  const original = document
  const names = ['document', 'window', 'self', 'top', 'parent', 'File', 'URL', 'fetch', 'happyDOM']
  const descriptors = names.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))
  page = createBrowserFixture()
  const owned = document
  expect(owned).not.toBe(original)
  const listener = vi.fn()
  owned.addEventListener('fixture-check', listener)
  owned.dispatchEvent(new Event('fixture-check'))
  expect(listener).toHaveBeenCalledTimes(1)
  const closing = page.close()
  expect(page.close()).toBe(closing)
  await closing
  expect(document).toBe(original)
  expect(names.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(descriptors)
  owned.dispatchEvent(new Event('fixture-check'))
  expect(listener).toHaveBeenCalledTimes(1)
})

it('starts the next page with a different document and independent persisted browser state', async () => {
  page = createBrowserFixture()
  const first = document
  localStorage.setItem('fixture-value', 'old page')
  await page.close()
  page = createBrowserFixture()
  expect(document).not.toBe(first)
  expect(localStorage.getItem('fixture-value')).toBeNull()
})
