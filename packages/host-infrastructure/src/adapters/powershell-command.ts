import type { PowerShellDescriptor } from './powershell.js'

/** UTF-16 units including CRT quoting, escaped quotes and trailing backslashes. */
export function windowsCommandLength(argv: readonly string[]): number {
  return argv.reduce((size, arg, index) => {
    if (arg && !/[\s"]/.test(arg)) return size + arg.length + (index ? 1 : 0)
    let length = 2,
      slashes = 0
    for (const character of arg) {
      if (character === '\\') slashes++
      else {
        length += (character === '"' ? slashes * 2 + 1 : slashes) + character.length
        slashes = 0
      }
    }
    return size + length + slashes * 2 + (index ? 1 : 0)
  }, 0)
}

export const powerShellEncoding = [
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::InputEncoding = $OutputEncoding',
  '[Console]::OutputEncoding = $OutputEncoding',
  "$ProgressPreference = 'SilentlyContinue'",
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Select-String:Encoding'] = 'utf8'",
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
  "$env:PYTHONUTF8 = '1' ; $env:PYTHONUNBUFFERED = '1'",
].join('\n')

/** Set only this process's streams; leave script exit semantics and stdin ownership intact. */
export function powerShellCommand(shell: PowerShellDescriptor, command: string): string[] {
  if (!command || command.includes('\0')) throw new Error('invalid PowerShell command')
  const script = `${powerShellEncoding}\n${command}`
  const argv = [
    shell.path,
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    shell.edition === 'Desktop' ? '-Command' : '-EncodedCommand',
    shell.edition === 'Desktop' ? script : Buffer.from(script, 'utf16le').toString('base64'),
  ]
  // Host materializes overlong encoded commands only after policy authorization.
  return argv
}

export function powerShellDescription(shell: PowerShellDescriptor): string {
  return [
    `PowerShell ${shell.version} (${shell.edition})`,
    `executable: ${JSON.stringify(shell.path)}`,
    `native argument mode: ${shell.nativeArguments}`,
    ...(shell.codePage ? [`console code page: ${shell.codePage}`] : []),
    ...(shell.edition === 'Desktop' ? ['use PS5.1 syntax, without && or ||'] : []),
    'scripts use PowerShell exit semantics; use explicit exit to forward a native exit code',
  ].join('; ')
}
