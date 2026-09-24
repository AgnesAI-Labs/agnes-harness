import { expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { Text } from '../../src/tui/component.js'
import { Box } from '../../src/tui/components/box.js'
import { fitLine } from '../../src/tui/components/line.js'
import { List } from '../../src/tui/components/list.js'
import { Loader } from '../../src/tui/components/loader.js'
import { Select } from '../../src/tui/components/select.js'
import { Renderer } from '../../src/tui/renderer.js'
import { displayWidth, FakeTerminal } from '../../src/tui/terminal.js'
import { screenOf } from './harness.js'

it('expands Box by default with exact borders and blocks hidden child input when collapsed', () => {
  const input = vi.fn(() => true)
  const child = Object.assign(new Text('body'), { handleInput: input })
  const box = new Box(child, { title: 'tool' })
  expect(box.render(10)).toEqual(['┌ tool ──┐', '│ body   │', '└────────┘'])
  expect(box.handleInput('1')).toBe(true)
  box.toggle()
  expect(box.render(10)).toEqual(['▸ tool    '])
  expect(box.handleInput('1')).toBe(false)
  expect(input).toHaveBeenCalledTimes(1)
})
it('bounds long titles and preserves styled child lines at narrow display widths', () => {
  const box = new Box(new Text(createAnsi('16').bold('中国long')), { title: 'very long title' })
  for (const width of [1, 2, 4, 5, 8, 20]) {
    const lines = box.render(width)
    expect(lines.every((line) => displayWidth(line) === width)).toBe(true)
  }
  expect(fitLine(createAnsi('16').bold('中国'), 4)).toBe('\x1b[1m中国\x1b[22m')
  expect(fitLine(createAnsi('16').bold('中国'), 3)).toBe('\x1b[1m中…\x1b[0m')
  expect(fitLine('élong', 2)).toBe('é…')
})
it('rounds Box corners on request and styles frame and title through the ansi tiers', () => {
  const plain = new Box(new Text('body'), { title: 'agnes', rounded: true })
  expect(plain.render(12)).toEqual(['╭ agnes ───╮', '│ body     │', '╰──────────╯'])
  plain.toggle()
  expect(plain.render(12)).toEqual(['▸ agnes     '])
  const ansi = createAnsi('256')
  const box = new Box(new Text('body'), {
    title: 'agnes',
    rounded: true,
    border: ansi.dim,
    titleStyle: (s) => ansi.fg(141, s),
  })
  const lines = box.render(12)
  expect(lines[0]).toBe(`\x1b[2m╭\x1b[22m\x1b[38;5;141m agnes \x1b[39m\x1b[2m───╮\x1b[22m`)
  expect(lines[1]).toBe(`\x1b[2m│\x1b[22m body     \x1b[2m│\x1b[22m`)
  expect(lines[2]).toBe(`\x1b[2m╰──────────╯\x1b[22m`)
  // The frame characters take the border style; the padding inside the body row does not.
  expect(box.render(12).every((line) => displayWidth(line) === 12)).toBe(true)
})
it('Select defaults to first option, clamps navigation, chooses digits and cancels', () => {
  const chosen = vi.fn()
  const cancel = vi.fn()
  const options = [
    { id: 'a', label: 'first' },
    { id: 'b', label: 'second' },
  ]
  const select = new Select({ options, onChoose: chosen, onCancel: cancel })
  if (options[0]) options[0].id = 'mutated'
  select.handleInput('\r')
  expect(chosen).toHaveBeenLastCalledWith('a')
  select.handleInput('\x1b[B')
  select.handleInput('\x1b[B')
  select.handleInput('\r')
  expect(chosen).toHaveBeenLastCalledWith('b')
  select.handleInput('1')
  expect(chosen).toHaveBeenLastCalledWith('a')
  select.handleInput('\x1b[A')
  select.handleInput('\r')
  expect(chosen).toHaveBeenLastCalledWith('a')
  select.handleInput('\x1b')
  expect(cancel).toHaveBeenCalledOnce()
  expect(select.handleInput('x')).toBe(false)
  expect(select.render(8).every((line) => displayWidth(line) === 8)).toBe(true)
})
it('empty Select consumes selection keys without a callback or crash', () => {
  const chosen = vi.fn()
  const select = new Select({ options: [], onChoose: chosen })
  for (const key of ['\r', '\x1b[A', '\x1b[B', '1', '9']) expect(select.handleInput(key)).toBe(true)
  expect(chosen).not.toHaveBeenCalled()
  expect(select.render(10)).toEqual([])
})
it('Select windows a long dynamic list around the active option', () => {
  const select = new Select({
    options: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), label: `model-${i + 1}` })),
    onChoose: vi.fn(),
    maxRows: () => 3,
  })
  for (let i = 0; i < 5; i++) select.handleInput('\x1b[B')
  const lines = select.render(20)
  expect(lines).toHaveLength(3)
  expect(lines[2]).toContain('▶ 6. model-6')
  expect(lines.join('\n')).not.toContain('model-1')
})
it('List snapshots its inputs and Loader uses explicit ticks with a terminal stopped frame', () => {
  const items = ['a', 'b']
  const list = new List(items)
  items[0] = 'changed'
  expect(list.render(4)).toEqual(['a   ', 'b   '])
  list.set(items)
  items[0] = 'again'
  expect(list.render(4)[0]).toBe('cha…')
  const loader = new Loader('thinking')
  expect(loader.render(20)[0]?.trimEnd()).toBe('⠋ thinking')
  loader.tick()
  expect(loader.render(20)[0]?.trimEnd()).toBe('⠙ thinking')
  loader.stop()
  loader.tick()
  loader.setLabel('done')
  expect(loader.render(20)[0]?.trimEnd()).toBe('✓ done')
})
it('paints a bordered component and routes actual terminal navigation into Select', async () => {
  const chosen = vi.fn()
  const select = new Select({
    options: [
      { id: 'a', label: 'one' },
      { id: 'b', label: 'two' },
    ],
    onChoose: chosen,
  })
  const term = new FakeTerminal({ columns: 20, rows: 6 })
  const renderer = new Renderer(term, new Box(select, { title: 'choose' }))
  renderer.start()
  try {
    term.feed('\x1b[B')
    term.feed('\r')
    expect(chosen).toHaveBeenCalledWith('b')
    await vi.waitFor(async () =>
      expect((await screenOf(term, 20, 6)).some((line) => line.includes('▶ 2. two'))).toBe(true),
    )
    expect((await screenOf(term, 20, 6))[0]).toBe('┌ choose ──────────┐')
  } finally {
    renderer.stop()
  }
})
it('Loader.hide renders zero rows until restart, and stop can replace the label', () => {
  const loader = new Loader('thinking')
  loader.hide()
  expect(loader.render(20)).toEqual([])
  // Hidden while ticking must still not crash and must still render nothing.
  loader.tick()
  expect(loader.render(20)).toEqual([])
  loader.restart('inference')
  expect(loader.render(20)[0]?.trimEnd()).toBe('⠋ inference')
  loader.tick()
  expect(loader.render(20)[0]?.trimEnd()).toBe('⠙ inference')
  // stop(finalLabel) replaces the label in the same call, unlike the existing stop()+setLabel
  // two-step the pre-existing test above exercises.
  loader.stop('turn 1 · 0.7s')
  expect(loader.render(20)[0]?.trimEnd()).toBe('✓ turn 1 · 0.7s')
  // A restart after stop must un-hide and reset to frame 0, not resume from wherever stop left it.
  loader.restart('tools')
  expect(loader.render(20)[0]?.trimEnd()).toBe('⠋ tools')
})
