import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileSecretsDir } from '@agnes/host-common/paths'
import type { PermissionEffectAdmission } from '@agnes/protocol'
import {
  atomicWriteCredentialFile,
  type CredentialFileEnforcement,
  type CredentialKind,
  CredentialStoreError,
  credentialFileEnforcement,
  parseCredentialRef,
  prepareCredentialWrite,
  readCredentialFile,
  removeCredentialFile,
} from './credential-files.js'
import { createPlatform, type PlatformBackend } from './platform.js'

export type ApiKeyCredentialV1 = {
  version: 1
  kind: 'api-key'
  provider: string
  value: string
  /** Present together only for daemon-managed generic credentials. */
  label?: string
  createdAt?: string
}

export type OAuthCredential = {
  provider: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string[]
  grantId: string
}

export type OAuthCredentialV1 = OAuthCredential & {
  version: 1
  kind: 'oauth'
}

export type SubscriptionCredentialV2 = {
  version: 2
  kind: 'oauth'
  provider: 'anthropic' | 'github-copilot' | 'kimi-coding' | 'openai-codex' | 'xai'
  access: string
  refresh: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  availableModelIds?: string[]
}
export type CodexCredentialV2 = SubscriptionCredentialV2 & {
  provider: 'openai-codex'
  accountId: string
}
export type StoredCredentialV1 = ApiKeyCredentialV1 | OAuthCredentialV1
export type StoredCredential = StoredCredentialV1 | SubscriptionCredentialV2

export interface CredentialWriter {
  putApiKey(ref: string, value: string): Promise<void>
  putOAuth(ref: string, value: OAuthCredential): Promise<void>
  remove(ref: string, admission?: PermissionEffectAdmission): Promise<void>
}

export interface CredentialStore extends CredentialWriter {
  readonly enforcement: CredentialFileEnforcement
  read(ref: string): Promise<StoredCredential | null>
  listGeneric(): Promise<GenericCredentialMetadata[]>
  putGeneric(
    ref: string,
    value: string,
    metadata: { label: string; createdAt: string },
    admission?: PermissionEffectAdmission,
  ): Promise<void>
}

export type GenericCredentialMetadata = { id: string; label: string; kind: 'api-key'; createdAt: string }

export function isGenericCredential(
  value: unknown,
): value is ApiKeyCredentialV1 & { label: string; createdAt: string } {
  return (
    isApiKeyCredential(value) &&
    value.provider === 'generic' &&
    value.value.trim().length > 0 &&
    typeof value.label === 'string' &&
    typeof value.createdAt === 'string'
  )
}

export type CreateCredentialStoreOptions = {
  /** The `~/.agh`-shaped anchor, not its `auth` or `secrets` child. */
  root: string
  /** Omitted selects the running platform; primarily injectable for platform conformance tests. */
  platform?: Pick<PlatformBackend, 'os'>
}

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_VALUE = /^[^\p{Cc}]+$/u
const SAFE_SCOPE = /^[a-z0-9][a-z0-9:._-]{0,127}$/
const MAX_SECRET_CHARS = 65_536
const MAX_GRANT_CHARS = 512
const MAX_SCOPES = 64

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS && SAFE_VALUE.test(value)

const isProvider = (value: unknown): value is string => typeof value === 'string' && PROVIDER.test(value)

const isScopes = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_SCOPES &&
  value.every((scope) => typeof scope === 'string' && SAFE_SCOPE.test(scope)) &&
  new Set(value).size === value.length

function isApiKeyCredential(value: unknown): value is ApiKeyCredentialV1 {
  return (
    isRecord(value) &&
    (exactKeys(value, ['version', 'kind', 'provider', 'value']) ||
      (exactKeys(value, ['version', 'kind', 'provider', 'value', 'label', 'createdAt']) &&
        value.provider === 'generic' &&
        typeof value.label === 'string' &&
        value.label.length > 0 &&
        value.label.length <= 128 &&
        SAFE_VALUE.test(value.label) &&
        typeof value.createdAt === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) &&
        Number.isFinite(Date.parse(value.createdAt)))) &&
    value.version === 1 &&
    value.kind === 'api-key' &&
    isProvider(value.provider) &&
    isSecret(value.value)
  )
}

