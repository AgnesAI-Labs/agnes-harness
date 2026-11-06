import { lstat, open } from 'node:fs/promises'
import { withConfigurationLock } from '@agnes/host-common/configuration-lock'
import {
  atomicWriteCredentialFile,
  CredentialStoreError,
  credentialFileEnforcement,
  prepareCredentialWrite,
  readCredentialFile,
  resolveCredentialFile,
} from './credential-files.js'
import { createCredentialStore } from './credential-store.js'
import { createPlatform, type PlatformBackend } from './platform.js'

// The same shapes are declared by `@agnes/resource-control-runtime`; this package must not depend on it.
export type McpOAuthClient = Readonly<{
  clientId: string
  clientSecret?: string
  tokenEndpointAuthMethod?: string
  redirectUri: string
}>

export type McpOAuthServer = Readonly<{
  endpoint: string
  authorizationServer: string
  tokenEndpoint: string
  issuer?: string
  resource: string
}>

export type McpOAuthTokens = Readonly<{
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope: readonly string[]
}>

/** A record without `client`, `server` and `tokens` is the logged-out record. */
export type McpOAuthRecord = Readonly<{
  version: 2
  kind: 'oauth'
  epoch: number
  rev: number
  client?: McpOAuthClient
  server?: McpOAuthServer
  tokens?: McpOAuthTokens
  requiredScope: readonly string[]
}>

export type McpOAuthRead = McpOAuthRecord | Readonly<{ legacy: true }> | null

export type McpOAuthNext = Omit<McpOAuthRecord, 'version' | 'kind' | 'rev'>

export type McpOAuthUpdateOptions = Readonly<{
  /**
   * A file that exists but cannot be read (damaged JSON or an invalid record) is handed to `change`
   * as `null`, so a fresh sign-in can replace it. Without this, such a file makes `update` throw.
   */
  replaceUnreadable?: boolean
}>

export type McpOAuthStore = Readonly<{
  read(serverId: string): Promise<McpOAuthRead>
  /** Locks the server, re-reads, runs `change`; writes `next` with rev + 1 when it returns one. */
  update<T>(
    serverId: string,
    change: (current: McpOAuthRead) => Promise<Readonly<{ value: T; next?: McpOAuthNext }>>,
    options?: McpOAuthUpdateOptions,
  ): Promise<T>
}>

export type CreateMcpOAuthStoreOptions = {
  /** The `~/.agh`-shaped anchor, as for the credential store. */
  root: string
  platform?: Pick<PlatformBackend, 'os'>
  /** How long an update waits for another writer of the same server. */
  lockTimeoutMs?: number
}

const DEFAULT_LOCK_TIMEOUT_MS = 25_000
const MAX_SECRET_CHARS = 65_536
const MAX_CLIENT_ID_CHARS = 512
const MAX_URL_CHARS = 2048
const MAX_METHOD_CHARS = 128
// RFC 6749 scope-token: %x21 / %x23-5B / %x5D-7E.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,1024}$/
const MAX_SCOPES = 128
const CONTROL = /\p{Cc}/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** True when `value` has every key in `required`, and no key outside `required` and `optional`. */
const hasKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key))

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value)

const isUrl = (value: unknown): value is string => isText(value, MAX_URL_CHARS) && URL.canParse(value)

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

const isScopes = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_SCOPES &&
  value.every((scope) => typeof scope === 'string' && SCOPE_TOKEN.test(scope))

const isClient = (value: unknown): boolean =>
  isRecord(value) &&
  hasKeys(value, ['clientId', 'redirectUri'], ['clientSecret', 'tokenEndpointAuthMethod']) &&
  isText(value.clientId, MAX_CLIENT_ID_CHARS) &&
  isUrl(value.redirectUri) &&
  (value.clientSecret === undefined || isText(value.clientSecret, MAX_SECRET_CHARS)) &&
  (value.tokenEndpointAuthMethod === undefined || isText(value.tokenEndpointAuthMethod, MAX_METHOD_CHARS))

const isServer = (value: unknown): boolean =>
  isRecord(value) &&
  hasKeys(value, ['endpoint', 'authorizationServer', 'tokenEndpoint', 'resource'], ['issuer']) &&
  isUrl(value.endpoint) &&
  isUrl(value.authorizationServer) &&
  isUrl(value.tokenEndpoint) &&
  isUrl(value.resource) &&
  (value.issuer === undefined || isUrl(value.issuer))

