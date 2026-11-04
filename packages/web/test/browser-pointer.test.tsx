/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useBrowserPointer } from '../../package-manager/bundled-plugins/browser/src/browser-interaction.js'

it('maps drag coordinates, bounds movement, preserves ordinary clicks and cancels on blur', () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const sent: Record<string, string | number>[] = [],
    clicked = vi.fn()
  function Screen() {
    const pointer = useBrowserPointer({
      enabled: true,
      pageId: 'page',
      width: () => 1000,
      height: () => 800,
      send: (input) => sent.push(input),
      interact: (input) => sent.push(input),
    })
    return createElement('canvas', {
      onPointerDown: pointer.onPointerDown,
      onPointerMove: pointer.onPointerMove,
      onPointerUp: pointer.onPointerUp,
      onPointerCancel: pointer.onPointerCancel,
      onLostPointerCapture: pointer.onLostPointerCapture,
      onClick: () => {
        if (!pointer.consumeClick()) clicked()
      },
    })
  }
  const host = document.createElement('div'),
    root = createRoot(host)
  flushSync(() => root.render(createElement(Screen)))
  const canvas = host.querySelector('canvas')!
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400 }) as DOMRect
  canvas.setPointerCapture = vi.fn()
  canvas.hasPointerCapture = () => true
  canvas.releasePointerCapture = vi.fn()
  const pointer = (type: string, x: number, y: number) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        isPrimary: true,
        pointerId: 1,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    )
  try {
    pointer('pointerdown', 10, 20)
    for (let i = 0; i < 100; i++) pointer('pointermove', 30 + i, 40)
    pointer('pointerup', 140, 50)
    canvas.click()
    expect(sent[0]).toMatchObject({ type: 'pointer', phase: 'down', x: 20, y: 40 })
    expect(sent.at(-1)).toMatchObject({ type: 'pointer', phase: 'up', x: 280, y: 100 })
    expect(sent.length).toBeLessThanOrEqual(3)
    expect(clicked).not.toHaveBeenCalled()
    pointer('pointerdown', 10, 20)
    pointer('pointerup', 10, 20)
    canvas.click()
    expect(clicked).toHaveBeenCalledTimes(1)
    pointer('pointerdown', 10, 20)
    pointer('pointermove', 50, 50)
    window.dispatchEvent(new Event('blur'))
    expect(sent.at(-1)).toMatchObject({ type: 'pointer', phase: 'cancel' })
  } finally {
    flushSync(() => root.unmount())
    vi.useRealTimers()
  }
})
