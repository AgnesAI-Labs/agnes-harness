import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RefinementSettings, RefinementSettingsSnapshot } from '@agnes/protocol'
import { DEFAULT_REFINEMENT_SETTINGS, validateAgainst } from '@agnes/protocol'
import { RefinementSettings as Schema } from '@agnes/protocol/gen/agnes-v1'
import { credentialFileEnforcement, readApiKeyFileSync } from './adapters/credential-files.js'
import { isGenericCredential } from './adapters/credential-store.js'
import { createPlatform } from './adapters/platform.js'
import { isUsableCredential } from './configuration-credential-availability.js'
import { MAX_SETTINGS_BYTES } from './settings-file.js'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * The version a client read, for a conditional save. A saved file carries a fresh nonce from each
 * save, so every save gets a revision never seen before: switching off and on again does not bring
 * back an old revision, and work begun under the old one can tell. Defaults and files written before
 * the nonce existed name the value alone.
 */
export const refinementSettingsRevision = (settings: RefinementSettings, nonce?: string): string =>
  sha256(
    JSON.stringify({
      enabled: settings.enabled,
      mode: settings.mode,
      credentialRef: settings.credentialRef,
      ...(nonce === undefined ? {} : { nonce }),
    }),
  )
const NONCE = /^[0-9a-f-]{36}$/

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
  private readonly enforcement = credentialFileEnforcement(createPlatform())
  constructor(
    dataDir: string,
    profile: string,
    private readonly home = basename(dataDir) === 'data' ? dirname(dataDir) : dataDir,
  ) {
    this.dir = join(dataDir, 'refinement')
    this.file = join(this.dir, `${sha256(profile)}.json`)
  }

  /** Local credential-store boundary. Only the private review adapter consumes the value. */
  serviceKey(ref: string): string | undefined {
    try {
      const credential: unknown = JSON.parse(readApiKeyFileSync(this.home, ref, this.enforcement))
      if (isGenericCredential(credential) && isUsableCredential(credential.value)) return credential.value
    } catch {
      // Missing, corrupt or inaccessible credentials all close the gate.
    }
    return undefined
  }

  read(): RefinementSettingsSnapshot {
    const stored = this.stored()
    const settings = stored?.settings ?? structuredClone(DEFAULT_REFINEMENT_SETTINGS)
    const revision = refinementSettingsRevision(settings, stored?.nonce)
    if (settings.credentialRef && !this.serviceKey(settings.credentialRef))
      return { settings: { ...settings, enabled: false }, revision, credentialMissing: true }
    return { settings, revision }
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
    if (
      !validateAgainst(Schema, settings).ok ||
      (settings.credentialRef && !this.serviceKey(settings.credentialRef))
    )
      throw failure('CONFIG_INVALID_INPUT')
    const { enabled, mode, credentialRef } = settings
    const clean: RefinementSettings =
      credentialRef === undefined ? { enabled: false, mode } : { enabled, mode, credentialRef }
    const current = this.read()
    if (current.revision !== expectedRevision) throw failure('CONFIG_REVISION_CONFLICT', { current })
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ settings: clean, nonce }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        // already renamed away
      }
    }
    return { revision: refinementSettingsRevision(clean, nonce) }
  }

  /** The saved settings and the nonce of their save; a file from before the nonce holds the settings alone. */
  private stored(): { settings: RefinementSettings; nonce?: string } | undefined {
    try {
      if (statSync(this.file).size > MAX_SETTINGS_BYTES) return undefined
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown> | null
      let raw: unknown = value
      let nonce: string | undefined
      if (value && typeof value === 'object' && 'nonce' in value) {
        if (Object.keys(value).length !== 2 || typeof value.nonce !== 'string' || !NONCE.test(value.nonce))
          return undefined
        raw = value.settings
        nonce = value.nonce
      }
      // Pre-service-key releases could persist an enabled switch without a binding.
      if (
        raw &&
        typeof raw === 'object' &&
        'enabled' in raw &&
        raw.enabled === true &&
        !('credentialRef' in raw)
      )
        raw = { ...raw, enabled: false }
      if (!validateAgainst(Schema, raw).ok) return undefined
      return { settings: raw as RefinementSettings, ...(nonce ? { nonce } : {}) }
    } catch {
      return undefined
    }
  }
}
