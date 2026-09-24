import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  API_KEY_PROVIDER_REGISTRY,
  type ApiKeyProviderRegistryEntry,
  CODEX_ID,
  type CodexCredentialStore,
  type CodexInteraction,
  fetchProviderModels,
  getApiKeyProvider,
  getSubscriptionProvider,
  SUBSCRIPTION_PROVIDER_REGISTRY,
  type SubscriptionProviderEntry,
  subscriptionAuth,
  subscriptionCredentialAuth,
  subscriptionModels,
  type testCodexCredential,
  testSubscriptionCredential,
} from '@agnes/ai'
import type {
  ConfigAccount,
  ConfigAccountInput,
  ConfigModel,
  ConfigOAuthInput,
  ConfigOAuthResult,
  ConfigProvider,
  ConfigProvidersResult,
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigTestInput,
  ConfigTestResult,
  ModelRecord,
} from '@agnes/protocol'
import { renameWriteThrough, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { subscriptionCredentials } from './adapters/codex-credentials.js'
import {
  createCredentialStore,
  isSubscriptionCredential,
  type StoredCredential,
} from './adapters/credential-store.js'
import { createWin32Platform } from './adapters/platform.js'
import { type CodexLoginDependencies, createCodexLogin } from './codex-login.js'
import { withConfigurationLock } from './configuration-lock.js'
import type { RuntimeProfileManifest } from './profile/types.js'

type ConfigurationProvider = ApiKeyProviderRegistryEntry | SubscriptionProviderEntry

/** Fixed setup failures exposed to the local configuration RPC.  Messages never contain input. */
export type ConfigurationErrorCode =
  | 'CONFIG_INVALID_INPUT'
  | 'CONFIG_UNKNOWN_PROVIDER'
  | 'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED'
  | 'CONFIG_CREDENTIAL_REQUIRED'
  | 'CONFIG_CREDENTIAL_STORE'
  | 'CONFIG_PROVIDER_UNAVAILABLE'
  | 'CONFIG_TEST_FAILED'
  | 'CONFIG_SUBSCRIPTION_AUTH'
  | 'CONFIG_SUBSCRIPTION_QUOTA'
  | 'CONFIG_SUBSCRIPTION_RATE_LIMIT'
  | 'CONFIG_SUBSCRIPTION_TIMEOUT'
  | 'CONFIG_SUBSCRIPTION_MODEL'
  | 'CONFIG_SUBSCRIPTION_FAILED'
  | 'CONFIG_MODEL_UNAVAILABLE'
  | 'CONFIG_REVISION_CONFLICT'
  | 'CONFIG_PERSIST_FAILED'
  | 'CONFIG_INVALID_STATE'

export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode) {
    super(
      code.startsWith('CONFIG_SUBSCRIPTION_')
        ? 'Subscription model test failed.'
        : code === 'CONFIG_INVALID_INPUT'
          ? 'Configuration input is invalid.'
          : code === 'CONFIG_UNKNOWN_PROVIDER'
            ? 'The selected provider is unavailable.'
            : code === 'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED'
              ? 'This provider does not support endpoint overrides.'
              : code === 'CONFIG_CREDENTIAL_REQUIRED'
                ? 'An API key is required.'
                : code === 'CONFIG_CREDENTIAL_STORE'
                  ? 'The credential store is unavailable.'
                  : code === 'CONFIG_PROVIDER_UNAVAILABLE'
                    ? 'The provider catalogue is unavailable.'
                    : code === 'CONFIG_TEST_FAILED'
                      ? 'The provider connection test failed.'
                      : code === 'CONFIG_MODEL_UNAVAILABLE'
                        ? 'The selected model is unavailable.'
                        : code === 'CONFIG_REVISION_CONFLICT'
                          ? 'Configuration changed; reload and try again.'
                          : code === 'CONFIG_PERSIST_FAILED'
                            ? 'Configuration could not be saved.'
                            : 'The saved configuration is invalid.',
    )
    this.name = 'ConfigurationError'
  }
}

export interface ConfigurationService {
  oauth?(input: ConfigOAuthInput, owner: object, signal: AbortSignal): Promise<ConfigOAuthResult>
  get(): Promise<ConfigSnapshot>
  providers(): Promise<ConfigProvidersResult>
  test(input: ConfigTestInput): Promise<ConfigTestResult>
  save(input: ConfigSaveInput): Promise<ConfigSnapshot>
  account(input: ConfigAccountInput): Promise<ConfigSnapshot>
  profileInput(): Promise<Partial<RuntimeProfileManifest>>
}

export type ConfigurationServiceOptions = {
  subscriptionLogin?: CodexLoginDependencies['login']
  subscriptionTest?: typeof testSubscriptionCredential
  /** Compatibility injection retained for the original Codex-focused tests. */
  codexLogin?: (store: CodexCredentialStore, interaction: CodexInteraction) => Promise<void>
  codexTest?: typeof testCodexCredential
  home: string
  profile: string
  /** Injectable transport for focused tests; production uses the platform fetch implementation. */
  request?: typeof globalThis.fetch
}

type StoredConfigurationV1 = {
  version: 1
  profile: string
  revision: number
  provider: {
    id: string
    baseUrl: string
    model: string
    credentialRef: string
    models: ConfigModel[]
  }
}

