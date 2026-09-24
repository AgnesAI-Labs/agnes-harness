import { expect, it, vi } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
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
    ansi: createAnsi('none'),
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
  expect(picker.handleInput('x')).toBe(true)
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
    ansi: createAnsi('none'),
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
