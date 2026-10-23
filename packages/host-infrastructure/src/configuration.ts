import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  API_KEY_PROVIDER_REGISTRY,
  ApiKeyProviderError,
  type ApiKeyProviderRegistryEntry,
  CODEX_ID,
  type CodexCredentialStore,
  type CodexInteraction,
  fetchProviderModels,
  getApiKeyProvider,
  getSubscriptionProvider,
  isChatModelId,
  SUBSCRIPTION_PROVIDER_REGISTRY,
  type SubscriptionProviderEntry,
  subscriptionAuth,
  subscriptionCredentialAuth,
  subscriptionModels,
  type testCodexCredential,
  testSubscriptionCredential,
} from '@agnes/ai'
import { withConfigurationLock } from '@agnes/host-common/configuration-lock'
import { isHostError } from '@agnes/host-common/errors'
import { fileSecretsDir } from '@agnes/host-common/paths'
import type { RuntimeProfileManifest } from '@agnes/host-common/profile/types'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import {
  type ApplicationConfigSnapshot,
  ApplicationSelection,
  AuxiliaryModelSlots,
  type ChildEngineSettings,
  type ConfigAccount,
  type ConfigAccountInput,
  type ConfigModel,
  type ConfigOAuthInput,
  type ConfigOAuthResult,
  type ConfigProvider,
  type ConfigProvidersResult,
  type ConfigSaveInput,
  type ConfigSnapshot,
  type ConfigTestInput,
  type ConfigTestResult,
  childEngineSettingsError,
  DISABLED_CHILD_ENGINES,
  isSessionDefaults,
  isSessionDefaultsSnapshot,
  type ModelRecord,
  type ModelSettings,
  ModelSlotsSnapshot,
  minimumContextBudget,
  PresentationRoleSelections,
  readChildEngineSettings,
  type SessionDefaults,
  type SessionDefaultsSnapshot,
  validateAgainst,
} from '@agnes/protocol'
import { renameWriteThrough, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { deploymentFetch, ensureDeploymentProxy } from '@agnes/system-node/deployment-network'
import { subscriptionCredentials } from './adapters/codex-credentials.js'
import {
  createCredentialStore,
  isSubscriptionCredential,
  type StoredCredential,
} from './adapters/credential-store.js'
import { createWin32Platform } from './adapters/platform.js'
import { type CodexLoginDependencies, createCodexLogin } from './codex-login.js'
import { automaticFastModel } from './configuration-auto-slots.js'
import * as compatible from './configuration-compatible.js'
import {
  configurationCredentialAvailability,
  effectiveDefaultAccount,
  isConfiguredCredential,
  isUsableCredential,
} from './configuration-credential-availability.js'
import { configurationCredentialFailure } from './configuration-credential-failure.js'
import {
  checkedNetworkTimeouts,
  parseBaseUrl,
  requireEndpointCredential,
  validateEndpoint,
} from './configuration-endpoint.js'
import { ConfigurationError, type ConfigurationErrorCode } from './configuration-error.js'
import {
  applyModelConfiguration,
  configModel,
  configModels,
  normalizeConfigModel,
  normalizeModelSettings,
  supportsModelSettings,
} from './configuration-models.js'
import {
  GENERIC_CREDENTIAL_REF,
  isPayloadOnlyEntry,
  parsePayloadOnlyCredentialRef,
  payloadOnlyAccountRow,
  payloadOnlyApiCapabilities,
  payloadOnlyRoute,
  testPayloadOnlyAccount,
} from './configuration-payload-only.js'
import { presentationSnapshot, updatePresentation } from './configuration-presentation.js'
import { payloadOnlyRoutes } from './payload-only-routes.js'
import { permissionLevelDefaults } from './session-defaults-permission.js'

type ConfigurationProvider = ApiKeyProviderRegistryEntry | SubscriptionProviderEntry

export { CONFIGURATION_ERROR_CODES } from './configuration-error.js'
export { ConfigurationError, type ConfigurationErrorCode }

export interface ConfigurationService {
  application?(): Promise<ApplicationConfigSnapshot>
  saveApplication?(input: ApplicationConfigSnapshot): Promise<ApplicationConfigSnapshot>
  modelSlots?(): Promise<ModelSlotsSnapshot>
  saveModelSlots?(input: ModelSlotsSnapshot): Promise<ModelSlotsSnapshot>
  oauth?(input: ConfigOAuthInput, owner: object, signal: AbortSignal): Promise<ConfigOAuthResult>
  get(): Promise<ConfigSnapshot>
  providers(): Promise<ConfigProvidersResult>
  test(input: ConfigTestInput, signal?: AbortSignal): Promise<ConfigTestResult>
  save(input: ConfigSaveInput): Promise<ConfigSnapshot>
  account(input: ConfigAccountInput): Promise<ConfigSnapshot>
  profileInput(): Promise<Partial<RuntimeProfileManifest>>
}

export interface SessionDefaultsConfigurationService {
  sessionDefaults(): Promise<SessionDefaultsSnapshot>
  saveSessionDefaults(input: SessionDefaultsSnapshot): Promise<SessionDefaultsSnapshot>
}

export type ChildEnginesSnapshot = {
  revision: number
  engines: ChildEngineSettings
}

export interface ChildEnginesConfigurationService {
  childEngines(): Promise<ChildEnginesSnapshot>
  saveChildEngines(input: ChildEnginesSnapshot): Promise<ChildEnginesSnapshot>
}

export type ConfigurationServiceOptions = {
  subscriptionLogin?: CodexLoginDependencies['login']
  subscriptionTest?: typeof testSubscriptionCredential
  /** Compatibility injection retained for the original Codex-focused tests. */
  codexLogin?: (store: CodexCredentialStore, interaction: CodexInteraction) => Promise<void>
  codexTest?: typeof testCodexCredential
  home: string
  profile: string
  /** Trusted Host profile directory override; defaults to home/profiles/profile. */
  profileDir?: string
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
  networkTimeouts?: import('@agnes/protocol').ConfigSaveInput['networkTimeouts']
}
type StoredConfiguration = {
  executionRevision?: number
  application?: ApplicationSelection
  roleSelections?: PresentationRoleSelections
  modelSlots?: AuxiliaryModelSlots
  version: 2
  profile: string
  revision: number
  accounts: StoredAccount[]
  defaultAccountId: string | null
  sessionDefaults?: SessionDefaults
  childEngines?: ChildEngineSettings
  /** Defaults-only writes must preserve the existing YAML provider overlay. */
  inheritProvider?: true
}
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,47}$/
function accountId(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT.test(value)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return value
}
function legacyAccount(id: string): string {
  return `legacy-${id}`
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

/** A corrupt child-engine field is omitted so accounts and session defaults still load. */
function acceptedChildEngines(value: unknown): ChildEngineSettings | undefined {
  const engines = readChildEngineSettings(value)
  if (!engines || childEngineSettingsError(engines)) return undefined
  return engines
}

function retainedConfiguration(current: StoredConfiguration | undefined) {
  return {
    ...(current?.roleSelections === undefined ? {} : { roleSelections: current.roleSelections }),
    ...(current?.application === undefined ? {} : { application: current.application }),
    ...(current?.modelSlots === undefined ? {} : { modelSlots: current.modelSlots }),
    ...(current?.sessionDefaults === undefined ? {} : { sessionDefaults: current.sessionDefaults }),
    ...(current?.childEngines === undefined ? {} : { childEngines: current.childEngines }),
  }
}

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
  const baseUrl = value === undefined ? entry.baseUrl : parseBaseUrl(stringField(value, 2048))
  const defaultUrl = entry.baseUrl.endsWith('/') ? entry.baseUrl.slice(0, -1) : entry.baseUrl
  const requestedUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (requestedUrl !== defaultUrl && !COMPATIBLE_APIS.has(entry.api) && !isPayloadOnlyEntry(entry))
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
  credentialRef?: string
  model?: string
} {
  const input = inputObject(value)
  if (
    !Object.keys(input).every((key) =>
      ['providerId', 'baseUrl', 'apiKey', 'credentialRef', 'accountId', 'model'].includes(key),
    )
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const entry = providerFor(input.providerId)
  const baseUrl = providerEndpoint(entry, input.baseUrl)
  if (entry.id === CODEX_ID && input.apiKey !== undefined)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  // Each credential spelling belongs to one side: a raw key for chat, a reference for payload-only.
  if (isPayloadOnlyEntry(entry) ? input.apiKey !== undefined : input.credentialRef !== undefined)
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const apiKey = input.apiKey === undefined ? undefined : parseApiKey(input.apiKey)
  return {
    entry,
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(input.credentialRef === undefined
      ? {}
      : { credentialRef: parsePayloadOnlyCredentialRef(input.credentialRef) }),
    ...(input.model === undefined ? {} : { model: parseModel(input.model) }),
  }
}

function parseSaveInput(value: unknown): {
  entry: ConfigurationProvider
  baseUrl: string
  model: string
  expectedRevision?: number
  apiKey?: string
  models?: unknown
  credentialRef?: string
} {
  const input = inputObject(value)
  if (
    !Object.keys(input).every((key) =>
      [
        'providerId',
        'baseUrl',
        'apiKey',
        'model',
        'models',
        'credentialRef',
        'expectedRevision',
        'accountId',
        'label',
        'enabled',
        'makeDefault',
        'defaultSettings',
        'networkTimeouts',
      ].includes(key),
    )
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const parsed = parseTestInput({
    providerId: input.providerId,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
  })
  // The declared model list and an explicit credential reference exist only for payload-only
  // providers; a chat account keeps its catalogue-derived models and its account-scoped key.
  // An OpenAI-compatible account declares its models too, but holds an ordinary key.
  const declares = compatible.declaresModels(parsed.entry)
  if ((!declares && input.models !== undefined) || (!isPayloadOnlyEntry(parsed.entry) && input.credentialRef))
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  if (input.networkTimeouts !== undefined) checkedNetworkTimeouts(input.networkTimeouts)
  const model = parseModel(input.model)
  if (
    input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return {
    ...parsed,
    model,
    ...(input.models === undefined ? {} : { models: input.models }),
    ...(input.credentialRef === undefined ? {} : { credentialRef: stringField(input.credentialRef, 2048) }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision as number }),
  }
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
  const models = provider.models.map(normalizeConfigModel)
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
      // A row at the provider's former default reads at the current one; the next save writes it.
      baseUrl: entry.retiredBaseUrls?.includes(provider.baseUrl) ? entry.baseUrl : provider.baseUrl,
      model: provider.model,
      credentialRef: ref,
      models: normalized,
    },
  }
}

