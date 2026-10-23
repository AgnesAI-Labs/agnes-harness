import { type Component, escapeControl, Text, VStack, wrapText } from '../component.js'
import type { ThemedAnsi } from '../theme.js'
import { applyMarks, unifiedMarks } from './word-diff.js'

/** `/diff` output: the unified diff's own marks pick the tone, wrapped rows included. */
function diffRows(text: string, ansi: ThemedAnsi): Component {
  const tone = (line: string) =>
    /^(\+\+\+|---) /.test(line) || line.startsWith('@@')
      ? 'faint'
      : line.startsWith('+')
        ? 'success'
        : line.startsWith('-')
          ? 'danger'
          : undefined
  const lines = text.split('\n')
  const marks = unifiedMarks(lines)
  return {
    render: (width) =>
      lines.flatMap((line, i) => {
        const t = tone(line)
        const rows = wrapText(line, width)
        const changed = marks.get(i)
        // Wrapped rows are slices of the line (a space may drop at a break), so each is marked where it sits.
        let from = 0
        return rows.map((row) => {
          const at = line.indexOf(row, from)
          if (at >= 0) from = at + row.length
          const shown =
            changed && at >= 0 ? applyMarks(row, changed, (w) => ansi.bold(ansi.underline(w)), at) : row
          return t ? ansi.fg(t, shown) : ansi.dim(shown)
        })
      }),
    invalidate() {},
  }
}

/** A connection-local transcript entry: the command echoed, then its output (dim when `quiet`). */
export function localCommandView(
  ansi: ThemedAnsi,
): (command: string, output: string, quiet?: boolean) => Component {
  return (command, output, quiet = true) => {
    const echo = new Text(`${ansi.bold(ansi.fg('accent', '›'))} ${ansi.bold(escapeControl(command.trim()))}`)
    const text = escapeControl(output)
    const diff = /^\/diff(\s|$)/.test(command.trim())
    const styled = new VStack([
      echo,
      diff ? diffRows(text, ansi) : quiet ? new Text(text, { style: (s) => ansi.dim(s) }) : new Text(text),
    ])
    const plain = new VStack([echo, new Text(text)])
    return { render: (w) => styled.render(w), transcript: (w) => plain.render(w), invalidate() {} }
  }
}
