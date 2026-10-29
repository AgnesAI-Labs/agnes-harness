/** Narrowest the side dock gets, and the width it opens at and returns to on a double-click. */
export const RIGHT_MIN = 240
export const RIGHT_DEFAULT = 720
export const BOTTOM_MIN = 120
export const BOTTOM_DEFAULT = 220
/** The conversation keeps at least this much of the main column however far the dock is dragged. */
const CONVERSATION_MIN = 420

/**
 * The widest the side dock may be. `mainWidth` is the main column, which already excludes the
 * sidebar, so the limit follows the window and the sidebar without a fixed ceiling.
 */
export function maxRightWidth(mainWidth: number): number {
  return Math.max(RIGHT_MIN, Math.floor(mainWidth - CONVERSATION_MIN))
}

export function clampRightWidth(width: number, max: number): number {
  return Math.round(Math.max(RIGHT_MIN, Math.min(max, width)))
}

export function maxBottomHeight(windowHeight: number): number {
  return Math.max(BOTTOM_MIN, Math.floor(windowHeight / 2))
}

export function clampBottomHeight(height: number, max: number): number {
  return Math.round(Math.max(BOTTOM_MIN, Math.min(max, height)))
}