type StoredAccount = StoredConfigurationV1['provider'] & {
  accountId: string
  label: string
  route: string
  enabled: boolean
  authType: 'api-key' | 'oauth'
}
type StoredConfiguration = {
  version: 2
  profile: string
  revision: number
  accounts: StoredAccount[]
  defaultAccountId: string | null
}
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,47}$/
function accountId(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT.test(value)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}
function legacyAccount(id: string): string {
  return `legacy-${id}`
}
function migrate(state: StoredConfigurationV1): StoredConfiguration {
  const id = legacyAccount(state.provider.id)
  return {
    version: 2,
    profile: state.profile,
    revision: state.revision,
    defaultAccountId: id,
    accounts: [
      {
        ...state.provider,
        accountId: id,
        label: state.provider.id,
        route: state.provider.id,
        enabled: true,
        authType: state.provider.id === CODEX_ID ? 'oauth' : 'api-key',
      },
    ],
  }
}
function accountRef(entry: ConfigurationProvider, profile: string, id: string, revision: number): string {
  const key = createHash('sha256').update(`${profile}/${id}`).digest('hex').slice(0, 24)
  return `secret://${entry.id}/account-${key}-r${revision}`
}

type StaticCatalogue = {
  entry: ConfigurationProvider
  records: ModelRecord[]
}

const FILE = 'configuration.json'
const LOCK_FILE = 'configuration-lock.sqlite'
const LEGACY_FILE = 'onboarding-selection.json'
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_MODELS = 4096
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MODEL = /^[^\p{Cc}\p{Z}\s]{1,256}$/u
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_TEXT = /^[^\p{Cc}]*$/u
const COMPATIBLE_APIS = new Set(['openai-completions', 'openai-responses'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, i) => key === keys[i])
}

const isUsableCredential = (value: string): boolean => /\P{C}/u.test(value.trim())

function inputObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}

function stringField(value: unknown, max: number, nonempty = true): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    !SAFE_TEXT.test(value) ||
    (nonempty && value.length === 0)
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}

