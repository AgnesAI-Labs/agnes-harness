import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/**
 * How a daemon that cannot start tells the command that started it why.
 *
 * The daemon is launched detached, so nothing it prints can be read back, and every refusal it
 * makes while starting exits with the same code. The launcher therefore hands the child a file to
 * write its reason to, in a private directory the launcher made and removes. The reason travels as
 * one short line of the error's message, which the child was going to print anyway; nothing else
 * about the child is recorded.
 */
const ENV = 'AGNES_DAEMON_STARTUP_REPORT'
const DIRECTORY_PREFIX = 'agh-daemon-start-'
const FILE = 'startup-failure.txt'
const MAX_REASON = 300
const MAX_READ = 4096

export type StartupReport = {
  /** The environment entry to give the child. */
  readonly env: Readonly<Record<string, string>>
  /** The reason the child wrote, if it wrote one. */
  read(): string | undefined
  dispose(): void
}

/** One line, no control characters, bounded. Empty becomes undefined. */
export function startupReason(text: string): string | undefined {
  const line = [...text]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
  if (line === '') return undefined
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON)}…` : line
}

/** Parent side: a fresh private directory and the file the child may write into it. */
export function createStartupReport(): StartupReport | undefined {
  let directory: string | undefined
  try {
    directory = mkdtempSync(join(tmpdir(), DIRECTORY_PREFIX))
    const file = join(directory, FILE)
    const owned = directory
    return {
      env: { [ENV]: file },
      read() {
        let fd: number | undefined
        try {
          // The file is the child's to write, so read only its first few kilobytes, not all of it.
          fd = openSync(file, 'r')
          const buffer = Buffer.alloc(MAX_READ)
          return startupReason(buffer.subarray(0, readSync(fd, buffer, 0, MAX_READ, 0)).toString('utf8'))
        } catch {
          return undefined
        } finally {
          if (fd !== undefined) closeSync(fd)
        }
      },
      dispose() {
        try {
          rmSync(owned, { recursive: true, force: true })
        } catch {
          /* A leftover temporary directory must not turn into a second failure. */
        }
      },
    }
  } catch {
    // The report is a courtesy: without a temporary directory the daemon starts as it always did.
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
    return undefined
  }
}

/** Child side: record why startup failed, only where the launcher said to and only in its own file. */
export function reportStartupFailure(message: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = env[ENV]
  if (file === undefined || file === '' || !isAbsolute(file)) return
  if (basename(file) !== FILE || !basename(dirname(file)).startsWith(DIRECTORY_PREFIX)) return
  const reason = startupReason(message)
  if (reason === undefined) return
  try {
    writeFileSync(file, reason, { mode: 0o600 })
  } catch {
    /* The reason is still printed; failing to record it must not change the exit. */
  }
}
