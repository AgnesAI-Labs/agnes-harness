/** @vitest-environment happy-dom */

import { FeedbackHost, mountRegion, type OperationFeedback, useStoreSelector } from '@agnes/web-ui'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createOperationFeedback } from '../src/operation-feedback.js'

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})
const result = (id: string, outcome: OperationFeedback['outcome'] = 'success'): OperationFeedback => ({
  id,
  scope: 'settings',
  outcome,
  message: 'Settings saved.',
})

it('dedupes IDs, keeps the newest result per scope and retains one consequence until its owner resolves it', () => {
  const feedback = createOperationFeedback()
  feedback.sink.publish(result('first', 'pending'))
  feedback.sink.publish(result('first'))
  feedback.sink.publish(result('first'))
  for (const outcome of ['unknown', 'partial', 'error'] as const)
    feedback.sink.publish(result(outcome, outcome))
  feedback.sink.publish({
    ...result('second'),
    effect: { kind: 'rescan-required', message: 'Rescan to load the folders.' },
  })
  feedback.sink.publish({
    ...result('third'),
    effect: { kind: 'rescan-required', message: 'Rescan the updated folders.' },
  })
  // Same scope: the later result replaces the earlier one in both lists.
  expect(feedback.store.getSnapshot().queue.map((item) => item.id)).toEqual(['third'])
  expect(feedback.store.getSnapshot().notices.map((item) => item.id)).toEqual(['third'])
  for (const id of ['first', 'second', 'third']) feedback.dismiss(id)
  expect(feedback.store.getSnapshot().queue).toEqual([])
  expect(feedback.store.getSnapshot().notices).toHaveLength(1)
  feedback.sink.resolve('other')
  expect(feedback.store.getSnapshot().notices).toHaveLength(1)
  feedback.sink.resolve('settings')
  expect(feedback.store.getSnapshot().notices).toEqual([])
})

it('shows one polite toast for 3 seconds without moving focus, then advances to the next scope', async () => {
  vi.useFakeTimers()
  const feedback = createOperationFeedback()
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const host = document.createElement('div')
  document.body.append(host)
  function Harness() {
    return createElement(FeedbackHost, {
      snapshot: useStoreSelector(feedback.store, (value) => value),
      onDismiss: feedback.dismiss,
    })
  }
  dispose = mountRegion(host, createElement(Harness))
  await act(async () => {
    feedback.sink.publish(result('a'))
    feedback.sink.publish({ ...result('b'), scope: 'other' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(document.activeElement).toBe(trigger)
  expect(document.querySelectorAll('.agh-toast')).toHaveLength(1)
  expect(document.querySelector('.agh-toast')?.getAttribute('aria-live')).toBe('polite')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2998)
  })
  expect(feedback.store.getSnapshot().queue.map((item) => item.id)).toEqual(['a', 'b'])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(feedback.store.getSnapshot().queue.map((item) => item.id)).toEqual(['b'])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(feedback.store.getSnapshot().queue).toEqual([])
  expect(document.activeElement).toBe(trigger)
})

it('replaces a pending toast from the same scope and restarts its 3 seconds', async () => {
  vi.useFakeTimers()
  const feedback = createOperationFeedback()
  const host = document.body.appendChild(document.createElement('div'))
  function Harness() {
    return createElement(FeedbackHost, {
      snapshot: useStoreSelector(feedback.store, (value) => value),
      onDismiss: feedback.dismiss,
    })
  }
  dispose = mountRegion(host, createElement(Harness))
  await act(async () => {
    feedback.sink.publish({ ...result('a'), message: 'deepseek-flash' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await act(async () => {
    feedback.sink.publish({ ...result('b'), message: 'agnes-3.0-flash' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(feedback.store.getSnapshot().queue.map((item) => item.id)).toEqual(['b'])
  expect(document.querySelectorAll('.agh-toast')).toHaveLength(1)
  expect(document.querySelector('.agh-toast')?.textContent).toContain('agnes-3.0-flash')
  // The replacement owns a fresh window; the first result's remaining time is not inherited.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2900)
  })
  expect(feedback.store.getSnapshot().queue.map((item) => item.id)).toEqual(['b'])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(feedback.store.getSnapshot().queue).toEqual([])
})

it('clears 启用插件后可使用 as soon as the plugin is set to enabled, before it is running', async () => {
  const { installFeedbackSink } = await import('@agnes/web-ui')
  const { PluginOperationFeedback } = await import('@agnes/web-admin/admin/plugins/operation-feedback')
  const feedback = createOperationFeedback()
  const release = installFeedbackSink(feedback.sink)
  const row = (desired: string, actual: string) =>
    [{ id: 'acme', desired, actual, metadata: { displayName: 'Acme' } }] as never
  const install = {
    operationId: 'install-1',
    operation: 'install',
    state: 'completed',
    packageId: 'acme',
  } as never
  const host = document.body.appendChild(document.createElement('div'))
  const render = (installed: never) =>
    createElement(PluginOperationFeedback, { operation: install, installed, onEnable() {} })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        createElement(PluginOperationFeedback, { operation: undefined, installed: [], onEnable() {} }),
      ),
    )
    await act(async () => root.render(render(row('installed-disabled', 'not-running'))))
    expect(feedback.store.getSnapshot().notices.map((item) => item.scope)).toEqual(['plugin-enable:acme'])
    await act(async () => root.render(render(row('enabled', 'starting'))))
    expect(feedback.store.getSnapshot().notices).toEqual([])
  } finally {
    await act(async () => root.unmount())
    release()
  }
})
