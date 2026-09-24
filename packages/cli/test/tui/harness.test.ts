import { expect, it } from 'vitest'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { emulate } from './harness.js'

it('separates visible rows from terminal scrollback after the screen scrolls', async () => {
  const term = new FakeTerminal({ columns: 20, rows: 3 })
  term.write('history\r\none\r\ntwo\r\nthree')
  const screen = await emulate(term, 20, 3)
  expect(screen.scrollback).toEqual(['history'])
  expect(screen.lines).toEqual(['one', 'two', 'three'])
})
