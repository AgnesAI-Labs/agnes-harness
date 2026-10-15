/** @vitest-environment happy-dom */
import { clearResources, TopProgress } from '@agnes/web-ui'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { usePageProgress } from '../src/pages/plugins/admin-view.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  clearResources()
  document.body.replaceChildren()
})

function Reader({ loading }: { loading: boolean }) {
  usePageProgress(loading)
  return null
}
const bar = () => document.querySelector('[data-testid="top-progress"]')?.hasAttribute('data-active')
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

it("moves the top bar while a controller's read runs, and stops it when the read settles or the page leaves", async () => {
  root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = (loading: boolean, shown = true) =>
    act(async () =>
      root?.render(
        createElement(
          Fragment,
          null,
          createElement(TopProgress),
          shown && createElement(Reader, { loading }),
        ),
      ),
    )
  await render(false)
  expect(bar()).toBe(false)
  await render(true)
  expect(bar()).toBe(true)
  await render(false)
  await settle()
  expect(bar()).toBe(false)
  await render(true)
  expect(bar()).toBe(true)
  await render(true, false)
  await settle()
  expect(bar()).toBe(false)
})
