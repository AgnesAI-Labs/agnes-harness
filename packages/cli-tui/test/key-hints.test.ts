import { describe, expect, it } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import { keyHints } from '../src/components/key-hints.js'
import { TuiTheme } from '../src/theme.js'

const PLAIN = new TuiTheme('mono').ansi(createAnsi('none'))
const COLOUR = new TuiTheme('dark').ansi(createAnsi('truecolor'))
const HINTS = [
  { key: '↑↓', label: 'select' },
  { key: '⏎', label: 'confirm' },
  { key: 'tab', label: 'all sessions' },
  { key: 'esc', label: 'close' },
]

describe('keyHints', () => {
  it('spells every hint as key then label, two spaces apart, in the order given', () => {
    expect(keyHints(HINTS, PLAIN, 80)).toBe('↑↓ select  ⏎ confirm  tab all sessions  esc close')
  })

  it('keeps the closing hint when the row is too narrow, dropping the ones before it', () => {
    expect(keyHints(HINTS, PLAIN, 31)).toBe('↑↓ select  ⏎ confirm  esc close')
    expect(keyHints(HINTS, PLAIN, 20)).toBe('↑↓ select  esc close')
    expect(keyHints(HINTS, PLAIN, 9)).toBe('esc close')
  })

  it('colours keys apart from labels, and stays plain where the theme paints nothing', () => {
    const row = keyHints(HINTS.slice(0, 1), COLOUR, 80)
    expect(row).not.toBe('↑↓ select')
    expect(row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')).toBe('↑↓ select')
  })

  it('neutralises control characters in labels', () => {
    expect(keyHints([{ key: 'esc', label: `close${String.fromCharCode(27)}[31m` }], PLAIN, 80)).not.toContain(
      String.fromCharCode(27),
    )
  })
})
