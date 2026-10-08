import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createPlatform, redactDetail } from '@agnes/host'
import { createPrivateFileSync, windowsReadPrivateFileSync } from '@agnes/system-node'

export const STARTUP_DIAGNOSTIC_ENV = 'AGH_DAEMON_STARTUP_DIAGNOSTIC'
const MAX_BYTES = 4096

/** One launch owns this private, write-once receipt; no daemon stderr pipe survives readiness. */
export function startupDiagnosticPath(daemonDir: string): string {
  return join(daemonDir, `startup-refusal-${randomUUID()}.json`)
}

export function publishStartupDiagnostic(error: unknown, dataDir: string | undefined): void {
  const path = process.env[STARTUP_DIAGNOSTIC_ENV]
  if (!path || !dataDir || dirname(path) !== join(resolve(dataDir), 'daemon')) return
  if (!/^startup-refusal-[0-9a-f-]{36}\.json$/u.test(basename(path))) return
  const message = error instanceof Error ? error.message : String(error)
  const safe = redactDetail({ message: message.slice(0, 1000) })
  let fd: number | undefined
  try {
    fd = createPrivateFileSync(path)
    writeFileSync(fd, JSON.stringify(safe))
  } catch {
    // Diagnostics must not replace the startup refusal or change daemon cleanup semantics.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* Keep diagnostics best-effort. */
      }
    }
  }
}

export function readStartupDiagnostic(path: string): string | undefined {
  let fd: number | undefined
  try {
    let bytes: Buffer
    if (createPlatform().os === 'win32') bytes = windowsReadPrivateFileSync(path, MAX_BYTES)
    else {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o777) !== 0o600) return
      bytes = Buffer.alloc(MAX_BYTES + 1)
      const length = readSync(fd, bytes, 0, bytes.length, 0)
      if (length > MAX_BYTES) return
      bytes = bytes.subarray(0, length)
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || !('message' in value)) return
    return typeof value.message === 'string'
      ? [...value.message].map((char) => (char.charCodeAt(0) < 32 ? ' ' : char)).join('')
      : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* Keep diagnostics best-effort. */
      }
    }
  }
}

export function removeStartupDiagnostic(path: string | undefined): void {
  try {
    if (path) rmSync(path, { force: true })
  } catch {
    // Preserve the startup result and always release startup coordination.
  }
}
