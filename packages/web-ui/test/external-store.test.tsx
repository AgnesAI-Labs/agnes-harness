/** @vitest-environment happy-dom */

import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { createExternalStore, useStoreSelector } from '../src/external-store.js'

it('does not rerender an unchanged selector, including custom equality for object selections', () => {
  const store = createExternalStore({ title: 'Task', progress: 0 })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let titleRenders = 0
  let progressRenders = 0
  function Title() {
    const selected = useStoreSelector(
      store,
      (state) => ({ title: state.title }),
      (a, b) => a.title === b.title,
    )
    titleRenders++
    return <h2>{selected.title}</h2>
  }
  function Progress() {
    progressRenders++
    return <p>{useStoreSelector(store, (state) => state.progress)}</p>
  }
  flushSync(() =>
    root.render(
      <>
        <Title />
        <Progress />
      </>,
    ),
  )
  const initialTitles = titleRenders
  const initialProgress = progressRenders
  flushSync(() => store.set({ title: 'Task', progress: 50 }))
  expect(titleRenders).toBe(initialTitles)
  expect(progressRenders).toBe(initialProgress + 1)
  expect(host.textContent).toBe('Task50')
  flushSync(() => store.set({ title: 'Renamed', progress: 50 }))
  expect(titleRenders).toBe(initialTitles + 1)
  expect(progressRenders).toBe(initialProgress + 1)
  root.unmount()
  host.remove()
})

it('coalesces frame notifications, exposes the latest snapshot immediately, and supports synchronous flush', () => {
  let nextFrame: FrameRequestCallback | undefined
  let notifications = 0
  let scheduled = 0
  let canceled = 0
  const store = createExternalStore(0, {
    notify: 'animation-frame',
    requestFrame(callback) {
      nextFrame = callback
      return ++scheduled
    },
    cancelFrame() {
      canceled++
    },
  })
  const unsubscribe = store.subscribe(() => {
    notifications++
  })
  store.set(1)
  store.set(2)
  store.set(3)
  expect(store.getSnapshot()).toBe(3)
  expect(scheduled).toBe(1)
  expect(notifications).toBe(0)
  nextFrame?.(0)
  expect(notifications).toBe(1)
  store.set(4)
  store.set(5)
  store.flush()
  expect(notifications).toBe(2)
  expect(canceled).toBe(1)
  nextFrame?.(0)
  expect(notifications).toBe(2)
  unsubscribe()
  store.set(6)
  store.flush()
  expect(notifications).toBe(2)
})