function isOAuthInput(value: unknown): value is OAuthCredential {
  return (
    isRecord(value) &&
    exactKeys(value, ['provider', 'accessToken', 'refreshToken', 'expiresAt', 'scope', 'grantId']) &&
    isProvider(value.provider) &&
    isSecret(value.accessToken) &&
    isSecret(value.refreshToken) &&
    Number.isSafeInteger(value.expiresAt) &&
    (value.expiresAt as number) > 0 &&
    isScopes(value.scope) &&
    typeof value.grantId === 'string' &&
    value.grantId.length > 0 &&
    value.grantId.length <= MAX_GRANT_CHARS &&
    SAFE_VALUE.test(value.grantId)
  )
}

function isOAuthCredential(value: unknown): value is OAuthCredentialV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'kind',
      'provider',
      'accessToken',
      'refreshToken',
      'expiresAt',
      'scope',
      'grantId',
    ])
  )
    return false
  if (value.version !== 1 || value.kind !== 'oauth') return false
  const { version: _version, kind: _kind, ...input } = value
  return isOAuthInput(input)
}

function schemaError(ref: string): CredentialStoreError {
  return new CredentialStoreError(ref, 'schema')
}

function parseEnvelope(ref: string, raw: string, expected: CredentialKind): StoredCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CredentialStoreError(ref, 'invalid-json')
  }
  if (expected === 'api-key') {
    if (!isApiKeyCredential(value)) throw schemaError(ref)
    const parsedRef = parseCredentialRef(ref)
    if (value.provider !== parsedRef.provider) throw schemaError(ref)
    return value
  }
  if (isSubscriptionCredential(value)) {
    if (parseCredentialRef(ref).provider !== value.provider) throw schemaError(ref)
    return value
  }
  if (!isOAuthCredential(value)) throw schemaError(ref)
  return value
}

const encode = (value: StoredCredentialV1): string => `${JSON.stringify(value)}\n`

export function isCodexCredential(value: unknown): value is CodexCredentialV2 {
  return isSubscriptionCredential(value, 'openai-codex')
}

