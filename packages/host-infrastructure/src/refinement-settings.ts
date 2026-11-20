import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_REFINEMENT_BASE_URL,
  isAllowedRefinementBaseUrl,
  REFINEMENT_ENDPOINTS,
} from '@agnes/distribution/refinement-model'
import type { RefinementModelOption, RefinementSettings, RefinementSettingsSnapshot } from '@agnes/protocol'
import { DEFAULT_REFINEMENT_SETTINGS, validateAgainst } from '@agnes/protocol'
import {
  RefinementModelOption as ModelOptionSchema,
  RefinementSettings as Schema,
} from '@agnes/protocol/gen/agnes-v1'
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
      model: settings.model,
      baseUrl: settings.baseUrl ?? DEFAULT_REFINEMENT_BASE_URL,
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

type StoredSettings = { settings: RefinementSettings; nonce?: string; modelOption?: RefinementModelOption }
type Endpoints = [string, ...string[]]
type EffectiveSnapshot = RefinementSettingsSnapshot & {
  settings: RefinementSettings & { baseUrl: string }
  endpoints: Endpoints
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
  private readonly endpoints: Readonly<Endpoints>
  private readonly enforcement = credentialFileEnforcement(createPlatform())
  constructor(
    dataDir: string,
    profile: string,
    private readonly home = basename(dataDir) === 'data' ? dirname(dataDir) : dataDir,
    endpoints: Readonly<Endpoints> = REFINEMENT_ENDPOINTS,
  ) {
    this.dir = join(dataDir, 'refinement')
    this.file = join(this.dir, `${sha256(profile)}.json`)
    this.endpoints = [...endpoints]
  }

  /** Local credential-store boundary for review discovery and inference. */
  serviceKey(ref: string): string | undefined {
    try {
      const credential: unknown = JSON.parse(readApiKeyFileSync(this.home, ref, this.enforcement))
      if (isGenericCredential(credential) && isUsableCredential(credential.value)) return credential.value
    } catch {
      // Missing, corrupt or inaccessible credentials all close the gate.
    }
    return undefined
  }

  read(): EffectiveSnapshot {
    const { modelOption: _modelOption, ...snapshot } = this.current()
    return snapshot
  }

  current(): EffectiveSnapshot & { modelOption?: RefinementModelOption } {
    const stored = this.stored()
    const raw = stored?.settings ?? DEFAULT_REFINEMENT_SETTINGS
    const baseUrl = raw.baseUrl ?? this.endpoints[0]
    const retired = !isAllowedRefinementBaseUrl(baseUrl, this.endpoints)
    const settings = retired
      ? { ...raw, enabled: false as const, baseUrl: this.endpoints[0] }
      : { ...raw, baseUrl }
    const revision = refinementSettingsRevision(settings, stored?.nonce)
    const endpoints: Endpoints = [...this.endpoints]
    if (settings.credentialRef && !this.serviceKey(settings.credentialRef))
      return { settings: { ...settings, enabled: false }, revision, endpoints, credentialMissing: true }
    return {
      settings,
      revision,
      endpoints,
      ...(!retired && stored?.modelOption ? { modelOption: stored.modelOption } : {}),
    }
  }

  /** Resolve a save target before catalogue validation can send credentials to it. */
  resolveBaseUrl(baseUrl = this.endpoints[0]): string {
    if (!isAllowedRefinementBaseUrl(baseUrl, this.endpoints)) throw failure('CONFIG_INVALID_INPUT')
    return baseUrl
  }

  /**
   * Saves the whole settings while the stored value still has `expectedRevision`; otherwise refuses with
   * `CONFIG_REVISION_CONFLICT` and the current snapshot, and writes nothing. The compare and the write run
   * without yielding, so no other save in this process can slip between them.
   */
  save(
    settings: RefinementSettings,
    expectedRevision: string,
    modelOption?: RefinementModelOption,
  ): { revision: string } {
    if (
      !validateAgainst(Schema, settings).ok ||
      (modelOption &&
        (!validateAgainst(ModelOptionSchema, modelOption).ok || modelOption.id !== settings.model))
    )
      throw failure('CONFIG_INVALID_INPUT')
    const baseUrl = this.resolveBaseUrl(settings.baseUrl)
    const current = this.current()
    if (current.revision !== expectedRevision) throw failure('CONFIG_REVISION_CONFLICT', { current })
    const { credentialRef, model } = settings
    // A disabled profile may switch gateways while retaining a key reference that needs recovery.
    if (
      credentialRef &&
      !this.serviceKey(credentialRef) &&
      (settings.enabled ||
        credentialRef !== current.settings.credentialRef ||
        baseUrl === current.settings.baseUrl)
    )
      throw failure('CONFIG_INVALID_INPUT')
    const clean = { ...settings, baseUrl }
    const option =
      modelOption ??
      (current.settings.baseUrl === baseUrl &&
      current.settings.credentialRef === credentialRef &&
      current.settings.model === model
        ? current.modelOption
        : undefined)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ settings: clean, nonce, modelOption: option }), {
        mode: 0o600,
        flag: 'wx',
      })
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
  private stored(): StoredSettings | undefined {
    try {
      if (statSync(this.file).size > MAX_SETTINGS_BYTES) return undefined
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown> | null
      let raw: unknown = value
      let nonce: string | undefined
      let modelOption: unknown
      if (value && typeof value === 'object' && 'nonce' in value) {
        if (
          Object.keys(value).some((key) => key !== 'settings' && key !== 'nonce' && key !== 'modelOption') ||
          typeof value.nonce !== 'string' ||
          !NONCE.test(value.nonce)
        )
          return undefined
        raw = value.settings
        nonce = value.nonce
        modelOption = value.modelOption
      }
      // Older files can carry an enabled switch before one or both bindings were required.
      if (
        raw &&
        typeof raw === 'object' &&
        'enabled' in raw &&
        raw.enabled === true &&
        (!('credentialRef' in raw) || !('model' in raw))
      )
        raw = { ...raw, enabled: false }
      if (!validateAgainst(Schema, raw).ok) return undefined
      const settings = raw as RefinementSettings
      const option = modelOption as RefinementModelOption | undefined
      if (
        option !== undefined &&
        (!validateAgainst(ModelOptionSchema, option).ok || option.id !== settings.model)
      )
        return undefined
      return { settings, ...(nonce ? { nonce } : {}), ...(option ? { modelOption: option } : {}) }
    } catch {
      return undefined
    }
  }
}
