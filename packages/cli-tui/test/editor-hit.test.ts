import { describe, expect, it, vi } from 'vitest'
import { Editor } from '../src/editor.js'
import { offsetAtCell } from '../src/editor-hit.js'
import { promptArea, routeClick } from '../src/prompt-click.js'

// Column 0 is the editor's left edge; at width 20 the prompt "❯ " and every continuation take two.
describe('offsetAtCell', () => {
  it('maps a click on a single line, past its end, and on the prompt', () => {
    expect(offsetAtCell('hello', 5, 20, 0, 2)).toBe(0)
    expect(offsetAtCell('hello', 5, 20, 0, 4)).toBe(2)
    expect(offsetAtCell('hello', 5, 20, 0, 19)).toBe(5)
    expect(offsetAtCell('hello', 5, 20, 0, 0)).toBe(0)
    expect(offsetAtCell('hello', 5, 20, 0, 1)).toBe(0)
  })

  it('maps rows of a multi-line draft and ends a short line at its own end', () => {
    const text = 'ab\ncdef\n\ngh'
    expect(offsetAtCell(text, 0, 20, 1, 3)).toBe(4)
    expect(offsetAtCell(text, 0, 20, 1, 19)).toBe(7)
    expect(offsetAtCell(text, 0, 20, 2, 9)).toBe(8) // the empty line
    expect(offsetAtCell(text, 0, 20, 3, 3)).toBe(10)
    expect(offsetAtCell(text, 0, 20, 4, 3)).toBeUndefined()
    expect(offsetAtCell(text, 0, 20, -1, 3)).toBeUndefined()
  })

  it('follows the wrapping render draws, including the row a cursor at a full line opens', () => {
    // Inner width 4: "abcd" / "efgh" / "ij".
    expect(offsetAtCell('abcdefghij', 0, 6, 1, 2 + 1)).toBe(5)
    expect(offsetAtCell('abcdefghij', 0, 6, 2, 2 + 1)).toBe(9)
    expect(offsetAtCell('abcdefghij', 0, 6, 0, 2 + 3)).toBe(3)
    // A cursor at the end of a full row sits alone on a fresh row; clicking it stays at the end.
    expect(offsetAtCell('abcd', 4, 6, 1, 2)).toBe(4)
    expect(offsetAtCell('abcd', 4, 6, 0, 2 + 3)).toBe(3)
  })

  it('counts a wide character as two columns and lands after it from its right half', () => {
    const text = '你好a'
    expect(offsetAtCell(text, 3, 20, 0, 2)).toBe(0)
    expect(offsetAtCell(text, 3, 20, 0, 3)).toBe(1)
    expect(offsetAtCell(text, 3, 20, 0, 4)).toBe(1)
    expect(offsetAtCell(text, 3, 20, 0, 5)).toBe(2)
    expect(offsetAtCell(text, 3, 20, 0, 6)).toBe(2)
    expect(offsetAtCell(text, 3, 20, 0, 7)).toBe(3)
  })

  it('keeps whole graphemes together', () => {
    const text = 'aéb' // the accent belongs to the e: offsets 1 and 3 are boundaries, 2 is not
    expect(offsetAtCell(text, 4, 20, 0, 2 + 1)).toBe(1)
    expect(offsetAtCell(text, 4, 20, 0, 2 + 2)).toBe(3)
  })

  it('has no text rows on an empty draft beyond the first', () => {
    expect(offsetAtCell('', 0, 20, 0, 9)).toBe(0)
    expect(offsetAtCell('', 0, 20, 1, 9)).toBeUndefined()
  })
})

describe('Editor.moveCursorToCell', () => {
  it('adds the scrolled viewport start to the row it is given', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`)
    const e = new Editor({ onSubmit() {}, maxRows: () => 3 })
    e.setText(lines.join('\n')) // cursor at the end, so the viewport shows the last three rows
    expect(e.render(20)).toHaveLength(3)
    e.moveCursorToCell(0, 2)
    expect(e.cursor).toBe(lines.slice(0, 7).join('\n').length + 1)
    expect(e.textRows).toBe(3)
  })

  it('ignores a click while history search is open', () => {
    const e = new Editor({ onSubmit() {} })
    e.setText('hello')
    e.render(20)
    e.handleInput('\x12')
    e.moveCursorToCell(0, 4)
    expect(e.text).toBe('hello')
  })
})

describe('prompt clicks', () => {
  it('places the text rows above the rail and the rows below the composer', () => {
    expect(promptArea({ screenRows: 24, belowComposer: 2, width: 80, textRows: 3 })).toEqual({
      top: 18,
      left: 3,
      rows: 3,
    })
    // Too narrow for the rail: no rail rows and no indent.
    expect(promptArea({ screenRows: 24, belowComposer: 2, width: 30, textRows: 3 })).toEqual({
      top: 19,
      left: 0,
      rows: 3,
    })
    expect(promptArea({ screenRows: 24, belowComposer: 2, width: 80, textRows: 0 })).toBeUndefined()
  })

  it('moves the cursor for a prompt row and leaves every other row to the conversation', () => {
    const area = { top: 18, left: 3, rows: 2 }
    const move = vi.fn()
    const conversation = vi.fn()
    routeClick(area, 19, 10, true, move, conversation)
    expect(move).toHaveBeenCalledWith(1, 7)
    routeClick(area, 17, 10, true, move, conversation) // a menu row above the text
    routeClick(area, 5, 10, true, move, conversation)
    expect(conversation.mock.calls).toEqual([[17], [5]])
    routeClick(area, 18, 4, false, move, conversation) // a dialog covers the prompt
    expect(move).toHaveBeenCalledTimes(1)
    expect(conversation).toHaveBeenCalledTimes(2)
  })
})
