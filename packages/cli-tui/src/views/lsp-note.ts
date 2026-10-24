/**
 * Reads the language-server note that write and edit append to their result. The format is a contract
 * with `formatAuto` in packages/base/extensions/lsp/src/format.ts: change either side, change both.
 * cli-tui may not depend on base, so the head line is matched here, not imported.
 */
export type LspNote = {
  /** Error count from the head line; the rows below can be fewer when the preview was clipped. */
  count: number
  /** `line:col message` rows, in order. */
  errors: string[]
  /** Offset of the head line in the text. */
  at: number
}

const HEAD = /LSP found (\d+) errors? in .+?:(?:\n|$)/
const ROW = /^\d+:\d+ /

export function parseLspNote(text: string | undefined): LspNote | undefined {
  const m = text === undefined ? null : HEAD.exec(text)
  if (!text || !m) return undefined
  const errors: string[] = []
  for (const row of text.slice(m.index + m[0].length).split('\n')) {
    if (!ROW.test(row)) break
    errors.push(row)
  }
  return { count: Number(m[1]), errors, at: m.index }
}

/** The note starts its own line: write and edit results are joined with no separator. */
export function splitLspNote(text: string): string {
  const note = parseLspNote(text)
  return note && note.at > 0 && text[note.at - 1] !== '\n'
    ? `${text.slice(0, note.at)}\n${text.slice(note.at)}`
    : text
}
