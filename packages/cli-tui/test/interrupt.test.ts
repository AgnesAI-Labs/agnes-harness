import { afterEach, expect, it, vi } from 'vitest'
import { DoubleCtrlC } from '../src/interrupt.js'

afterEach(() => {
  vi.useRealTimers()
})

it('a second Ctrl-C quits within a second even when the cancel never settles', async () => {
  vi.useFakeTimers()
  const interrupts = new DoubleCtrlC()
  const quit = vi.fn()
  const hung = () => new Promise<void>(() => {})
  interrupts.press(hung, quit, () => {})
  interrupts.press(hung, quit, () => {})
  await vi.advanceTimersByTimeAsync(999)
  expect(quit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(quit).toHaveBeenCalledOnce()
})

it('a second Ctrl-C quits once, as soon as the cancel settles', async () => {
  vi.useFakeTimers()
  const interrupts = new DoubleCtrlC()
  const quit = vi.fn()
  const fail = vi.fn()
  interrupts.press(async () => {}, quit, fail)
  await vi.advanceTimersByTimeAsync(0)
  expect(quit).not.toHaveBeenCalled()
  interrupts.press(async () => Promise.reject(new Error('gone')), quit, fail)
  await vi.advanceTimersByTimeAsync(0)
  expect(quit).toHaveBeenCalledOnce()
  expect(fail).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(quit).toHaveBeenCalledOnce()
})
