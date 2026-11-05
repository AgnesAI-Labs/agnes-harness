import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { createPlatform } from './adapters/platform.js'
import { resolveConfiguredPowerShell } from './adapters/powershell.js'
import { powerShellCommand } from './adapters/powershell-command.js'

export class DocumentsDirectoryError extends Error {
  readonly code = 'DOCUMENTS_UNAVAILABLE'
  constructor(cause?: unknown) {
    super('System Documents directory is unavailable', { cause })
  }
}

export function parseXdgDocumentsDirectory(config: string, home: string): string {
  const value = /^XDG_DOCUMENTS_DIR="([^"\n]*)"\s*$/m.exec(config)?.[1]
  if (!value || /[`\\]|\$\(|\$\{/.test(value)) throw new DocumentsDirectoryError()
  const path = value.replace(/^\$HOME(?=\/|$)/, home)
  if (path.includes('$') || !isAbsolute(path) || path === home) throw new DocumentsDirectoryError()
  return path
}

/** Queries the platform's configured Documents location; never falls back to the home directory. */
export async function resolveDocumentsDirectory(signal: AbortSignal): Promise<string> {
  try {
    signal.throwIfAborted()
    const execute = promisify(execFile)
    const os = createPlatform().os
    let path: string
    if (os === 'darwin') {
      path = (
        await execute('/usr/bin/osascript', ['-e', 'POSIX path of (path to documents folder)'], {
          signal,
          timeout: 5000,
          encoding: 'utf8',
        })
      ).stdout.trim()
    } else if (os === 'win32') {
      const shell = await resolveConfiguredPowerShell(process.env)
      const [bin, ...argv] = powerShellCommand(
        shell,
        '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)',
      )
      if (!bin) throw new DocumentsDirectoryError()
      path = (await execute(bin, argv, { signal, timeout: 5000, encoding: 'utf8' })).stdout.trim()
    } else if (os === 'linux') {
      const home = homedir()
      path = parseXdgDocumentsDirectory(
        await readFile(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'), 'utf8'),
        home,
      )
    } else throw new DocumentsDirectoryError()
    if (!isAbsolute(path)) throw new DocumentsDirectoryError()
    path = await realpath(path)
    if (!(await stat(path)).isDirectory()) throw new DocumentsDirectoryError()
    return path
  } catch (cause) {
    throw new DocumentsDirectoryError(cause)
  }
}
