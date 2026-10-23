import { RAIL_MIN_WIDTH } from './views/composer-rail.js'

/** Where the draft's text rows sit on screen: the first row, the column the text starts at, and how many rows. */
export type PromptArea = { top: number; left: number; rows: number }

/**
 * The prompt's text rows in a frame of `screenRows` rows whose last `belowComposer` rows come after the
 * composer. The composer wears a rail above and below once the terminal is wide enough, and indents the
 * editor by three columns; menu rows sit above the text rows and are not part of the area.
 */
export function promptArea(o: {
  screenRows: number
  belowComposer: number
  width: number
  textRows: number
}): PromptArea | undefined {
  if (o.textRows <= 0) return undefined
  const railed = o.width >= RAIL_MIN_WIDTH
  return {
    top: o.screenRows - o.belowComposer - (railed ? 1 : 0) - o.textRows,
    left: railed ? 3 : 0,
    rows: o.textRows,
  }
}

/** A click on a screen cell: a prompt text row moves the cursor (when `live`), any other row is the conversation's. */
export function routeClick(
  area: PromptArea | undefined,
  row: number,
  col: number,
  live: boolean,
  moveCursor: (row: number, col: number) => void,
  conversation: (row: number) => unknown,
): void {
  if (area && row >= area.top && row < area.top + area.rows) {
    if (live) moveCursor(row - area.top, col - area.left)
    return
  }
  conversation(row)
}
