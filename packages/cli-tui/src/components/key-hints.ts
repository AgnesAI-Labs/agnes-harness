import { escapeControl } from '../component.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'
import { fitLine } from './line.js'

export type KeyHint = { key: string; label: string }

const GAP = '  '

/**
 * The one way every surface spells its keys: `key label  key label`, keys bold in accentSoft and labels
 * muted. List them as move, confirm, others, close. A row too wide for `width` drops hints from the
 * second-to-last backwards, so the closing hint is the last one to go. The row is not padded to `width`.
 */
export function keyHints(hints: readonly KeyHint[], ansi: ThemedAnsi, width: number): string {
  const plain = (h: KeyHint) => `${escapeControl(h.key)} ${escapeControl(h.label)}`
  const kept = [...hints]
  const size = () => displayWidth(kept.map(plain).join(GAP))
  while (kept.length > 1 && size() > width) kept.splice(kept.length - 2, 1)
  const row = kept
    .map(
      (h) =>
        `${ansi.bold(ansi.fg('accentSoft', escapeControl(h.key)))} ${ansi.fg('muted', escapeControl(h.label))}`,
    )
    .join(GAP)
  // Unpadded, since callers set it inside borders and rules; only a lone hint wider than the row is cut.
  return size() > width ? fitLine(row, Math.max(0, width)).trimEnd() : row
}
