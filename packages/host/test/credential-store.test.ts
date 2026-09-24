import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CredentialFileEnforcement,
  credentialFileEnforcement,
  readCredentialFile,
  resolveCredentialFile,
} from '../src/adapters/credential-files.js'
import {
  CredentialStoreError,
  createCredentialStore,
  type OAuthCredential,
} from '../src/adapters/credential-store.js'
import { createPlatform, createWin32Platform } from '../src/adapters/platform.js'

const posix: CredentialFileEnforcement = {
  level: 'full',
  mechanism: 'posix-mode-owner',
  ownerUid: process.getuid?.() ?? 0,
}

const oauth: OAuthCredential = {
  provider: 'agnes-subscription',
  accessToken: 'access-token-marker',
  refreshToken: 'refresh-token-marker',
  expiresAt: 1_780_000_000_000,
  scope: ['models:read', 'inference:run', 'usage:read'],
  grantId: 'grant-marker',
}

function refusal(promise: Promise<unknown>): Promise<CredentialStoreError> {
  return promise.then(
    () => {
      throw new Error('should have refused')
    },
    (error: unknown) => {
      if (!(error instanceof CredentialStoreError)) throw error
      return error
    },
  )
}

describe.runIf(process.getuid !== undefined)('credential store', () => {
  let parent: string
  let root: string

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-credential-'))
    root = join(parent, '.agh')
  })

  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('writes and reads closed API-key and OAuth envelopes with 0700/0600 permissions', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    await store.putOAuth('secret://agnes/subscription', oauth)

    expect(await store.read('secret://deepseek/default')).toEqual({
      version: 1,
      kind: 'api-key',
      provider: 'deepseek',
      value: 'api-key-marker',
    })
    expect(await store.read('secret://agnes/subscription')).toEqual({
      version: 1,
      kind: 'oauth',
      ...oauth,
    })

    for (const dir of [
      root,
      join(root, 'auth'),
      join(root, 'auth', 'agnes'),
      join(root, 'secrets'),
      join(root, 'secrets', 'deepseek'),
      join(root, 'locks'),
    ])
      expect(lstatSync(dir).mode & 0o7777, dir).toBe(0o700)
    for (const file of [
      resolveCredentialFile(root, 'secret://deepseek/default', 'api-key'),
      resolveCredentialFile(root, 'secret://agnes/subscription', 'oauth'),
    ]) {
      expect(lstatSync(file).mode & 0o7777, file).toBe(0o600)
      expect(lstatSync(file).isFile()).toBe(true)
      expect(lstatSync(file).nlink).toBe(1)
    }
  })

  it.each([
    'literal-key',
    'secret:///name',
    'secret://provider/',
    'secret://provider/a/b',
    'secret://provider/..',
    'secret://provider/.',
    'secret://provider/%2e%2e',
    'secret://provider/name\n',
    'secret://provider/na\u0000me',
    'secret://Provider/name',
  ])('rejects an unanchored or unsafe ref without touching outside paths: %j', async (ref) => {
    const store = createCredentialStore({ root })
    const error = await refusal(store.putApiKey(ref, 'api-key-marker'))
    expect(error).toMatchObject({ code: 'CREDENTIAL_STORE_UNSAFE', ref: '<invalid>', reason: 'bad-ref' })
    expect(JSON.stringify(error)).not.toContain(ref)
    expect(lstatSync(parent).isDirectory()).toBe(true)
  })

  it('refuses a symlink credential without reading or overwriting its target', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'first-marker')
    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    const target = join(parent, 'outside')
    writeFileSync(target, 'outside-marker', { mode: 0o600 })
    rmSync(file)
    symlinkSync(target, file)

    expect(await refusal(store.read('secret://deepseek/default'))).toMatchObject({ reason: 'symlink' })
    expect(await refusal(store.putApiKey('secret://deepseek/default', 'second-marker'))).toMatchObject({
      reason: 'symlink',
    })
    expect(readFileSync(target, 'utf8')).toBe('outside-marker')
  })

  it('refuses a symlink in a credential parent directory', async () => {
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(join(root, 'secrets'), { mode: 0o700 })
    const outside = join(parent, 'outside-dir')
    mkdirSync(outside, { mode: 0o700 })
    symlinkSync(outside, join(root, 'secrets', 'deepseek'))

    const store = createCredentialStore({ root })
    expect(await refusal(store.putApiKey('secret://deepseek/default', 'api-key-marker'))).toMatchObject({
      reason: 'symlink',
    })
    expect(() => readFileSync(join(outside, 'default'), 'utf8')).toThrow()
  })

  it.each([
    ['owner/world readable file', 0o644],
    ['group-readable file', 0o640],
    ['world-readable file', 0o604],
    ['owner-read-only file', 0o400],
  ])('refuses a %s rather than silently repairing it', async (_label, mode) => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    chmodSync(file, mode)
    expect(await refusal(store.read('secret://deepseek/default'))).toMatchObject({ reason: 'mode' })
    expect(await refusal(store.putApiKey('secret://deepseek/default', 'replacement-marker'))).toMatchObject({
      reason: 'mode',
    })
  })

  it('refuses an unsafe store directory and a non-regular credential', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    chmodSync(join(root, 'secrets'), 0o755)
    expect(await refusal(store.read('secret://deepseek/default'))).toMatchObject({ reason: 'mode' })
    chmodSync(join(root, 'secrets'), 0o700)

    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    rmSync(file)
    mkdirSync(file, { mode: 0o700 })
    expect(await refusal(store.read('secret://deepseek/default'))).toMatchObject({ reason: 'not-file' })
  })

  it('refuses a credential not owned by the expected uid when owner enforcement is available', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    const wrongOwner: CredentialFileEnforcement = { ...posix, ownerUid: posix.ownerUid + 1 }
    expect(
      await refusal(
        readCredentialFile({
          root,
          ref: 'secret://deepseek/default',
          kind: 'api-key',
          enforcement: wrongOwner,
        }),
      ),
    ).toMatchObject({ reason: 'owner' })
  })

  it('refuses a hard-linked credential whose link count is not one', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    linkSync(file, join(parent, 'second-link'))
    expect(await refusal(store.read('secret://deepseek/default'))).toMatchObject({ reason: 'link-count' })
  })

  it.each([
    ['unknown version', { version: 2, kind: 'api-key', provider: 'deepseek', value: 'marker' }],
    ['unknown kind', { version: 1, kind: 'password', provider: 'deepseek', value: 'marker' }],
    ['unknown field', { version: 1, kind: 'api-key', provider: 'deepseek', value: 'marker', surprise: true }],
  ])('fails closed on an %s', async (_label, envelope) => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
    expect(await refusal(store.read('secret://deepseek/default'))).toMatchObject({ reason: 'schema' })
  })

  it('fails closed on truncated JSON without leaking file content through the error', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    writeFileSync(file, '{"version":1,"kind":"api-key","value":"truncated-secret', { mode: 0o600 })

    const error = await refusal(store.read('secret://deepseek/default'))
    expect(error).toMatchObject({ reason: 'invalid-json', ref: 'secret://deepseek/default' })
    expect(error.message).not.toContain('truncated-secret')
    expect(JSON.stringify(error)).not.toContain('truncated-secret')
  })

  it('rejects invalid caller values before creating a file', async () => {
    const store = createCredentialStore({ root })
    expect(await refusal(store.putApiKey('secret://deepseek/default', ''))).toMatchObject({
      reason: 'schema',
    })
    expect(
      await refusal(
        store.putOAuth('secret://agnes/subscription', { ...oauth, scope: ['usage:read', 'usage:read'] }),
      ),
    ).toMatchObject({ reason: 'schema' })
  })

  it('removes a credential and reports a missing ref as null', async () => {
    const store = createCredentialStore({ root })
    expect(await store.read('secret://deepseek/default')).toBeNull()
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    await store.remove('secret://deepseek/default')
    expect(await store.read('secret://deepseek/default')).toBeNull()
  })

  it('derives an explicit private-file enforcement level from the platform adapter', () => {
    expect(credentialFileEnforcement(createPlatform()).level).toBe('full')
    expect(credentialFileEnforcement(createWin32Platform())).toEqual({
      level: 'unavailable',
      mechanism: 'windows-acl',
      reason: 'private credential ACL enforcement is unavailable',
    })
  })

  it('fails closed when the selected platform cannot enforce private credential files', async () => {
    const enforcement = credentialFileEnforcement(createWin32Platform())
    const store = createCredentialStore({ root, platform: createWin32Platform() })
    expect(store.enforcement).toEqual(enforcement)
    expect(await refusal(store.putApiKey('secret://deepseek/default', 'api-key-marker'))).toMatchObject({
      reason: 'enforcement-unavailable',
    })
  })

  it('places temp files in the destination directory and leaves none after a successful rename', async () => {
    const store = createCredentialStore({ root })
    await store.putApiKey('secret://deepseek/default', 'api-key-marker')
    const file = resolveCredentialFile(root, 'secret://deepseek/default', 'api-key')
    const names = readFileSync(file, 'utf8')
    expect(names.endsWith('\n')).toBe(true)
    expect(readdirSync(dirname(file)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
