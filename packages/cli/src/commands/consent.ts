import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ConsentLevel, transitionConsent } from '@agnes/base'
import { createPlatform, readProfileTelemetryConsent } from '@agnes/host'
import {
  createPrivateFileSync,
  renameWriteThroughSync,
  windowsEnsurePrivateDirectorySync,
} from '@agnes/system-node'
import { profileNameFrom } from '../boot/inputs.js'
import { UsageError } from '../errors.js'
import type { BootDeps, ParsedArgs } from '../types.js'

const TIERS = ['DISABLED', 'LOCAL', 'ANON', 'FULL'] as const

/** Writes the local consent overlay atomically; a session already running keeps its current tier. */
export function consentCommand(p: ParsedArgs, deps: BootDeps): string {
  const tier = p.positional[0]
  if (p.positional.length !== 1 || tier === undefined || !(TIERS as readonly string[]).includes(tier))
    throw new UsageError(`consent ${TIERS.join('|')}`)

  const profile = profileNameFrom(p, deps.env)
  const dir = join(deps.home, 'profiles', profile)
  const windows = createPlatform().os === 'win32'
  if (windows) windowsEnsurePrivateDirectorySync(dir)
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const from = readProfileTelemetryConsent(dir) ?? 'DISABLED'
  const to = tier as ConsentLevel
  const transition = transitionConsent(from, to, { explicit: true, by: 'cli' })
  if (!transition.ok) throw new UsageError(transition.reason)

  // A same-directory rename is the commit point and replaces a malicious consent.yaml symlink
  // instead of following it. The private temporary is removed if the rename itself fails.
  const file = join(dir, 'consent.yaml')
  const temporary = join(dir, `.consent-${randomUUID()}.tmp`)
  if (windows) {
    // Creation outside the try means cleanup never owns a pre-existing name.
    const fd = createPrivateFileSync(temporary)
    let committed = false
    try {
      try {
        writeFileSync(fd, `telemetry:\n  consent: ${to}\n`, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameWriteThroughSync(temporary, file)
      committed = true
    } finally {
      if (!committed) {
        try {
          rmSync(temporary, { force: true })
        } catch {
          /* Preserve the original failure. */
        }
      }
    }
    return `telemetry consent for ${profile}: ${tier} (takes effect for consumers on the next session)`
  }
  try {
    writeFileSync(temporary, `telemetry:\n  consent: ${to}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }

  return `telemetry consent for ${profile}: ${tier} (takes effect for consumers on the next session)`
}
