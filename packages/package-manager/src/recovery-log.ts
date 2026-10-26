import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { windowsAppendPrivateFileSync } from '@agnes/system-node'

/** What recovery did on its own, so an operator can see why a leftover disappeared. */
export type PackageRecoveryEvent = Readonly<{
  action: 'removed' | 'repaired' | 'kept'
  path: string
  reason: string
}>
export type RecordRecovery = (event: PackageRecoveryEvent) => void

const windows = process.platform === 'win32' // guards-allow-platform: private log file primitives.

export const recoveryLogPath = (profileDir: string): string =>
  join(profileDir, '.agnes-package-recovery.jsonl')

/** Appends to a private log file and flushes it; shared by the package audit and the recovery log. */
export function appendPrivateLog(file: string, text: string): void {
  if (windows) windowsAppendPrivateFileSync(resolve(file), Buffer.from(text), true)
  else appendFileSync(file, text, { mode: 0o600, flush: true })
}

/**
 * Best effort: a record that cannot be written must not turn a successful repair into a refusal. The
 * repair itself is the durable fact; this line only explains it.
 */
export function recordPackageRecovery(profileDir: string, event: PackageRecoveryEvent): void {
  try {
    appendPrivateLog(
      recoveryLogPath(profileDir),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    )
  } catch {
    /* the repair already happened */
  }
}
