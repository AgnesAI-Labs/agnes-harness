import { execFile, spawn } from 'node:child_process'
import { rpcError } from '@agnes/protocol'

/** A macOS background/system bootstrap is not an interactive Aqua desktop. */
export async function macDesktopAvailable(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      '/bin/launchctl',
      ['managername'],
      { encoding: 'utf8', timeout: 1500, maxBuffer: 1024, signal },
      (error, stdout) => resolve(!error && stdout.trim() === 'Aqua'),
    )
  })
}

/** Opens a revalidated server-owned directory as one literal argument, without a shell. */
export async function revealWorkspaceDirectory(platform: string, root: string): Promise<void> {
  const executable = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [root], { detached: true, stdio: 'ignore', shell: false })
    child.once('error', () => reject(rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_REVEAL_FAILED' })))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