function parseBaseUrl(value: unknown): string {
  const raw = stringField(value, 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.length === 0 ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.hostname.includes('{') ||
    raw !== raw.trim()
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return raw
}

function parseApiKey(value: unknown): string {
  const key = stringField(value, 65_536)
  if (!isUsableCredential(key)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return key.trim()
}

function parseModel(value: unknown): string {
  if (typeof value !== 'string' || !MODEL.test(value)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}

function providerFor(value: unknown, authType?: 'api-key' | 'oauth'): ConfigurationProvider {
  if (typeof value !== 'string' || !PROVIDER.test(value)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const entry =
    authType === 'oauth'
      ? getSubscriptionProvider(value)
      : (getApiKeyProvider(value) ?? getSubscriptionProvider(value))
  if (!entry) throw new ConfigurationError('CONFIG_UNKNOWN_PROVIDER')
  return entry
}

function providerEndpoint(entry: ConfigurationProvider, value: unknown): string {
  const baseUrl = value === undefined ? entry.baseUrl : parseBaseUrl(value)
  const defaultUrl = entry.baseUrl.endsWith('/') ? entry.baseUrl.slice(0, -1) : entry.baseUrl
  const requestedUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (requestedUrl !== defaultUrl && !COMPATIBLE_APIS.has(entry.api))
    throw new ConfigurationError('CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED')
  return getSubscriptionProvider(entry.id) === entry ? entry.baseUrl : baseUrl
}

function credentialRef(entry: ConfigurationProvider, profile: string, revision: number): string {
  const profileId = createHash('sha256').update(profile).digest('hex').slice(0, 16)
  return `secret://${entry.id}/profile-${profileId}-r${revision}`
}

function parseTestInput(value: unknown): {
  entry: ConfigurationProvider
  baseUrl: string
  apiKey?: string
  model?: string
} {
  const input = inputObject(value)
  if (
    !Object.keys(input).every((key) =>
      ['providerId', 'baseUrl', 'apiKey', 'accountId', 'model'].includes(key),
    )
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const entry = providerFor(input.providerId)
  const baseUrl = providerEndpoint(entry, input.baseUrl)
  if (entry.id === CODEX_ID && input.apiKey !== undefined)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const apiKey = input.apiKey === undefined ? undefined : parseApiKey(input.apiKey)
  return {
    entry,
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(input.model === undefined ? {} : { model: parseModel(input.model) }),
  }
}

function parseSaveInput(value: unknown): {
  entry: ConfigurationProvider
  baseUrl: string
  model: string
  expectedRevision?: number
  apiKey?: string
} {
  const input = inputObject(value)
  if (
    !Object.keys(input).every((key) =>
      [
        'providerId',
        'baseUrl',
        'apiKey',
        'model',
        'expectedRevision',
        'accountId',
        'label',
        'enabled',
        'makeDefault',
      ].includes(key),
    )
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const parsed = parseTestInput({
    providerId: input.providerId,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
  })
  const model = parseModel(input.model)
  if (
    input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return {
    ...parsed,
    model,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision as number }),
  }
}

const THINKING_LEVEL_NAMES = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * `false` disables reasoning outright; a non-empty dict of level -> wire value declares exactly
 * which levels this deployment has verified for the model, replacing whatever the installed
 * catalogue claims. An empty dict is rejected rather than silently treated as "no override" or
 * "reasoning with no levels" - either `false` or a real declaration is required, matching the
 * stored config's fail-closed decode discipline everywhere else in this file.
 */
function normalizeThinkingEfforts(value: unknown): false | Record<string, string> | undefined {
  if (value === false) return false
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length === 0) return undefined
  for (const key of keys) {
    if (!THINKING_LEVEL_NAMES.has(key)) return undefined
    const wire = value[key]
    if (typeof wire !== 'string' || wire.length === 0) return undefined
  }
  return value as Record<string, string>
}

function normalizeModel(value: unknown): ConfigModel | undefined {
  if (
    !isRecord(value) ||
    (!exactKeys(value, ['id', 'name']) && !exactKeys(value, ['id', 'name', 'thinkingEfforts']))
  )
    return undefined
  if (typeof value.id !== 'string' || !MODEL.test(value.id)) return undefined
  if (
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > 256 ||
    !SAFE_TEXT.test(value.name)
  )
    return undefined
  if (!('thinkingEfforts' in value)) return { id: value.id, name: value.name }
  const thinkingEfforts = normalizeThinkingEfforts(value.thinkingEfforts)
  if (thinkingEfforts === undefined) return undefined
  return { id: value.id, name: value.name, thinkingEfforts }
}

function decodeConfiguration(value: unknown, profile: string): StoredConfigurationV1 | undefined {
  if (!isRecord(value) || !exactKeys(value, ['version', 'profile', 'revision', 'provider'])) return undefined
  if (value.version !== 1 || value.profile !== profile || !PROFILE.test(profile)) return undefined
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return undefined
  const provider = value.provider
  if (
    !isRecord(provider) ||
    (!exactKeys(provider, ['id', 'baseUrl', 'model', 'models']) &&
      !exactKeys(provider, ['id', 'baseUrl', 'model', 'credentialRef', 'models']))
  )
    return undefined
  let entry: ConfigurationProvider
  try {
    entry = providerFor(provider.id)
    providerEndpoint(entry, provider.baseUrl)
  } catch {
    return undefined
  }
  if (typeof provider.baseUrl !== 'string' || typeof provider.model !== 'string') return undefined
  if (
    !MODEL.test(provider.model) ||
    !Array.isArray(provider.models) ||
    provider.models.length === 0 ||
    provider.models.length > MAX_MODELS
  )
    return undefined
  const models = provider.models.map(normalizeModel)
  if (models.some((model) => model === undefined)) return undefined
  const normalized = models as ConfigModel[]
  if (new Set(normalized.map((model) => model.id)).size !== normalized.length) return undefined
  if (!normalized.some((model) => model.id === provider.model)) return undefined
  const ref =
    typeof provider.credentialRef === 'string'
      ? provider.credentialRef
      : credentialRef(entry, profile, value.revision as number)
  if (typeof ref !== 'string' || ref !== credentialRef(entry, profile, value.revision as number))
    return undefined
  return {
    version: 1,
    profile,
    revision: value.revision as number,
    provider: {
      id: entry.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      credentialRef: ref,
      models: normalized,
    },
  }
}

function decodeState(value: unknown, profile: string): StoredConfiguration | undefined {
  const legacy = decodeConfiguration(value, profile)
  if (legacy) return migrate(legacy)
  if (
    !isRecord(value) ||
    !exactKeys(value, ['version', 'profile', 'revision', 'accounts', 'defaultAccountId']) ||
    value.version !== 2 ||
    value.profile !== profile ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 64
  )
    return undefined
  const accounts: StoredAccount[] = []
  for (const row of value.accounts) {
    if (
      !isRecord(row) ||
      ![9, 10].includes(Object.keys(row).length) ||
      !Object.keys(row).every((key) =>
        [
          'id',
          'baseUrl',
          'model',
          'models',
          'credentialRef',
          'accountId',
          'label',
          'route',
          'enabled',
          'authType',
        ].includes(key),
      ) ||
      typeof row.accountId !== 'string' ||
      !ACCOUNT.test(row.accountId) ||
      typeof row.label !== 'string' ||
      !row.label.trim() ||
      row.label.length > 128 ||
      !SAFE_TEXT.test(row.label) ||
      typeof row.enabled !== 'boolean'
    )
      return undefined
    const decoded = decodeConfiguration(
      {
        version: 1,
        profile,
        revision: value.revision,
        provider: { id: row.id, baseUrl: row.baseUrl, model: row.model, models: row.models },
      },
      profile,
    )
    if (!decoded) return undefined
    const authType =
      row.authType === 'api-key' || row.authType === 'oauth'
        ? row.authType
        : decoded.provider.id === CODEX_ID
          ? 'oauth'
          : 'api-key'
    const entry = providerFor(decoded.provider.id, authType)
    const route = row.route
    if (typeof route !== 'string') return undefined
    if (
      route !== `account-${row.accountId}` &&
      !(row.accountId === legacyAccount(entry.id) && route === entry.route)
    )
      return undefined
    const ref = row.credentialRef
    if (typeof ref !== 'string') return undefined
    const prefix = accountRef(entry, profile, row.accountId, 1).replace(/1$/, '')
    const suffix = ref.startsWith(prefix) ? ref.slice(prefix.length) : ''
    const grantSuffix =
      authType === 'oauth'
        ? /^([1-9][0-9]*)(?:-g[a-f0-9]{32})?$/.exec(suffix)
        : /^([1-9][0-9]*)$/.exec(suffix)
    const revision = Number(grantSuffix?.[1])
    const validRef =
      grantSuffix !== null && Number.isSafeInteger(revision) && revision <= (value.revision as number)
    const oldPrefix = credentialRef(entry, profile, 1).replace(/1$/, '')
    const oldRevision = ref.startsWith(oldPrefix) ? Number(ref.slice(oldPrefix.length)) : NaN
    const legacyRef =
      row.accountId === legacyAccount(entry.id) &&
      (ref === entry.credentialRef ||
        (Number.isSafeInteger(oldRevision) && oldRevision > 0 && oldRevision <= (value.revision as number)))
    if (!validRef && !legacyRef) return undefined
    accounts.push({
      ...decoded.provider,
      accountId: row.accountId,
      label: row.label,
      route,
      enabled: row.enabled,
      authType,
      credentialRef: ref,
    })
  }
  if (
    new Set(accounts.map((row) => row.accountId)).size !== accounts.length ||
    new Set(accounts.map((row) => row.route)).size !== accounts.length
  )
    return undefined
  if (
    value.defaultAccountId !== null &&
    !accounts.some((row) => row.accountId === value.defaultAccountId && row.enabled)
  )
    return undefined
  if (value.defaultAccountId === null && accounts.some((row) => row.enabled)) return undefined
  return {
    version: 2,
    profile,
    revision: value.revision as number,
    accounts,
    defaultAccountId: value.defaultAccountId as string | null,
  }
}

function cloneRecord(record: ModelRecord, baseUrl: string, route: string): ModelRecord {
  return { ...structuredClone(record), baseUrl, route }
}

const windowsDirectories = createWin32Platform().matches()

/**
 * A deployment's declared `thinkingEfforts` always wins over whatever the installed catalogue
 * (pi-ai's bundled data today) says about a model's reasoning capability — not a patch over gaps,
 * a full replacement, in both directions: `false` turns off a model the catalogue wrongly marks as
 * reasoning-capable, and a declared map turns one on that the catalogue wrongly marks as not. Absent
 * entirely (the common case), the catalogue's own `reasoning`/`thinkingLevelMap` passes through untouched.
 */
function applyThinkingEfforts(
  record: ModelRecord,
  thinkingEfforts: ConfigModel['thinkingEfforts'],
): ModelRecord {
  if (thinkingEfforts === undefined) return record
  if (thinkingEfforts === false) {
    const { thinkingLevelMap: _drop, ...rest } = record
    return { ...rest, reasoning: false }
  }
  return { ...record, reasoning: true, thinkingLevelMap: thinkingEfforts }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    if (windowsDirectories) {
      windowsEnsurePrivateDirectorySync(path)
      return
    }
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory')
  } catch {
    throw new ConfigurationError('CONFIG_PERSIST_FAILED')
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const parent = dirname(path)
  await ensureDirectory(parent)
  const temporary = join(
    parent,
    `.${FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.chmod(0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameWriteThrough(temporary, path, { noFollow: true })
  } catch {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw new ConfigurationError('CONFIG_PERSIST_FAILED')
  }
}

export function createConfigurationService(options: ConfigurationServiceOptions): ConfigurationService {
  const home = resolve(options.home)
  if (!PROFILE.test(options.profile)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const profile = options.profile
  const profileDir = join(home, 'profiles', profile)
  const configPath = join(profileDir, FILE)
  const lockPath = join(profileDir, LOCK_FILE)
  const legacyPath = join(profileDir, LEGACY_FILE)
  const request = options.request ?? globalThis.fetch
  const credentialStore = createCredentialStore({ root: home })
  let loading: Promise<StoredConfiguration | undefined> | undefined
  const catalogueCache = new Map<string, Promise<StaticCatalogue>>()
  let saveTail: Promise<ConfigSnapshot> = Promise.resolve({
    profile,
    revision: 0,
    configured: false,
    provider: null,
    effect: 'new-sessions',
  })

  const readJsonFile = async (path: string): Promise<unknown | undefined> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new ConfigurationError('CONFIG_INVALID_STATE')
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES)
      throw new ConfigurationError('CONFIG_INVALID_STATE')
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new ConfigurationError('CONFIG_INVALID_STATE')
    }
  }

  const staticCatalogue = (entry: ConfigurationProvider): Promise<StaticCatalogue> => {
    const cacheKey = `${entry.id}:${getSubscriptionProvider(entry.id) === entry ? 'oauth' : 'api-key'}`
    const prior = catalogueCache.get(cacheKey)
    if (prior) return prior
    const next = Promise.resolve()
      .then(() => {
        const subscription = getSubscriptionProvider(entry.id)
        const records = subscription === entry ? subscription.models() : undefined
        return records
          ? { records }
          : Promise.resolve(entry.createAdapter()).then((adapter) => ({
              records: adapter.models(entry.route),
            }))
      })
      .then(({ records }) => {
        if (records.length === 0) throw new ConfigurationError('CONFIG_PROVIDER_UNAVAILABLE')
        return { entry, records: records.map((record) => structuredClone(record)) }
      })
      .catch((error) => {
        if (error instanceof ConfigurationError) throw error
        throw new ConfigurationError('CONFIG_PROVIDER_UNAVAILABLE')
      })
    catalogueCache.set(cacheKey, next)
    return next
  }

  const readCredential = async (ref: string): Promise<StoredCredential | null> => {
    try {
      return await credentialStore.read(ref)
    } catch {
      throw new ConfigurationError('CONFIG_CREDENTIAL_STORE')
    }
  }

  const loadState = async (): Promise<StoredConfiguration | undefined> => {
    if (loading) return loading
    loading = (async () => {
      const stored = await readJsonFile(configPath)
      if (stored !== undefined) {
        const state = decodeState(stored, profile)
        if (!state) throw new ConfigurationError('CONFIG_INVALID_STATE')
        return state
      }
      // Read the pre-unified CLI selection as a compatibility bridge.  It is accepted only when
      // the reviewed provider/ref and managed credential still agree; malformed metadata is ignored.
      const legacy = await readJsonFile(legacyPath).catch((error) => {
        if (error instanceof ConfigurationError && error.code === 'CONFIG_INVALID_STATE') return undefined
        throw error
      })
      if (
        !isRecord(legacy) ||
        !exactKeys(legacy, ['credentialRef', 'model', 'profile', 'route', 'thinking', 'version'])
      )
        return undefined
      const entry = getApiKeyProvider(typeof legacy.route === 'string' ? legacy.route : '')
      if (
        legacy.version !== 1 ||
        legacy.profile !== profile ||
        !entry ||
        legacy.credentialRef !== entry.credentialRef ||
        typeof legacy.model !== 'string' ||
        !MODEL.test(legacy.model)
      )
        return undefined
      const credential = await readCredential(entry.credentialRef)
      if (
        credential?.kind !== 'api-key' ||
        credential.provider !== entry.id ||
        !isUsableCredential(credential.value)
      )
        return undefined
      const catalogue = await staticCatalogue(entry).catch(() => undefined)
      if (!catalogue?.records.some((record) => record.id === legacy.model)) return undefined
      const models = catalogue.records.map((record) => ({ id: record.id, name: record.name }))
      return migrate({
        version: 1,
        profile,
        revision: 1,
        provider: {
          id: entry.id,
          baseUrl: entry.baseUrl,
          model: legacy.model,
          credentialRef: entry.credentialRef,
          models,
        },
      })
    })()
    try {
      return await loading
    } finally {
      loading = undefined
    }
  }

  const configuredCredential = async (
    ref: string,
    entry: ConfigurationProvider,
    authType: 'api-key' | 'oauth',
  ): Promise<boolean> => {
    const credential = await readCredential(ref)
    if (authType === 'oauth') return isSubscriptionCredential(credential, entry.id)
    return (
      credential?.kind === 'api-key' &&
      credential.provider === entry.id &&
      isUsableCredential(credential.value)
    )
  }

  const snapshot = async (state: StoredConfiguration | undefined): Promise<ConfigSnapshot> => {
    if (!state)
      return {
        profile,
        revision: 0,
        configured: false,
        provider: null,
        accounts: [],
        defaultAccountId: null,
        effect: 'new-sessions',
      }
    const accounts: ConfigAccount[] = await Promise.all(
      state.accounts.map(async (row) => ({
        accountId: row.accountId,
        label: row.label,
        providerId: row.id,
        route: row.route,
        baseUrl: row.baseUrl,
        model: row.model,
        models: structuredClone(row.models),
        enabled: row.enabled,
        authType: row.authType,
        credentialConfigured: await configuredCredential(
          row.credentialRef,
          providerFor(row.id, row.authType),
          row.authType,
        ),
      })),
    )
    const selected = accounts.find((row) => row.accountId === state.defaultAccountId && row.enabled)
    return {
      profile,
      revision: state.revision,
      configured: selected?.credentialConfigured ?? false,
      accounts,
      defaultAccountId: state.defaultAccountId,
      effect: 'new-sessions',
      provider: selected
        ? {
            id: selected.providerId,
            route: selected.route,
            baseUrl: selected.baseUrl,
            model: selected.model,
            credentialConfigured: selected.credentialConfigured,
          }
        : null,
    }
  }
  const get = async (): Promise<ConfigSnapshot> => snapshot(await loadState())
  const selectedAccount = (
    state: StoredConfiguration | undefined,
    input: ConfigTestInput,
  ): StoredAccount | undefined => {
    const id = input.accountId === undefined ? legacyAccount(input.providerId) : accountId(input.accountId)
    const row = state?.accounts.find((entry) => entry.accountId === id)
    if (row && row.id !== input.providerId) throw new ConfigurationError('CONFIG_INVALID_INPUT')
    return row
  }

  const providers = async (): Promise<ConfigProvidersResult> => ({
    providers: [
      ...API_KEY_PROVIDER_REGISTRY.map((entry): ConfigProvider => {
        const subscription = getSubscriptionProvider(entry.id)
        return {
          id: entry.id,
          label: entry.displayName,
          authMethods: subscription ? ['api-key', 'oauth'] : ['api-key'],
          ...(subscription ? { loginMethods: [...subscription.loginMethods] } : {}),
          api: entry.api,
          baseUrl: entry.baseUrl,
        }
      }),
      ...SUBSCRIPTION_PROVIDER_REGISTRY.filter((entry) => !getApiKeyProvider(entry.id)).map(
        (entry): ConfigProvider => ({
          id: entry.id,
          label: entry.displayName,
          authType: 'oauth',
          authMethods: ['oauth'],
          loginMethods: [...entry.loginMethods],
          api: entry.api,
          baseUrl: entry.baseUrl,
        }),
      ),
    ],
  })

  const test = async (input: ConfigTestInput): Promise<ConfigTestResult> => {
    const parsed = parseTestInput(input)
    const state = await loadState()
    const row = selectedAccount(state, input)
    const baseUrl = input.baseUrl === undefined ? (row?.baseUrl ?? parsed.baseUrl) : parsed.baseUrl
    // Never forward an existing account's key to an edited destination implicitly.
    const changedEndpoint = row && baseUrl.replace(/\/$/, '') !== row.baseUrl.replace(/\/$/, '')
    if (changedEndpoint && parsed.apiKey === undefined)
      throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
    const storedCredential = row ? await readCredential(row.credentialRef) : null
    let models = (await staticCatalogue(parsed.entry)).records.map((record) => ({
      id: record.id,
      name: record.name,
    }))
    if (row?.authType === 'oauth' && parsed.apiKey === undefined) {
      const provider = getSubscriptionProvider(row.id)
      if (!provider || !isSubscriptionCredential(storedCredential, row.id)) return { models, verified: false }
      try {
        const signal = AbortSignal.timeout(45_000)
        const store = subscriptionCredentials(home, row.credentialRef, provider.id)
        const runtime = subscriptionAuth(provider.id, store)
        const auth = await runtime.resolve(signal)
        models = (await runtime.available(signal)).map((record) => ({ id: record.id, name: record.name }))
        const model = parsed.model ?? row.model
        if (!models.some((entry) => entry.id === model))
          throw new ConfigurationError('CONFIG_SUBSCRIPTION_MODEL')
        await verifySubscriptionAuth(provider.id, auth, model, signal)
        return { models, verified: true }
      } catch (error) {
        if (error instanceof ConfigurationError) throw error
        throw new ConfigurationError('CONFIG_SUBSCRIPTION_AUTH')
      }
    }
    if (
      parsed.apiKey === undefined &&
      (storedCredential === null ||
        storedCredential.kind !== 'api-key' ||
        storedCredential.provider !== parsed.entry.id ||
        !isUsableCredential(storedCredential.value))
    )
      return { models, verified: false }
    const key = parsed.apiKey ?? (storedCredential?.kind === 'api-key' ? storedCredential.value : undefined)
    if (key === undefined) return { models, verified: false }
    const probed = await fetchProviderModels({
      api: parsed.entry.api,
      baseUrl,
      credential: key,
      request,
    })
    if (!probed) return { models, verified: false }
    const offered = new Set(probed.ids)
    const supported = models.filter((model) => offered.has(model.id))
    // The runtime catalogue is the installed, reviewed source of model capabilities. A remote
    // endpoint may narrow it, but cannot introduce an unreviewed model record into Host assembly.
    return supported.length === 0 ? { models, verified: false } : { models: supported, verified: true }
  }

  const persistState = async (state: StoredConfiguration): Promise<void> => {
    await ensureDirectory(home)
    await ensureDirectory(join(home, 'profiles'))
    await ensureDirectory(profileDir)
    const encoded = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CONFIG_BYTES)
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    await atomicWrite(configPath, encoded)
  }

  const saveInternal = async (input: ConfigSaveInput): Promise<ConfigSnapshot> => {
    const parsed = parseSaveInput(input)
    const current = await loadState()
    const revision = current?.revision ?? 0
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== revision)
      throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
    const existing = selectedAccount(current, input)
    const id = input.accountId === undefined ? legacyAccount(parsed.entry.id) : accountId(input.accountId)
    const label =
      input.label === undefined
        ? (existing?.label ?? parsed.entry.displayName)
        : stringField(input.label, 128)
    if (
      !label.trim() ||
      (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
      (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean')
    )
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    if (!existing && (current?.accounts.length ?? 0) >= 64)
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    // Supplying a new API key is an explicit OAuth -> API-key conversion for dual-auth providers.
    // An omitted key retains and revalidates the existing OAuth grant.
    const oauthEntry = existing?.authType === 'oauth' && parsed.apiKey === undefined
    const entry = oauthEntry ? providerFor(parsed.entry.id, 'oauth') : parsed.entry
    const baseUrl =
      input.baseUrl === undefined
        ? (existing?.baseUrl ?? providerEndpoint(entry, undefined))
        : providerEndpoint(entry, input.baseUrl)
    const result = oauthEntry
      ? {
          models: (await staticCatalogue(entry)).records.map((m) => ({ id: m.id, name: m.name })),
          verified: true,
        }
      : await test({
          providerId: parsed.entry.id,
          accountId: id,
          baseUrl,
          ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
        })
    if (!result.verified) throw new ConfigurationError('CONFIG_TEST_FAILED')
    if (!result.models.some((model) => model.id === parsed.model))
      throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
    if (oauthEntry) {
      if (!existing) throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
      const signal = AbortSignal.timeout(45_000)
      const provider = getSubscriptionProvider(existing.id)
      if (!provider) throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
      let auth: Awaited<ReturnType<typeof subscriptionCredentialAuth>>
      try {
        auth = await subscriptionAuth(
          provider.id,
          subscriptionCredentials(home, existing.credentialRef, provider.id),
        ).resolve(signal)
      } catch {
        throw new ConfigurationError('CONFIG_SUBSCRIPTION_AUTH')
      }
      await verifySubscriptionAuth(provider.id, auth, parsed.model, signal)
    }
    const before = existing ? await readCredential(existing.credentialRef) : null
    const key =
      parsed.apiKey ?? (before?.kind === 'api-key' && before.provider === entry.id ? before.value : undefined)
    const oauth = oauthEntry
    if (oauth ? !isSubscriptionCredential(before, entry.id) : !key)
      throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
    const nextRevision = revision + 1
    const ref = oauth && existing ? existing.credentialRef : accountRef(entry, profile, id, nextRevision)
    const enabled = input.enabled ?? existing?.enabled ?? true
    const row: StoredAccount = {
      accountId: id,
      label,
      id: entry.id,
      route: existing?.route ?? (input.accountId === undefined ? entry.route : `account-${id}`),
      baseUrl,
      model: parsed.model,
      models: result.models,
      credentialRef: ref,
      enabled,
      authType: oauth ? 'oauth' : 'api-key',
    }
    const accounts = [...(current?.accounts ?? []).filter((entry) => entry.accountId !== id), row]
    let defaultAccountId = current?.defaultAccountId ?? null
    if (input.makeDefault || (input.accountId === undefined && enabled) || (!defaultAccountId && enabled))
      defaultAccountId = id
    if (defaultAccountId === id && !enabled) {
      if (accounts.some((entry) => entry.enabled)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
      defaultAccountId = null
    }
    if (input.makeDefault && !enabled) throw new ConfigurationError('CONFIG_INVALID_INPUT')
    try {
      if (!oauth) await credentialStore.putApiKey(ref, key as string)
    } catch {
      throw new ConfigurationError('CONFIG_CREDENTIAL_STORE')
    }
    const next: StoredConfiguration = {
      version: 2,
      profile,
      revision: nextRevision,
      accounts,
      defaultAccountId,
    }
    await persistState(next)
    return snapshot(next)
  }

  const changeAccount = async (input: ConfigAccountInput): Promise<ConfigSnapshot> => {
    const raw = inputObject(input)
    if (
      !exactKeys(raw, ['accountId', 'action', 'expectedRevision']) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !['enable', 'disable', 'remove', 'default'].includes(input.action)
    )
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    const id = accountId(input.accountId)
    const state = await loadState()
    if (!state || state.revision !== input.expectedRevision)
      throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
    const row = state.accounts.find((entry) => entry.accountId === id)
    if (!row) throw new ConfigurationError('CONFIG_INVALID_INPUT')
    if (input.action === 'default' && !row.enabled) throw new ConfigurationError('CONFIG_INVALID_INPUT')
    if (
      (input.action === 'enable' || input.action === 'default') &&
      !(await configuredCredential(row.credentialRef, providerFor(row.id, row.authType), row.authType))
    )
      throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
    let defaultAccountId = state.defaultAccountId
    if (['disable', 'remove'].includes(input.action) && defaultAccountId === id) {
      if (state.accounts.some((entry) => entry.accountId !== id && entry.enabled))
        throw new ConfigurationError('CONFIG_INVALID_INPUT')
      defaultAccountId = null
    }
    if (input.action === 'default' || (input.action === 'enable' && !defaultAccountId)) defaultAccountId = id
    const accounts = state.accounts
      .filter((entry) => input.action !== 'remove' || entry.accountId !== id)
      .map((entry) =>
        entry.accountId === id && ['enable', 'disable'].includes(input.action)
          ? { ...entry, enabled: input.action === 'enable' }
          : entry,
      )
    const next: StoredConfiguration = { ...state, revision: state.revision + 1, accounts, defaultAccountId }
    await persistState(next)
    return snapshot(next)
  }
  const serialized = (action: () => Promise<ConfigSnapshot>): Promise<ConfigSnapshot> => {
    const run = saveTail.then(
      () => withLock(action),
      () => withLock(action),
    )
    saveTail = run
    return run
  }

  const verifySubscriptionAuth = async (
    providerId: Parameters<typeof subscriptionCredentialAuth>[0],
    auth: Awaited<ReturnType<typeof subscriptionCredentialAuth>>,
    model: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted()
    try {
      const verified =
        providerId === CODEX_ID && options.codexTest && auth.apiKey
          ? await options.codexTest(auth.apiKey, model, signal)
          : await (options.subscriptionTest ?? testSubscriptionCredential)(providerId, auth, model, signal)
      if (!verified) throw new ConfigurationError('CONFIG_SUBSCRIPTION_FAILED')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const reasons: Record<string, ConfigurationErrorCode> = {
        AUTH: 'CONFIG_SUBSCRIPTION_AUTH',
        QUOTA: 'CONFIG_SUBSCRIPTION_QUOTA',
        RATE_LIMIT: 'CONFIG_SUBSCRIPTION_RATE_LIMIT',
        TIMEOUT: 'CONFIG_SUBSCRIPTION_TIMEOUT',
        NO_MODEL: 'CONFIG_SUBSCRIPTION_MODEL',
      }
      throw new ConfigurationError(
        typeof code === 'string'
          ? (reasons[code] ?? 'CONFIG_SUBSCRIPTION_FAILED')
          : 'CONFIG_SUBSCRIPTION_FAILED',
      )
    }
  }
  const verifySubscription: NonNullable<CodexLoginDependencies['test']> = async (
    input,
    credential,
    model,
    signal,
  ) => {
    const auth = await subscriptionCredentialAuth(input.providerId, credential)
    await verifySubscriptionAuth(input.providerId, auth, model, signal)
  }
  const oauth = createCodexLogin({
    test: verifySubscription,
    ...(options.subscriptionLogin
      ? { login: options.subscriptionLogin }
      : options.codexLogin
        ? {
            login: (providerId, store, interaction) => {
              if (providerId !== CODEX_ID) throw new Error('CONFIG_AUTH_FAILED')
              return options.codexLogin?.(store, interaction) as Promise<void>
            },
          }
        : {}),
    async commit(input, credential, model, signal) {
      if (((await loadState())?.revision ?? 0) !== input.expectedRevision)
        throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
      signal.throwIfAborted()
      // Check the chosen model, not a model-list endpoint Codex does not provide.
      await verifySubscription(input, credential, model, signal)
      return serialized(async () => {
        signal.throwIfAborted()
        const current = await loadState()
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        const existing = selectedAccount(current, {
          providerId: input.providerId,
          accountId: input.accountId,
        })
        if (!existing && (current?.accounts.length ?? 0) >= 64)
          throw new ConfigurationError('CONFIG_INVALID_INPUT')
        const revision = (current?.revision ?? 0) + 1
        const ref =
          accountRef(providerFor(input.providerId, 'oauth'), profile, input.accountId, revision) +
          '-g' +
          randomUUID().replaceAll('-', '')
        const models = subscriptionModels(input.providerId, credential).map((m) => ({
          id: m.id,
          name: m.name,
        }))
        if (!models.some((m) => m.id === model)) throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
        const store = subscriptionCredentials(home, ref, input.providerId)
        await store.modify(input.providerId, async () => credential, { signal })
        try {
          signal.throwIfAborted()
          const row: StoredAccount = {
            accountId: input.accountId,
            label: input.label,
            id: input.providerId,
            route: existing?.route ?? `account-${input.accountId}`,
            baseUrl: providerFor(input.providerId, 'oauth').baseUrl,
            credentialRef: ref,
            models,
            model,
            enabled: existing?.enabled ?? true,
            authType: 'oauth',
          }
          const next: StoredConfiguration = {
            version: 2,
            profile,
            revision,
            accounts: [...(current?.accounts ?? []).filter((a) => a.accountId !== input.accountId), row],
            defaultAccountId: current?.defaultAccountId ?? (row.enabled ? row.accountId : null),
          }
          await persistState(next)
          return snapshot(next)
        } catch (error) {
          // This grant has never been published. Best-effort removal prevents failed saves and
          // disconnect races from accumulating usable refresh tokens outside configuration state.
          await store.delete(input.providerId).catch(() => {})
          throw error
        }
      })
    },
  })
  return {
    oauth,
    get,
    providers,
    test,
    save: (input) => serialized(() => saveInternal(input)),
    account: (input) => serialized(() => changeAccount(input)),
    async profileInput() {
      const state = await loadState()
      const secrets = { kind: 'file' as const, path: join(home, 'secrets') }
      // An unconfigured service must preserve an existing YAML credential adapter.
      if (!state) return {}
      const enabled = state.accounts.filter((row) => row.enabled)
      enabled.sort((a, b) =>
        a.accountId === state.defaultAccountId ? -1 : b.accountId === state.defaultAccountId ? 1 : 0,
      )
      const routeGroups = await Promise.all(
        enabled.map(async (row) => {
          const entry = providerFor(row.id, row.authType)
          if (!(await configuredCredential(row.credentialRef, entry, row.authType)))
            throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
          const catalogue = await staticCatalogue(entry)
          const byId = new Map(catalogue.records.map((record) => [record.id, record]))
          const records = row.models.map((model) => {
            const record = byId.get(model.id)
            if (!record) throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
            return { record, model }
          })
          const selected = records.find(({ model }) => model.id === row.model)
          if (!selected) throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
          const selectedApi =
            row.authType === 'oauth' && 'api' in selected.record ? String(selected.record.api) : entry.api
          const apis = [
            selectedApi,
            ...new Set(
              records
                .map(({ record }) =>
                  row.authType === 'oauth' && 'api' in record ? String(record.api) : entry.api,
                )
                .filter((api) => api !== selectedApi),
            ),
          ]
          return apis.map((api, index) => {
            const route =
              index === 0
                ? row.route
                : `${row.route}-${createHash('sha256').update(api).digest('hex').slice(0, 6)}`
            const models = records
              .filter(({ record }) =>
                row.authType === 'oauth' && 'api' in record ? record.api === api : entry.api === api,
              )
              .map(({ record, model }) =>
                applyThinkingEfforts(cloneRecord(record, row.baseUrl, route), model.thinkingEfforts),
              )
            models.sort((a, b) => (a.id === row.model ? -1 : b.id === row.model ? 1 : 0))
            return {
              route,
              api,
              baseUrl: row.baseUrl,
              credentialRef: row.credentialRef,
              displayName: index === 0 ? row.label : `${row.label} · ${api}`,
              models,
            }
          })
        }),
      )
      return {
        adapters: { secrets },
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: routeGroups.flat(),
          catalog: { include: [] },
        },
      }
    },
  }

  async function withLock<T>(action: () => Promise<T>): Promise<T> {
    if (windowsDirectories) {
      await ensureDirectory(home)
      await ensureDirectory(join(home, 'profiles'))
    }
    await ensureDirectory(profileDir)
    try {
      return await withConfigurationLock(lockPath, action)
    } catch (error) {
      if (error instanceof ConfigurationError) throw error
      throw new ConfigurationError('CONFIG_PERSIST_FAILED')
    }
  }
}
