import type { PowerShellDescriptor } from './powershell.js'

/** Set only this process's streams; leave script exit semantics and stdin ownership intact. */
export function powerShellCommand(shell: PowerShellDescriptor, command: string): string[] {
  if (!command || command.includes('\0')) throw new Error('invalid PowerShell command')
  const prelude = [
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $OutputEncoding',
    '[Console]::OutputEncoding = $OutputEncoding',
    "$ProgressPreference = 'SilentlyContinue'",
  ].join('\n')
  const encoded = Buffer.from(`${prelude}\n${command}`, 'utf16le').toString('base64')
  const argv = [
    shell.path,
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-OutputFormat',
    'Text',
    '-EncodedCommand',
    encoded,
  ]
  // Host materializes overlong encoded commands only after policy authorization.
  return argv
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
