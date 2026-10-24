/** What suspending needs from the process; tests hand in their own so nothing ever really stops. */
export interface SuspendIO {
  platform: string
  /** Stops this process until the shell continues it. */
  stop(): void
  /** Calls `resume` the next time the shell continues this process. */
  onContinue(resume: () => void): void
}

export const PROCESS_SUSPEND: SuspendIO = {
  platform: process.platform, // guards-allow-platform: Windows has no SIGTSTP, so Ctrl-Z stays an undo there
  stop: () => void process.kill(process.pid, 'SIGTSTP'),
  onContinue: (resume) => void process.once('SIGCONT', resume),
}

/**
 * Ctrl-Z on an empty prompt: hands the terminal back exactly as quitting does (the renderer's own
 * `suspend()`), stops the process, and takes the terminal over again, repainted, when the shell
 * continues it. False where there is no SIGTSTP (Windows), so the key stays an undo there.
 */
export function suspendToShell(
  renderer: { suspend(): () => void },
  io: SuspendIO = PROCESS_SUSPEND,
): boolean {
  if (io.platform === 'win32') return false
  const resume = renderer.suspend()
  io.onContinue(resume)
  io.stop()
  return true
}
