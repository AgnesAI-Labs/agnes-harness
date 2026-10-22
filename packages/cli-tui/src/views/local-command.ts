import { type Component, escapeControl, Text, VStack } from '../component.js'
import type { ThemedAnsi } from '../theme.js'

/** A connection-local transcript entry: the command echoed, then its output (dim when `quiet`). */
export function localCommandView(
  ansi: ThemedAnsi,
): (command: string, output: string, quiet?: boolean) => Component {
  return (command, output, quiet = true) => {
    const echo = new Text(`${ansi.bold(ansi.fg('accent', '›'))} ${ansi.bold(escapeControl(command.trim()))}`)
    const text = escapeControl(output)
    const styled = new VStack([echo, quiet ? new Text(text, { style: (s) => ansi.dim(s) }) : new Text(text)])
    const plain = new VStack([echo, new Text(text)])
    return { render: (w) => styled.render(w), transcript: (w) => plain.render(w), invalidate() {} }
  }
}
