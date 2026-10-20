import { expect, it } from 'vitest'
import { clampRightWidth, maxRightWidth, RIGHT_DEFAULT, RIGHT_MIN } from '../src/workbench/dock-size.js'

it('lets the side dock grow until the conversation is down to its minimum column', () => {
  // A 1440px window with a 260px sidebar leaves a 1180px main column.
  expect(maxRightWidth(1180)).toBe(760)
  expect(clampRightWidth(RIGHT_DEFAULT, maxRightWidth(1180))).toBe(720)
  expect(clampRightWidth(RIGHT_DEFAULT, maxRightWidth(1020))).toBe(600)
  expect(maxRightWidth(1920 - 260)).toBe(1240)
})

it('never offers less than the minimum width, however narrow the window', () => {
  expect(maxRightWidth(500)).toBe(RIGHT_MIN)
  expect(maxRightWidth(0)).toBe(RIGHT_MIN)
})

it('keeps a chosen width inside the current limits without forgetting whole pixels', () => {
  expect(clampRightWidth(900, 760)).toBe(760)
  expect(clampRightWidth(100, 760)).toBe(RIGHT_MIN)
  expect(clampRightWidth(512.4, 760)).toBe(512)
})