export function isSubscriptionCredential(
  value: unknown,
  expectedProvider?: string,
): value is SubscriptionCredentialV2 {
  const providers = new Set(['anthropic', 'github-copilot', 'kimi-coding', 'openai-codex', 'xai'])
  if (!isRecord(value) || value.version !== 2 || value.kind !== 'oauth') return false
  if (!providers.has(String(value.provider)) || (expectedProvider && value.provider !== expectedProvider))
    return false
  const optional = ['accountId', 'enterpriseUrl', 'availableModelIds']
  const base = ['version', 'kind', 'provider', 'access', 'refresh', 'expires']
  if (Object.keys(value).some((key) => !base.includes(key) && !optional.includes(key))) return false
  if (!base.every((key) => Object.hasOwn(value, key))) return false
  if (
    !isSecret(value.access) ||
    !isSecret(value.refresh) ||
    !Number.isSafeInteger(value.expires) ||
    (value.expires as number) <= 0
  )
    return false
  if (value.provider === 'openai-codex') {
    if (!isSecret(value.accountId) || value.accountId.length > 512) return false
  } else if (value.accountId !== undefined) return false
  if (value.provider === 'github-copilot') {
    if (
      (value.enterpriseUrl !== undefined &&
        (typeof value.enterpriseUrl !== 'string' ||
          value.enterpriseUrl.length > 253 ||
          !/^[a-z0-9.-]+$/i.test(value.enterpriseUrl))) ||
      (value.availableModelIds !== undefined &&
        (!Array.isArray(value.availableModelIds) ||
          value.availableModelIds.length > 4096 ||
          !value.availableModelIds.every(
            (id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && SAFE_VALUE.test(id),
          ) ||
          new Set(value.availableModelIds).size !== value.availableModelIds.length))
    )
      return false
  } else if (value.enterpriseUrl !== undefined || value.availableModelIds !== undefined) return false
  return true
}

export function createCredentialStore(options: CreateCredentialStoreOptions): CredentialStore {
  const enforcement = credentialFileEnforcement(options.platform ?? createPlatform())
  const readRaw = (ref: string, kind: CredentialKind) =>
    readCredentialFile({ root: options.root, ref, kind, enforcement })

  return {
    enforcement,
    async listGeneric() {
      // Validate parents through the existing reader before enumerating; absence is an empty store.
      await readRaw('secret://generic/probe', 'api-key')
      let names: string[]
      try {
        names = await readdir(join(fileSecretsDir(options.root), 'generic'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw new CredentialStoreError('secret://generic/probe', 'io')
      }
      const items: GenericCredentialMetadata[] = []
      for (const name of names.sort()) {
        if (!/^[a-f0-9-]{36}$/.test(name)) continue
        const id = `secret://generic/${name}`
        const raw = await readRaw(id, 'api-key')
        if (raw === null) continue
        if ((await readRaw(id, 'oauth')) !== null) throw new CredentialStoreError(id, 'kind-conflict')
        const value = parseEnvelope(id, raw, 'api-key')
        if (!isGenericCredential(value)) throw schemaError(id)
        items.push({ id, label: value.label, kind: 'api-key', createdAt: value.createdAt })
        if (items.length > 4096) throw new CredentialStoreError(id, 'too-large')
      }
      return items
    },
    async putGeneric(ref, value, metadata, admission) {
      const { provider, name } = parseCredentialRef(ref)
      const envelope: ApiKeyCredentialV1 = { version: 1, kind: 'api-key', provider, value, ...metadata }
      if (provider !== 'generic' || !/^[a-f0-9-]{36}$/.test(name) || !isGenericCredential(envelope))
        throw schemaError(ref)
      await prepareCredentialWrite(options.root, ref, 'api-key', enforcement)
      if ((await readRaw(ref, 'oauth')) !== null) throw new CredentialStoreError(ref, 'kind-conflict')
      await atomicWriteCredentialFile({
        root: options.root,
        ref,
        kind: 'api-key',
        contents: encode(envelope),
        ...(admission ? { admission } : {}),
        enforcement,
      })
    },
    async read(ref) {
      // Inspect both locations before returning either one. A stale or attacker-created counterpart
      // is not ignored: one ref naming two credentials is ambiguous and therefore unsafe.
      const apiRaw = await readRaw(ref, 'api-key')
      const oauthRaw = await readRaw(ref, 'oauth')
      if (apiRaw !== null && oauthRaw !== null) throw new CredentialStoreError(ref, 'kind-conflict')
      if (apiRaw !== null) return parseEnvelope(ref, apiRaw, 'api-key')
      if (oauthRaw !== null) return parseEnvelope(ref, oauthRaw, 'oauth')
      return null
    },
    async putApiKey(ref, value) {
      const { provider } = parseCredentialRef(ref)
      const envelope: ApiKeyCredentialV1 = { version: 1, kind: 'api-key', provider, value }
      if (!isApiKeyCredential(envelope)) throw schemaError(ref)
      await prepareCredentialWrite(options.root, ref, 'api-key', enforcement)
      if ((await readRaw(ref, 'oauth')) !== null) throw new CredentialStoreError(ref, 'kind-conflict')
      await atomicWriteCredentialFile({
        root: options.root,
        ref,
        kind: 'api-key',
        contents: encode(envelope),
        enforcement,
      })
    },
    async putOAuth(ref, value) {
      parseCredentialRef(ref)
      if (!isOAuthInput(value)) throw schemaError(ref)
      await prepareCredentialWrite(options.root, ref, 'oauth', enforcement)
      const envelope: OAuthCredentialV1 = {
        version: 1,
        kind: 'oauth',
        provider: value.provider,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
        scope: [...value.scope],
        grantId: value.grantId,
      }
      if ((await readRaw(ref, 'api-key')) !== null) throw new CredentialStoreError(ref, 'kind-conflict')
      await atomicWriteCredentialFile({
        root: options.root,
        ref,
        kind: 'oauth',
        contents: encode(envelope),
        enforcement,
      })
    },
    async remove(ref, admission) {
      parseCredentialRef(ref)
      // Validate both objects before unlinking either, so a safe credential is not removed while an
      // unsafe counterpart remains hidden under the same ref.
      await readRaw(ref, 'api-key')
      await readRaw(ref, 'oauth')
      await removeCredentialFile({
        root: options.root,
        ref,
        kind: 'api-key',
        enforcement,
        ...(admission ? { admission } : {}),
      })
      await removeCredentialFile({
        root: options.root,
        ref,
        kind: 'oauth',
        enforcement,
        ...(admission ? { admission } : {}),
      })
    },
  }
}

export {
  type CredentialFileEnforcement,
  type CredentialKind,
  CredentialStoreError,
} from './credential-files.js'
