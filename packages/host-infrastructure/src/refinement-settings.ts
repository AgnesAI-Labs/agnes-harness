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
import {
  apiKeyFileStampSync,
  credentialFileEnforcement,
  credentialFileWrites,
  readApiKeyFileSync,
} from './adapters/credential-files.js'
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
 * Read it again whenever the answer matters (before planning, before applying); never keep a copy.
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
type CurrentSnapshot = EffectiveSnapshot & { modelOption?: RefinementModelOption }
/** What the files said when last read, and how to tell whether they still say it. */
type Resolved = {
  snapshot: CurrentSnapshot
  key: string | undefined
  ref: string | undefined
  stamp: string
  changes: string
  checkedAt: number
}

/**
 * How long a hot read trusts what it last read before checking the files' metadata again. Saves and
 * credential writes made in this process are seen at once; this bounds how late a change made by
 * another process (a worker's daemon, a hand edit) is seen. Metadata checks are a few lstat calls,
 * and only a changed stamp reads a file, so the switch and the key cost no file I/O per call.
 */
const RECHECK_MS = 1_000

/** Saves by any store of this process: every store of the same profile sees one without waiting. */
let saves = 0
const localChanges = (): string => `${saves}:${credentialFileWrites()}`

function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : '-'
  } catch {
    return '!'
  }
}

function keyStamp(home: string, ref: string | undefined): string {
  if (!ref) return ''
  try {
    return apiKeyFileStampSync(home, ref)
  } catch {
    return '!'
  }
}

/** A snapshot of its own for each caller, so no caller can change what the next one is served. */
const copy = ({ settings, endpoints, modelOption, ...rest }: CurrentSnapshot): CurrentSnapshot => ({
  ...rest,
  settings: { ...settings },
  endpoints: [...endpoints] as Endpoints,
  ...(modelOption ? { modelOption: { ...modelOption } } : {}),
})

/**
 * The refinement settings of one profile, in `<dataDir>/refinement/<sha256(profile)>.json`. Refinement is
 * off unless this file says otherwise: a missing, unreadable or invalid file reads as the defaults, and no
 * other key (a preset, a profile document) can turn it on. Reads and writes are synchronous so a caller can
 * check the switch at the instant it matters; the file is tiny and replaced in one rename.
 *
 * The switch is read on hot paths (every session, plan and dispatch), so `current()` answers from what
 * the settings file and the service key said when last read, rechecked as `RECHECK_MS` describes. A
 * key that could not be read is looked for again on every call, so a rename caught midway heals at once.
 * `read()` and `save()` serve the settings page and always check the files first.
 */
export class RefinementSettingsStore implements RefinementSettingsPort {
  private readonly dir: string
  private readonly file: string
  private readonly endpoints: Readonly<Endpoints>
  private readonly enforcement = credentialFileEnforcement(createPlatform())
  private cache: Resolved | undefined
  constructor(
    dataDir: string,
    profile: string,
    private readonly home = basename(dataDir) === 'data' ? dirname(dataDir) : dataDir,
    endpoints: Readonly<Endpoints> = REFINEMENT_ENDPOINTS,
    private readonly clock: () => number = () => performance.now(),
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

  /** The settings page's read: the files as they are now, so a key deleted a moment ago reads as missing. */
  read(): EffectiveSnapshot {
    const { modelOption: _modelOption, ...snapshot } = copy(this.resolve(true).snapshot)
    return snapshot
  }

  current(): CurrentSnapshot {
    return copy(this.resolve(false).snapshot)
  }

  /**
   * `current()` with the service key it resolved, for a dispatch: one resolution answers both, so a
   * request reads the key file at most once, and not at all while nothing changed.
   */
  currentWithKey(): { snapshot: CurrentSnapshot; key: string | undefined } {
    const { snapshot, key } = this.resolve(false)
    return { snapshot: copy(snapshot), key }
  }

  private resolve(recheck: boolean): Resolved {
    const at = this.clock()
    const changes = localChanges()
    const cached = this.cache
    if (
      cached &&
      !recheck &&
      cached.changes === changes &&
      !cached.snapshot.credentialMissing &&
      at >= cached.checkedAt &&
      at - cached.checkedAt < RECHECK_MS
    )
      return cached
    if (cached && `${fileStamp(this.file)}|${keyStamp(this.home, cached.ref)}` === cached.stamp) {
      cached.changes = changes
      cached.checkedAt = at
      return cached
    }
    // Each stamp is taken before its file is read: a change landing after the stamp shows next time.
    const settingsStamp = fileStamp(this.file)
    const stored = this.stored()
    const ref = stored?.settings.credentialRef
    const stamp = `${settingsStamp}|${keyStamp(this.home, ref)}`
    const key = ref ? this.serviceKey(ref) : undefined
    this.cache = { snapshot: this.snapshotOf(stored, key), key, ref, stamp, changes, checkedAt: at }
    return this.cache
  }

  private snapshotOf(stored: StoredSettings | undefined, key: string | undefined): CurrentSnapshot {
    const raw = stored?.settings ?? DEFAULT_REFINEMENT_SETTINGS
    const baseUrl = raw.baseUrl ?? this.endpoints[0]
    const retired = !isAllowedRefinementBaseUrl(baseUrl, this.endpoints)
    const settings = retired
      ? { ...raw, enabled: false as const, baseUrl: this.endpoints[0] }
      : { ...raw, baseUrl }
    const revision = refinementSettingsRevision(settings, stored?.nonce)
    const endpoints: Endpoints = [...this.endpoints]
    if (settings.credentialRef && !key)
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
    const current = copy(this.resolve(true).snapshot)
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
      // Every store of this process reads the saved settings on its next call, this one included.
      saves++
      this.cache = undefined
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
