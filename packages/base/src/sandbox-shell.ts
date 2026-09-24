import { SHELL_SENTINEL } from '../extensions/tools-core/src/tools/shell.js'

/** Expansion is argument construction only. It provides no OS isolation. */
export function expandShell(
  argv: string[],
  dialect: 'posix' | 'powershell',
  shellCommand?: (command: string) => string[],
): string[] {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv[0] ||
    argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    (dialect !== 'posix' && dialect !== 'powershell')
  )
    throw new Error('invalid sandbox command')
  if (argv[0] !== SHELL_SENTINEL) return [...argv]
  // Never silently discard arguments or turn a missing command into successful empty execution.
  if (argv.length !== 2 || !argv[1]) throw new Error('invalid sandbox shell command')
  if (dialect === 'powershell' && shellCommand) return shellCommand(argv[1])
  return dialect === 'posix' ? ['sh', '-c', argv[1]] : ['pwsh', '-NoProfile', '-Command', argv[1]]
}
