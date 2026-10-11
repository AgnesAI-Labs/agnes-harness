import { closeSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { windowsCreateTemporaryPrivateFileSync } from '@agnes/system-node'
import type { PowerShellDescriptor } from './powershell.js'
import { powerShellCommand, powerShellScript, windowsCommandLineLength } from './powershell-command.js'
import { createPowerShellDirectory } from './powershell-temporary.js'

/** Called only after policy authorization. No stdin is consumed and no execution policy is changed. */
export function preparePowerShellFile(
  shell: PowerShellDescriptor | undefined,
  argv: string[],
): { argv: string[]; dispose(): void; scriptFile?: string } {
  const unchanged = { argv, dispose() {} }
  if (!shell || windowsCommandLineLength(argv) + 32 <= 30_000) return unchanged
  const script = powerShellScript(shell, argv)
  if (script === undefined) return unchanged
  const contents = Buffer.from(script, 'utf16le')
  const directory = createPowerShellDirectory()
  const scriptFile = join(directory, 'command.txt')
  let fd: number | undefined
  const dispose = () => {
    if (fd !== undefined) {
      closeSync(fd)
      fd = undefined
    }
    rmdirSync(directory)
  }
  try {
    fd = windowsCreateTemporaryPrivateFileSync(scriptFile)
    writeFileSync(fd, contents)
    const path = `'${scriptFile.replaceAll("'", "''")}'`
    const bootstrap = `. ([ScriptBlock]::Create((& {
      $s=[IO.File]::Open(${path},[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));
      try { $r=[IO.StreamReader]::new($s,[Text.Encoding]::Unicode); try { $r.ReadToEnd() } finally { $r.Dispose() } }
      finally { $s.Dispose() }
    })))`
    return { argv: powerShellCommand(shell, bootstrap), dispose, scriptFile }
  } catch (cause) {
    try {
      dispose()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'PowerShell script preparation and cleanup failed')
    }
    throw cause
  }
}