function decodeState(value: unknown, profile: string): StoredConfiguration | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'profile',
      'revision',
      'accounts',
      'defaultAccountId',
      ...(value.sessionDefaults === undefined ? [] : ['sessionDefaults']),
      ...(value.inheritProvider === undefined ? [] : ['inheritProvider']),
      ...(value.childEngines === undefined ? [] : ['childEngines']),
      ...(value.modelSlots === undefined ? [] : ['modelSlots']),
      ...(value.roleSelections === undefined ? [] : ['roleSelections']),
      ...(value.application === undefined ? [] : ['application']),
      ...(value.executionRevision === undefined ? [] : ['executionRevision']),
    ]) ||
    (value.executionRevision !== undefined &&
      (!Number.isSafeInteger(value.executionRevision) ||
        (value.executionRevision as number) < 0 ||
        (value.executionRevision as number) > (value.revision as number))) ||
    (value.roleSelections !== undefined &&
      !validateAgainst(PresentationRoleSelections, value.roleSelections).ok) ||
    (value.application !== undefined && !validateAgainst(ApplicationSelection, value.application).ok) ||
    (value.sessionDefaults !== undefined && !isSessionDefaults(value.sessionDefaults)) ||
    (value.modelSlots !== undefined && !validateAgainst(AuxiliaryModelSlots, value.modelSlots).ok) ||
    (value.inheritProvider !== undefined &&
      (value.inheritProvider !== true || !Array.isArray(value.accounts) || value.accounts.length !== 0)) ||
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
      ![9, 10, 11].includes(Object.keys(row).length) ||
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
          'networkTimeouts',
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
    const genericRef = isPayloadOnlyEntry(entry) && GENERIC_CREDENTIAL_REF.test(ref)
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
    if (!validRef && !legacyRef && !genericRef) return undefined
    accounts.push({
      ...decoded.provider,
      accountId: row.accountId,
      label: row.label,
      route,
      enabled: row.enabled,
      authType,
      credentialRef: ref,
      ...(row.networkTimeouts === undefined
        ? {}
        : { networkTimeouts: checkedNetworkTimeouts(row.networkTimeouts) }),
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
  if (
    value.defaultAccountId === null &&
    accounts.some((row) => row.enabled && !isPayloadOnlyEntry(providerFor(row.id, row.authType)))
  )
    return undefined
  const childEngines = acceptedChildEngines(value.childEngines)
  return {
    version: 2,
    profile,
    revision: value.revision as number,
    accounts,
    defaultAccountId: value.defaultAccountId as string | null,
    ...(value.inheritProvider === true ? { inheritProvider: true as const } : {}),
    ...(value.sessionDefaults === undefined
      ? {}
      : { sessionDefaults: value.sessionDefaults as SessionDefaults }),
    ...(childEngines === undefined ? {} : { childEngines }),
    ...(value.executionRevision === undefined
      ? {}
      : { executionRevision: value.executionRevision as number }),
    ...(value.roleSelections === undefined
      ? {}
      : { roleSelections: value.roleSelections as PresentationRoleSelections }),
    ...(value.application === undefined ? {} : { application: value.application as ApplicationSelection }),
    ...(value.modelSlots === undefined ? {} : { modelSlots: value.modelSlots as AuxiliaryModelSlots }),
  }
}

function checkedDefaults(model: ConfigModel, value: unknown): ModelSettings {
  const settings = normalizeModelSettings(value)
  if (
    !settings ||
    !supportsModelSettings(model, settings) ||
    (settings.contextWindow !== undefined &&
      settings.contextWindow < minimumContextBudget(model.contextWindow))
  )
    throw new ConfigurationError('CONFIG_INVALID_INPUT')
  return settings
}

function cloneRecord(record: ModelRecord, baseUrl: string, route: string): ModelRecord {
  return { ...structuredClone(record), baseUrl, route }
}

const windowsDirectories = createWin32Platform().matches()

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

export function createConfigurationService(
  options: ConfigurationServiceOptions,
): ConfigurationService &
  SessionDefaultsConfigurationService &
  ChildEnginesConfigurationService &
  Required<Pick<ConfigurationService, 'application' | 'saveApplication' | 'modelSlots' | 'saveModelSlots'>> {
  const chatModels = compatible.chatModelPolicy(isChatModelId)
  const home = resolve(options.home)
  if (!PROFILE.test(options.profile)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
  const profile = options.profile
  const profileDir =
    options.profileDir === undefined ? join(home, 'profiles', profile) : resolve(options.profileDir)
  const configPath = join(profileDir, FILE)
  const lockPath = join(profileDir, LOCK_FILE)
  ensureDeploymentProxy()
  const request = options.request ?? deploymentFetch
  const credentialStore = createCredentialStore({ root: home })
  let loading: Promise<StoredConfiguration | undefined> | undefined
  const catalogueCache = new Map<string, Promise<StaticCatalogue>>()
  let saveTail: Promise<unknown> = Promise.resolve({
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
      throw new ConfigurationError('CONFIG_INVALID_STATE', path)
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONFIG_BYTES)
      throw new ConfigurationError('CONFIG_INVALID_STATE', path)
    try {
      return JSON.parse(raw) as unknown
    } catch {
      throw new ConfigurationError('CONFIG_INVALID_STATE', path)
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
    } catch (error) {
      throw credentialFailure(error, 'read')
    }
  }

  const credentialFailure = (error: unknown, operation: 'read' | 'write') =>
    configurationCredentialFailure(home, error, operation)

  const loadState = async (): Promise<StoredConfiguration | undefined> => {
    if (loading) return loading
    loading = (async () => {
      const stored = await readJsonFile(configPath)
      if (stored !== undefined) {
        const state = decodeState(stored, profile)
        if (!state) throw new ConfigurationError('CONFIG_INVALID_STATE', configPath)
        return state
      }
      return undefined
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
  ) => isConfiguredCredential(await readCredential(ref), entry.id, authType, isPayloadOnlyEntry(entry))

  const credentialAvailability = (row: StoredAccount) =>
    configurationCredentialAvailability(() =>
      configuredCredential(row.credentialRef, providerFor(row.id, row.authType), row.authType),
    )

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
      state.accounts.map(async (row) => {
        const entry = providerFor(row.id, row.authType)
        return {
          accountId: row.accountId,
          label: row.label,
          providerId: row.id,
          route: row.route,
          baseUrl: row.baseUrl,
          ...(row.networkTimeouts === undefined ? {} : { networkTimeouts: row.networkTimeouts }),
          model: row.model,
          models: compatible.declaresModels(entry)
            ? chatModels.models(row.models, isPayloadOnlyEntry(entry))
            : await staticCatalogue(entry)
                .catch(() => ({ records: [] as ModelRecord[] }))
                .then(({ records }) =>
                  row.models.map((saved) => {
                    const record = records.find((m) => m.id === saved.id)
                    return record ? configModel(record, saved) : structuredClone(saved)
                  }),
                ),
          enabled: row.enabled,
          authType: row.authType,
          ...(await credentialAvailability(row)),
        }
      }),
    )
    const selected = effectiveDefaultAccount(
      accounts,
      state.defaultAccountId,
      (row) => !isPayloadOnlyEntry(providerFor(row.providerId, row.authType ?? 'api-key')),
    )
    return {
      profile,
      revision: state.revision,
      executionRevision: state.executionRevision ?? state.revision,
      configured: selected?.credentialConfigured ?? false,
      accounts,
      defaultAccountId: selected?.accountId ?? null,
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
  /** An unset fast slot follows the default account; an explicit choice or `null` is left alone. */
  const slotsSnapshot = async (state: StoredConfiguration | undefined): Promise<ModelSlotsSnapshot> => {
    const slots = structuredClone(state?.modelSlots ?? {})
    chatModels.requireSlots(slots)
    const effectiveDefault = (await snapshot(state)).defaultAccountId
    const row = state?.accounts.find((account) => account.accountId === effectiveDefault)
    const result = { revision: state?.revision ?? 0, slots }
    if (slots.fast !== undefined || !row?.enabled) return result
    try {
      const entry = providerFor(row.id, row.authType)
      const capabilities = payloadOnlyApiCapabilities()
      // A payload-only route answers payloads, not conversations: no automatic fast choice.
      if (payloadOnlyRoutes(capabilities, [{ route: row.route, api: entry.api }]).has(row.route))
        return result
      const records = new Map((await staticCatalogue(entry)).records.map((record) => [record.id, record]))
      const api = (record: ModelRecord) =>
        row.authType === 'oauth' && 'api' in record ? String(record.api) : entry.api
      const primary = records.get(row.model)
      // Only models served on the account's own route: its other transports are separate routes.
      const candidates = row.models.flatMap(({ id }) => {
        const record = records.get(id)
        return record && primary && api(record) === api(primary) ? [record] : []
      })
      const fast = automaticFastModel(
        candidates,
        payloadOnlyRoutes(
          capabilities,
          candidates.map((record) => ({ route: record.id, api: api(record) })),
        ),
      )
      return fast
        ? { ...result, auto: { fast: { accountId: row.accountId, route: row.route, model: fast.id } } }
        : result
    } catch {
      // An unavailable provider catalogue leaves the slot unset; it never blocks reading the slots.
      return result
    }
  }
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
      ...API_KEY_PROVIDER_REGISTRY.filter((entry) => entry.capabilities?.payloadOnly !== true).map(
        (entry): ConfigProvider => {
          const subscription = getSubscriptionProvider(entry.id)
          return {
            id: entry.id,
            label: entry.displayName,
            authMethods: subscription ? ['api-key', 'oauth'] : ['api-key'],
            ...(subscription ? { loginMethods: [...subscription.loginMethods] } : {}),
            api: entry.api,
            baseUrl: entry.baseUrl,
          }
        },
      ),
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

  const test = async (input: ConfigTestInput, callerSignal?: AbortSignal): Promise<ConfigTestResult> => {
    callerSignal?.throwIfAborted()
    const parsed = parseTestInput(input)
    const state = await loadState()
    const row = selectedAccount(state, input)
    const baseUrl = input.baseUrl === undefined ? (row?.baseUrl ?? parsed.baseUrl) : parsed.baseUrl
    validateEndpoint(parsed.entry, baseUrl)
    await requireEndpointCredential(baseUrl, row, parsed, readCredential)
    if (isPayloadOnlyEntry(parsed.entry))
      return testPayloadOnlyAccount(
        { baseUrl, model: parsed.model, credentialRef: parsed.credentialRef, row },
        { request, signal: callerSignal ?? new AbortController().signal, readCredential },
      )
    const list = (api: string, url: string, credential: string | undefined) =>
      fetchProviderModels({
        api,
        baseUrl: url,
        request,
        ...(credential ? { credential } : {}),
        ...(callerSignal ? { signal: callerSignal } : {}),
      }).catch((error: unknown) => {
        if (error instanceof ApiKeyProviderError && (error.status === 401 || error.status === 403))
          throw new ConfigurationError('CONFIG_CREDENTIAL_REJECTED')
        throw error
      })
    if (compatible.isCompatibleEntry(parsed.entry))
      return chatModels.testCompatibleAccount(
        { entry: parsed.entry, baseUrl, apiKey: parsed.apiKey, row },
        { list, readCredential },
      )
    const storedCredential =
      row && parsed.apiKey === undefined ? await readCredential(row.credentialRef) : null
    let models = configModels((await staticCatalogue(parsed.entry)).records, row?.models)
    if (row?.authType === 'oauth' && parsed.apiKey === undefined) {
      const provider = getSubscriptionProvider(row.id)
      if (!provider || !isSubscriptionCredential(storedCredential, row.id)) return { models, verified: false }
      try {
        const timeout = AbortSignal.timeout(45_000)
        const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
        const store = subscriptionCredentials(home, row.credentialRef, provider.id)
        const runtime = subscriptionAuth(provider.id, store)
        const auth = await runtime.resolve(signal)
        models = configModels(await runtime.available(signal), row.models)
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
    const probed = await list(parsed.entry.api, baseUrl, key)
    if (!('ids' in probed)) return { models, verified: false, catalogueError: probed.failure }
    const offered = new Set(probed.ids)
    const supported = models.filter((model) => offered.has(model.id))
    // The runtime catalogue is the installed, reviewed source of model capabilities. A remote
    // endpoint may narrow it, but cannot introduce an unreviewed model record into Host assembly.
    return supported.length === 0 ? { models, verified: false } : { models: supported, verified: true }
  }

  const persistState = async (state: StoredConfiguration, presentationOnly = false): Promise<void> => {
    if (!presentationOnly) state.executionRevision = state.revision
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
    chatModels.requireModel(parsed.model, isPayloadOnlyEntry(parsed.entry))
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
    // An omitted key retains the existing OAuth grant; connection/model changes still revalidate it.
    const oauthEntry = existing?.authType === 'oauth' && parsed.apiKey === undefined
    const entry = oauthEntry ? providerFor(parsed.entry.id, 'oauth') : parsed.entry
    const baseUrl =
      input.baseUrl === undefined
        ? (existing?.baseUrl ?? providerEndpoint(entry, undefined))
        : providerEndpoint(entry, input.baseUrl)
    validateEndpoint(entry, baseUrl)
    await requireEndpointCredential(baseUrl, existing, parsed, readCredential)
    if (isPayloadOnlyEntry(entry)) {
      const row = payloadOnlyAccountRow({
        input,
        parsed,
        entryId: entry.id,
        existing,
        accountId: id,
        label,
        baseUrl,
      })
      if (!(await configuredCredential(row.credentialRef, entry, 'api-key')))
        throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
      const next: StoredConfiguration = {
        version: 2,
        profile,
        revision: revision + 1,
        accounts: [...(current?.accounts ?? []).filter((account) => account.accountId !== id), row],
        defaultAccountId: current?.defaultAccountId ?? null,
        ...retainedConfiguration(current),
      }
      await persistState(next)
      return snapshot(next)
    }
    const labelOnlyUpdate =
      !!existing &&
      parsed.apiKey === undefined &&
      input.enabled === undefined &&
      input.makeDefault === undefined &&
      existing.id === parsed.entry.id &&
      existing.baseUrl === baseUrl &&
      existing.model === parsed.model &&
      existing.label !== label
    const result = labelOnlyUpdate
      ? { models: structuredClone(existing?.models ?? []), verified: true }
      : compatible.isCompatibleEntry(entry) && parsed.models !== undefined
        ? { models: chatModels.compatibleModels(entry, baseUrl, parsed.models), verified: true }
        : oauthEntry
          ? {
              models: configModels((await staticCatalogue(entry)).records, existing?.models),
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
    if (oauthEntry && !labelOnlyUpdate) {
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
    const before =
      existing && parsed.apiKey === undefined ? await readCredential(existing.credentialRef) : null
    const key =
      parsed.apiKey ??
      (before?.kind === 'api-key' && before.provider === entry.id ? before.value : undefined) ??
      (compatible.isCompatibleEntry(entry) ? compatible.KEYLESS_CREDENTIAL : undefined)
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
      ...(input.networkTimeouts === undefined
        ? existing?.networkTimeouts
          ? { networkTimeouts: existing.networkTimeouts }
          : {}
        : { networkTimeouts: checkedNetworkTimeouts(input.networkTimeouts) }),
      models: result.models.map((model) => {
        const defaults =
          model.id === parsed.model && input.defaultSettings !== undefined
            ? input.defaultSettings
            : model.defaultSettings
        return {
          ...model,
          ...(defaults === undefined ? {} : { defaultSettings: checkedDefaults(model, defaults) }),
        }
      }),
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
    } catch (error) {
      throw credentialFailure(error, 'write')
    }
    const next: StoredConfiguration = {
      version: 2,
      profile,
      revision: nextRevision,
      accounts,
      defaultAccountId,
      ...retainedConfiguration(current),
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
    const payloadOnly = isPayloadOnlyEntry(providerFor(row.id, row.authType))
    if (input.action === 'default' && (!row.enabled || payloadOnly))
      throw new ConfigurationError('CONFIG_INVALID_INPUT')
    if (
      (input.action === 'enable' || input.action === 'default') &&
      !(await configuredCredential(row.credentialRef, providerFor(row.id, row.authType), row.authType))
    )
      throw new ConfigurationError('CONFIG_CREDENTIAL_REQUIRED')
    let defaultAccountId = state.defaultAccountId
    if (['disable', 'remove'].includes(input.action) && defaultAccountId === id) {
      if (
        state.accounts.some(
          (entry) =>
            entry.accountId !== id &&
            entry.enabled &&
            !isPayloadOnlyEntry(providerFor(entry.id, entry.authType)),
        )
      )
        throw new ConfigurationError('CONFIG_INVALID_INPUT')
      defaultAccountId = null
    }
    if (input.action === 'default' || (input.action === 'enable' && !defaultAccountId && !payloadOnly))
      defaultAccountId = id
    const accounts = state.accounts
      .filter((entry) => input.action !== 'remove' || entry.accountId !== id)
      .map((entry) =>
        entry.accountId === id && ['enable', 'disable'].includes(input.action)
          ? { ...entry, enabled: input.action === 'enable' }
          : entry,
      )
    // A removed account's route never comes back, so clear the slots on it as settings would:
    // fast follows the default account again, the verifier becomes an explicit "none".
    const modelSlots = structuredClone(state.modelSlots)
    if (input.action === 'remove' && modelSlots) {
      if (modelSlots.fast?.route === row.route) delete modelSlots.fast
      if (modelSlots.verifier?.route === row.route) modelSlots.verifier = null
    }
    const next: StoredConfiguration = {
      ...state,
      revision: state.revision + 1,
      accounts,
      defaultAccountId,
      ...(modelSlots === undefined ? {} : { modelSlots }),
    }
    await persistState(next)
    return snapshot(next)
  }
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
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
    async commit(input, credential, model, signal, defaultSettings, networkTimeouts) {
      if (networkTimeouts !== undefined) checkedNetworkTimeouts(networkTimeouts)
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
        const models = subscriptionModels(input.providerId, credential).map((record) => {
          const projected = configModel(
            record,
            existing?.models.find((m) => m.id === record.id),
          )
          const defaults =
            record.id === model && defaultSettings !== undefined ? defaultSettings : projected.defaultSettings
          return {
            ...projected,
            ...(defaults === undefined ? {} : { defaultSettings: checkedDefaults(projected, defaults) }),
          }
        })
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
            ...(networkTimeouts === undefined
              ? existing?.networkTimeouts
                ? { networkTimeouts: existing.networkTimeouts }
                : {}
              : { networkTimeouts: checkedNetworkTimeouts(networkTimeouts) }),
          }
          const next: StoredConfiguration = {
            version: 2,
            profile,
            revision,
            accounts: [...(current?.accounts ?? []).filter((a) => a.accountId !== input.accountId), row],
            defaultAccountId: current?.defaultAccountId ?? (row.enabled ? row.accountId : null),
            ...retainedConfiguration(current),
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
    async application() {
      return presentationSnapshot(await loadState())
    },
    saveApplication: (input) =>
      serialized(async () => {
        const current = await loadState()
        const next = updatePresentation<StoredConfiguration>(input, current, {
          version: 2,
          profile,
          accounts: [],
          defaultAccountId: null,
          revision: 0,
          ...(!current ? { inheritProvider: true as const } : {}),
        })
        await persistState(next, true)
        return presentationSnapshot(next)
      }),
    async modelSlots() {
      return slotsSnapshot(await loadState())
    },
    saveModelSlots: (input) =>
      serialized(async () => {
        if (!validateAgainst(ModelSlotsSnapshot, input).ok)
          throw new ConfigurationError('CONFIG_INVALID_INPUT')
        chatModels.requireSlots(input.slots)
        const current = await loadState()
        if (input.revision !== (current?.revision ?? 0))
          throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        const next: StoredConfiguration = {
          version: 2,
          profile,
          accounts: [],
          defaultAccountId: null,
          ...current,
          ...(!current ? { inheritProvider: true as const } : {}),
          revision: input.revision + 1,
          modelSlots: structuredClone(input.slots),
        }
        await persistState(next)
        return slotsSnapshot(next)
      }),
    async sessionDefaults() {
      const state = await loadState()
      return {
        revision: state?.revision ?? 0,
        defaults: permissionLevelDefaults(chatModels.defaults(state?.sessionDefaults)),
      }
    },
    saveSessionDefaults: (input) =>
      serialized(async () => {
        if (!isSessionDefaultsSnapshot(input)) throw new ConfigurationError('CONFIG_INVALID_INPUT')
        const current = await loadState()
        if (input.revision !== (current?.revision ?? 0))
          throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        const next: StoredConfiguration = {
          version: 2,
          profile,
          accounts: [],
          defaultAccountId: null,
          ...current,
          ...(!current ? { inheritProvider: true as const } : {}),
          revision: input.revision + 1,
          sessionDefaults: permissionLevelDefaults(chatModels.defaults(input.defaults)),
        }
        await persistState(next)
        return { revision: next.revision, defaults: structuredClone(next.sessionDefaults ?? {}) }
      }),
    async childEngines() {
      const state = await loadState()
      return {
        revision: state?.revision ?? 0,
        engines: structuredClone(state?.childEngines ?? DISABLED_CHILD_ENGINES),
      }
    },
    saveChildEngines: (input) =>
      serialized(async () => {
        const raw = inputObject(input)
        const engines = readChildEngineSettings(raw.engines)
        if (
          !exactKeys(raw, ['revision', 'engines']) ||
          !Number.isSafeInteger(raw.revision) ||
          (raw.revision as number) < 0 ||
          !engines ||
          childEngineSettingsError(engines)
        )
          throw new ConfigurationError('CONFIG_INVALID_INPUT')
        const current = await loadState()
        if ((raw.revision as number) !== (current?.revision ?? 0))
          throw new ConfigurationError('CONFIG_REVISION_CONFLICT')
        const next: StoredConfiguration = {
          version: 2,
          profile,
          accounts: [],
          defaultAccountId: null,
          ...current,
          ...(!current ? { inheritProvider: true as const } : {}),
          revision: (raw.revision as number) + 1,
          childEngines: structuredClone(engines),
        }
        await persistState(next)
        return { revision: next.revision, engines: structuredClone(next.childEngines ?? engines) }
      }),
    async profileInput() {
      const state = await loadState()
      const secrets = { kind: 'file' as const, path: fileSecretsDir(home) }
      // An unconfigured service must preserve an existing YAML credential adapter.
      if (!state || state.inheritProvider) return {}
      const enabled = state.accounts.filter((row) => row.enabled)
      enabled.sort((a, b) =>
        a.accountId === state.defaultAccountId ? -1 : b.accountId === state.defaultAccountId ? 1 : 0,
      )
      const routeGroups = await Promise.all(
        enabled.map(async (row) => {
          const entry = providerFor(row.id, row.authType)
          if (!(await credentialAvailability(row)).credentialConfigured) return []
          // A payload-only account has no provider catalogue to resolve against; its declared
          // models render through the fixed payload template instead.
          if (isPayloadOnlyEntry(entry)) return [payloadOnlyRoute(row, entry.api)]
          if (compatible.isCompatibleEntry(entry)) return [chatModels.compatibleRoute(row, entry.api)]
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
              .map(({ record, model }) => {
                const effective = applyModelConfiguration(cloneRecord(record, row.baseUrl, route), model)
                if (effective.defaultSettings && !supportsModelSettings(effective, effective.defaultSettings))
                  throw new ConfigurationError('CONFIG_MODEL_UNAVAILABLE')
                return effective
              })
            models.sort((a, b) => (a.id === row.model ? -1 : b.id === row.model ? 1 : 0))
            return {
              route,
              api,
              baseUrl: row.baseUrl,
              ...(row.networkTimeouts === undefined ? {} : { networkTimeouts: row.networkTimeouts }),
              credentialRef: row.credentialRef,
              displayName: index === 0 ? row.label : `${row.label} · ${api}`,
              models,
            }
          })
        }),
      )
      const routes = routeGroups.flat()
      return {
        adapters: { secrets },
        provider: { package: RELEASE_DEFAULTS.modelAdapterPackage, routes, catalog: { include: [] } },
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
      if (error instanceof ConfigurationError || isHostError(error)) throw error
      throw new ConfigurationError('CONFIG_PERSIST_FAILED')
    }
  }
}
