import type { PowerShellDescriptor } from './powershell.js'

const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text']
// UTF-8 both ways for this console and the programs it starts, and no progress records. A script
// that does not parse never gets this far: PowerShell reports that error in the console's original
// code page, which the output decoder turns back into text.
const prelude = [
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = $OutputEncoding',
  '[Console]::OutputEncoding = $OutputEncoding',
  "$ProgressPreference = 'SilentlyContinue'",
]
// Windows PowerShell 5.1 reads a file without a byte order mark in the ANSI code page and writes `>`
// and Out-File as UTF-16; PowerShell 7 does both in UTF-8 already. 5.1's UTF8 writes a byte order
// mark, so Set-Content and Add-Content keep their default, which leaves ASCII files ASCII.
const desktopPrelude = [
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'",
  "$PSDefaultParameterValues['Select-String:Encoding'] = 'UTF8'",
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'UTF8'",
]

/**
 * Set only this process's streams; leave script exit semantics and stdin ownership intact.
 *
 * Windows PowerShell 5.1 writes its error, warning, verbose, debug, information and progress
 * records to stderr as CLIXML whenever the command came through -EncodedCommand and stderr is
 * redirected, whatever -OutputFormat says (PowerShell 7 honours -OutputFormat Text). So 5.1 gets the
 * script as -Command text, which libuv quotes as one argument and which runs the same way; 7 keeps
 * the encoded form.
 */
export function powerShellCommand(shell: PowerShellDescriptor, command: string): string[] {
  if (!command || command.includes('\0')) throw new Error('invalid PowerShell command')
  const script = [...prelude, ...(shell.edition === 'Desktop' ? desktopPrelude : []), command].join('\n')
  // Host materializes overlong commands only after policy authorization.
  return shell.edition === 'Desktop'
    ? [shell.path, ...flags, '-Command', script]
    : [shell.path, ...flags, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** The script an argv from powerShellCommand runs, or undefined for any other argv. */
export function powerShellScript(shell: PowerShellDescriptor, argv: readonly string[]): string | undefined {
  const prefix = powerShellCommand(shell, 'x').slice(0, -1)
  if (argv.length !== prefix.length + 1 || prefix.some((value, i) => argv[i] !== value)) return undefined
  const last = argv.at(-1) as string
  if (prefix.at(-1) === '-Command') return last
  const contents = Buffer.from(last, 'base64')
  if (contents.length % 2 || contents.toString('base64') !== last)
    throw Object.assign(new Error('Invalid encoded PowerShell script'), { code: 'E_SHELL_COMMAND' })
  return contents.toString('utf16le')
}

/**
 * The length of the command line CreateProcess receives for argv, which libuv quotes as the C
 * runtime parses it: an argument with a space, tab or quote is quoted, and a quote, with the
 * backslashes before it or before the closing quote, is escaped with a backslash each.
 */
export function windowsCommandLineLength(argv: readonly string[]): number {
  let length = argv.length - 1
  for (const arg of argv) {
    length += arg.length
    if (!arg) length += 2
    else if (/[ \t"]/.test(arg)) {
      let slashes = 0
      length += 2
      for (const character of arg) {
        if (character === '\\') slashes++
        else {
          if (character === '"') length += slashes + 1
          slashes = 0
        }
      }
      length += slashes
    }
  }
  return length
}

export function powerShellDescription(shell: PowerShellDescriptor): string {
  return [
    `PowerShell ${shell.version} (${shell.edition})`,
    `executable: ${JSON.stringify(shell.path)}`,
    `native argument mode: ${shell.nativeArguments}`,
    ...(shell.edition === 'Desktop' ? ['use PS5.1 syntax, without && or ||'] : []),
    'scripts use PowerShell exit semantics; use explicit exit to forward a native exit code',
  ].join('; ')
}
