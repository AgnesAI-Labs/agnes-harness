import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RefinementSettings, RefinementSettingsSnapshot } from '@agnes/protocol'
import { DEFAULT_REFINEMENT_SETTINGS, validateAgainst } from '@agnes/protocol'
import { RefinementSettings as Schema } from '@agnes/protocol/gen/agnes-v1'
import { MAX_SETTINGS_BYTES } from './settings-file.js'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The version a client read, for a conditional save: it names the stored value. */
export const refinementSettingsRevision = (settings: RefinementSettings): string =>
  sha256(JSON.stringify({ enabled: settings.enabled, mode: settings.mode }))

const failure = (code: 'CONFIG_INVALID_INPUT' | 'CONFIG_REVISION_CONFLICT', extra: object = {}) =>
  Object.assign(new Error(code), { code, ...extra })

/**
 * What the host offers the rest of the system: the current refinement settings and their revision.
 * Read it again whenever the answer matters (before planning, before applying); never cache it.
 */
export interface RefinementSettingsPort {
  current(): RefinementSettingsSnapshot
}

/**
 * The refinement settings of one profile, in `<dataDir>/refinement/<sha256(profile)>.json`. Refinement is
 * off unless this file says otherwise: a missing, unreadable or invalid file reads as the defaults, and no
 * other key (a preset, a profile document) can turn it on. Reads and writes are synchronous so a caller can
 * check the switch at the instant it matters; the file is tiny and replaced in one rename.
 */
export class RefinementSettingsStore implements RefinementSettingsPort {
  private readonly dir: string
  private readonly file: string
  constructor(dataDir: string, profile: string) {
    this.dir = join(dataDir, 'refinement')
    this.file = join(this.dir, `${sha256(profile)}.json`)
  }

  read(): RefinementSettingsSnapshot {
    const settings = this.stored() ?? structuredClone(DEFAULT_REFINEMENT_SETTINGS)
    return { settings, revision: refinementSettingsRevision(settings) }
  }

  current(): RefinementSettingsSnapshot {
    return this.read()
  }

  /**
   * Saves the whole settings while the stored value still has `expectedRevision`; otherwise refuses with
   * `CONFIG_REVISION_CONFLICT` and the current snapshot, and writes nothing. The compare and the write run
   * without yielding, so no other save in this process can slip between them.
   */
  save(settings: RefinementSettings, expectedRevision: string): { revision: string } {
    if (!validateAgainst(Schema, settings).ok) throw failure('CONFIG_INVALID_INPUT')
    const clean: RefinementSettings = { enabled: settings.enabled, mode: settings.mode }
    const current = this.read()
    if (current.revision !== expectedRevision) throw failure('CONFIG_REVISION_CONFLICT', { current })
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(clean), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        // already renamed away
      }
    }
    return { revision: refinementSettingsRevision(clean) }
  }

  private stored(): RefinementSettings | undefined {
    try {
      if (statSync(this.file).size > MAX_SETTINGS_BYTES) return undefined
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      return validateAgainst(Schema, value).ok ? { ...(value as RefinementSettings) } : undefined
    } catch {
      return undefined
    }
  }
}
