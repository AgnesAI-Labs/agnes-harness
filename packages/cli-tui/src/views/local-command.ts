import { type Component, escapeControl, Text, VStack, wrapText } from '../component.js'
import type { ThemedAnsi } from '../theme.js'

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
  return {
    render: (width) =>
      text.split('\n').flatMap((line) => {
        const t = tone(line)
        return wrapText(line, width).map((row) => (t ? ansi.fg(t, row) : ansi.dim(row)))
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