const isTokens = (value: unknown): boolean =>
  isRecord(value) &&
  hasKeys(value, ['accessToken', 'expiresAt', 'scope'], ['refreshToken']) &&
  isText(value.accessToken, MAX_SECRET_CHARS) &&
  isCount(value.expiresAt) &&
  isScopes(value.scope) &&
  (value.refreshToken === undefined || isText(value.refreshToken, MAX_SECRET_CHARS))

function isMcpOAuthRecord(value: unknown): value is McpOAuthRecord {
  return (
    isRecord(value) &&
    hasKeys(value, ['version', 'kind', 'epoch', 'rev', 'requiredScope'], ['client', 'server', 'tokens']) &&
    value.version === 2 &&
    value.kind === 'oauth' &&
    isCount(value.epoch) &&
    isCount(value.rev) &&
    isScopes(value.requiredScope) &&
    (value.client === undefined || isClient(value.client)) &&
    (value.server === undefined || isServer(value.server)) &&
    (value.tokens === undefined || isTokens(value.tokens))
  )
}

export function createMcpOAuthStore(options: CreateMcpOAuthStoreOptions): McpOAuthStore {
  const { root } = options
  const enforcement = credentialFileEnforcement(options.platform ?? createPlatform())
  const credentials = createCredentialStore({
    root,
    ...(options.platform ? { platform: options.platform } : {}),
  })
  const refOf = (serverId: string) => `secret://mcp-oauth/${serverId}`
  const readRaw = (ref: string, kind: 'api-key' | 'oauth') =>
    readCredentialFile({ root, ref, kind, enforcement })

  async function read(serverId: string): Promise<McpOAuthRead> {
    const ref = refOf(serverId)
    // Look at both locations: one ref naming an api-key and an OAuth credential is ambiguous.
    const apiRaw = await readRaw(ref, 'api-key')
    const oauthRaw = await readRaw(ref, 'oauth')
    if (apiRaw !== null) throw new CredentialStoreError(ref, 'kind-conflict')
    if (oauthRaw === null) return null
    let value: unknown
    try {
      value = JSON.parse(oauthRaw)
    } catch {
      throw new CredentialStoreError(ref, 'invalid-json')
    }
    if (isRecord(value) && value.version === 2) {
      if (!isMcpOAuthRecord(value)) throw new CredentialStoreError(ref, 'schema')
      return value
    }
    // Anything else must be a valid file of the older format; the older reader decides that.
    const older = await credentials.read(ref)
    if (older?.kind === 'oauth' && older.version === 1) return { legacy: true }
    throw new CredentialStoreError(ref, 'schema')
  }

  async function locked<T>(serverId: string, action: () => Promise<T>): Promise<T> {
    const ref = refOf(serverId)
    resolveCredentialFile(root, ref, 'oauth')
    if (enforcement.level !== 'full') throw new CredentialStoreError(ref, 'enforcement-unavailable')
    await prepareCredentialWrite(root, ref, 'oauth', enforcement)
    const file = `${resolveCredentialFile(root, ref, 'oauth')}.lock.sqlite`
    try {
      const fd = await open(file, 'wx', 0o600)
      await fd.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new CredentialStoreError(ref, 'not-file')
    return withConfigurationLock(file, action, {
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    })
  }

  return {
    read,
    update: (serverId, change, updateOptions) =>
      locked(serverId, async () => {
        const current = await read(serverId).catch((error: unknown) => {
          if (
            updateOptions?.replaceUnreadable &&
            error instanceof CredentialStoreError &&
            (error.reason === 'schema' || error.reason === 'invalid-json')
          )
            return null
          throw error
        })
        const { value, next } = await change(current)
        if (next === undefined) return value
        const ref = refOf(serverId)
        const record: McpOAuthRecord = {
          version: 2,
          kind: 'oauth',
          epoch: next.epoch,
          rev: (current !== null && !('legacy' in current) ? current.rev : 0) + 1,
          ...(next.client ? { client: next.client } : {}),
          ...(next.server ? { server: next.server } : {}),
          ...(next.tokens ? { tokens: next.tokens } : {}),
          requiredScope: next.requiredScope,
        }
        if (!isMcpOAuthRecord(JSON.parse(JSON.stringify(record))))
          throw new CredentialStoreError(ref, 'schema')
        await atomicWriteCredentialFile({
          root,
          ref,
          kind: 'oauth',
          contents: `${JSON.stringify(record)}\n`,
          enforcement,
        })
        return value
      }),
  }
}
