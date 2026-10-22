import { expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { TuiTheme } from '../../src/tui/theme.js'
import { SessionPicker } from '../../src/tui/views/session-picker.js'

const choices = [
  {
    sessionId: 'agnes:local:default:cli:session:new',
    createdAt: '2026-09-13T13:45:00Z',
    lastSeq: 22,
    preset: 'standard',
    title: 'Release review',
  },
  {
    sessionId: 'agnes:local:default:cli:session:old',
    createdAt: '2026-09-12T08:30:00Z',
    lastSeq: 9,
    preset: 'claw',
  },
]

it('renders session metadata, owns input, chooses by key and cancels without choosing', () => {
  const chosen = vi.fn()
  const changed = vi.fn()
  const picker = new SessionPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 8,
    onChoose: chosen,
    changed,
  })
  expect(picker.render(50)).toEqual([])
  expect(picker.handleInput('x')).toBe(false)

  picker.show(choices)
  const rendered = picker.render(160).join('\n')
  expect(rendered).toContain('Select Session')
  expect(rendered).toContain('2026-09-13 13:45Z · Release review · standard · seq 22')
  expect(rendered).toContain(choices[0]?.sessionId)
  expect(picker.handleInput('\t')).toBe(true)
  picker.handleInput('\x1b[B')
  picker.handleInput('\r')
  expect(chosen).toHaveBeenCalledWith(choices[1])
  expect(picker.open).toBe(false)

  picker.show(choices)
  picker.handleInput('\x1b')
  expect(chosen).toHaveBeenCalledTimes(1)
  expect(picker.render(50)).toEqual([])
  expect(changed).toHaveBeenCalledTimes(4)
})

it('keeps selection over a bounded viewport and sanitizes/clips remote labels', () => {
  const chosen = vi.fn()
  const picker = new SessionPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    maxRows: () => 5,
    onChoose: chosen,
    changed: () => {},
  })
  picker.show([
    ...choices,
    {
      sessionId: 'session-three',
      createdAt: '',
      lastSeq: 3,
      preset: 'standard\x1b]52;c;unsafe\x07',
    },
  ])
  picker.handleInput('\x1b[B')
  picker.handleInput('\x1b[B')
  const rendered = picker.render(32)
  expect(rendered.length).toBeLessThanOrEqual(4)
  expect(rendered.join('\n')).not.toContain('\x1b]52')
  expect(rendered.join('\n')).toContain('3. time unknown')
  picker.handleInput('3')
  expect(chosen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-three' }))
})

it('types to filter by title, id or time; digits pick only while the filter is empty; esc clears before it closes', () => {
  const chosen = vi.fn()
  const picker = new SessionPicker({
    ansi: new TuiTheme().ansi(createAnsi('none')),
    locale: 'zh-CN',
    maxRows: () => 8,
    onChoose: chosen,
    changed: vi.fn(),
  })
  picker.show(choices)
  expect(picker.render(160).join('\n')).not.toContain('过滤')
  for (const ch of 'RELEASE') picker.handleInput(ch)
  let text = picker.render(160).join('\n')
  expect(text).toContain('过滤：RELEASE（1/2）')
  expect(text).toContain('Release review')
  expect(text).not.toContain('session:old')
  picker.handleInput('\x7f')
  expect(picker.render(160).join('\n')).toContain('过滤：RELEAS（1/2）')
  // The id counts too, and a digit typed into the filter is text, not a quick pick.
  picker.handleInput('\x1b')
  expect(picker.open).toBe(true)
  for (const ch of ':old') picker.handleInput(ch)
  text = picker.render(160).join('\n')
  expect(text).toContain('（1/2）')
  expect(text).toContain('session:old')
  expect(text).not.toContain('Release review')
  picker.handleInput('0')
  expect(picker.render(160).join('\n')).toContain('过滤：:old0（0/2）')
  picker.handleInput('1')
  expect(chosen).not.toHaveBeenCalled()
  picker.handleInput('\x1b')
  expect(picker.open).toBe(true)
  expect(picker.render(160).join('\n')).not.toContain('过滤')
  picker.handleInput('2')
  expect(chosen).toHaveBeenCalledWith(choices[1])
  picker.show(choices)
  picker.handleInput('\x1b')
  expect(picker.open).toBe(false)
})
