import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStoreError, createCredentialStore } from '../src/adapters/credential-store.js'
import { createMcpOAuthStore, type McpOAuthNext } from '../src/adapters/mcp-oauth-store.js'

const ref = (id: string) => `secret://mcp-oauth/${id}`

const next = (overrides: Partial<McpOAuthNext> = {}): McpOAuthNext => ({
  epoch: 0,
  client: { clientId: 'client-1', redirectUri: 'http://localhost:4000/callback' },
  server: {
    endpoint: 'https://mcp.example.com/mcp',
    authorizationServer: 'https://auth.example.com',
    tokenEndpoint: 'https://auth.example.com/token',
    resource: 'https://mcp.example.com/mcp',
  },
  tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_780_000_000_000, scope: ['a'] },
  requiredScope: [],
  ...overrides,
})

const v1 = {
  provider: 'mcp-oauth',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1_780_000_000_000,
  scope: ['models:read'],
  grantId: 'grant-1',
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialStoreError) return error.reason
    throw error
  }
  throw new Error('should have refused')
}

describe.runIf(process.getuid !== undefined)('MCP OAuth credential store', () => {
  let parent: string
  let root: string
  const file = (id: string) => join(root, 'auth', 'mcp-oauth', `${id}.json`)

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'agnes-mcp-oauth-'))
    chmodSync(parent, 0o700)
    root = join(parent, '.agh')
  })

  afterEach(() => rmSync(parent, { recursive: true, force: true }))

  it('reads nothing before the first write', async () => {
    expect(await createMcpOAuthStore({ root }).read('a')).toBeNull()
  })

  it('writes a v2 record with rev 1 and reads it back', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: undefined, next: next() }))

    expect(await store.read('a')).toEqual({ version: 2, kind: 'oauth', rev: 1, ...next() })
    expect(lstatSync(file('a')).mode & 0o7777).toBe(0o600)
    expect(lstatSync(join(root, 'auth', 'mcp-oauth')).mode & 0o7777).toBe(0o700)
    expect(JSON.parse(readFileSync(file('a'), 'utf8'))).toMatchObject({ version: 2, kind: 'oauth', rev: 1 })
  })

  it('each write bumps rev by one and a change without next leaves the file alone', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: 1, next: next() }))
    await store.update('a', async () => ({ value: 2, next: next({ requiredScope: ['x'] }) }))
    expect(await store.read('a')).toMatchObject({ rev: 2, requiredScope: ['x'] })

    const before = readFileSync(file('a'), 'utf8')
    const value = await store.update('a', async (current) => ({
      value: current !== null && !('legacy' in current) ? current.rev : -1,
    }))
    expect(value).toBe(2)
    expect(readFileSync(file('a'), 'utf8')).toBe(before)
  })

  it('stores a logged-out record with only epoch, rev and an empty requiredScope', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: 0, next: next() }))
    await store.update('a', async () => ({ value: 0, next: { epoch: 1, requiredScope: [] } }))
    expect(await store.read('a')).toEqual({
      version: 2,
      kind: 'oauth',
      epoch: 1,
      rev: 2,
      requiredScope: [],
    })
  })

  it('a record without optional parts is stored as given', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({
      value: 0,
      next: next({
        client: {
          clientId: 'c',
          clientSecret: 's',
          tokenEndpointAuthMethod: 'private_key_jwt',
          redirectUri: 'http://localhost:1/callback',
        },
        tokens: { accessToken: 'only-access', expiresAt: 5, scope: [] },
      }),
    }))
    const stored = await store.read('a')
    expect(stored).toMatchObject({
      client: { clientSecret: 's', tokenEndpointAuthMethod: 'private_key_jwt' },
      tokens: { accessToken: 'only-access', expiresAt: 5, scope: [] },
    })
    expect(stored).not.toHaveProperty('tokens.refreshToken')
  })

  it('legacy v1 reads as legacy and a v2 write replaces it', async () => {
    await createCredentialStore({ root }).putOAuth(ref('a'), v1)
    const store = createMcpOAuthStore({ root })
    expect(await store.read('a')).toEqual({ legacy: true })

    let seen: unknown
    await store.update('a', async (current) => {
      seen = current
      return { value: 0, next: next() }
    })
    expect(seen).toEqual({ legacy: true })
    expect(await store.read('a')).toMatchObject({ version: 2, rev: 1 })
  })

  it('rejects unknown fields, bad scopes and oversized values', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: 0, next: next() }))
    const good = JSON.parse(readFileSync(file('a'), 'utf8'))
    const put = (value: unknown) => {
      writeFileSync(file('a'), `${JSON.stringify(value)}\n`, { mode: 0o600 })
      chmodSync(file('a'), 0o600)
    }

    put({ ...good, extra: 1 })
    expect(await reason(store.read('a'))).toBe('schema')
    put({ ...good, tokens: { ...good.tokens, extra: 1 } })
    expect(await reason(store.read('a'))).toBe('schema')
    for (const scope of ['a b', 'a"b', 'a\\b', '', 'a'.repeat(1025), 'é']) {
      put({ ...good, requiredScope: [scope] })
      expect(await reason(store.read('a')), scope).toBe('schema')
    }
    put({ ...good, requiredScope: Array.from({ length: 129 }, (_, i) => `s${i}`) })
    expect(await reason(store.read('a'))).toBe('schema')
    for (const bad of [{ rev: -1 }, { rev: 1.5 }, { epoch: -1 }, { epoch: 2 ** 60 }, { version: 3 }]) {
      put({ ...good, ...bad })
      expect(await reason(store.read('a')), JSON.stringify(bad)).toBe('schema')
    }
    put({ ...good, client: { ...good.client, clientId: 'c'.repeat(513) } })
    expect(await reason(store.read('a'))).toBe('schema')
    put({ ...good, server: { ...good.server, tokenEndpoint: `https://x.example/${'p'.repeat(2048)}` } })
    expect(await reason(store.read('a'))).toBe('schema')
    put({ ...good, tokens: { ...good.tokens, accessToken: 'x'.repeat(65_537) } })
    expect(await reason(store.read('a'))).toBe('schema')
    writeFileSync(file('a'), '{not json', { mode: 0o600 })
    expect(await reason(store.read('a'))).toBe('invalid-json')

    put(good)
    expect(await store.read('a')).toMatchObject({ rev: 1 })
  })

  it('refuses to write a record that fails the same checks', async () => {
    const store = createMcpOAuthStore({ root })
    expect(
      await reason(store.update('a', async () => ({ value: 0, next: next({ requiredScope: ['a b'] }) }))),
    ).toBe('schema')
    expect(await reason(store.update('a', async () => ({ value: 0, next: next({ epoch: -1 }) })))).toBe(
      'schema',
    )
    expect(await store.read('a')).toBeNull()
  })

  it('stores scopes that are valid per RFC 6749 but not the old lowercase set', async () => {
    const store = createMcpOAuthStore({ root })
    const scope = ['Mail.Read', 'https://www.googleapis.com/auth/drive']
    await store.update('a', async () => ({
      value: 0,
      next: next({ requiredScope: scope, tokens: { accessToken: 't', expiresAt: 1, scope } }),
    }))
    expect(await store.read('a')).toMatchObject({ requiredScope: scope, tokens: { scope } })
  })

  it('an api-key file at the same ref is a conflict', async () => {
    await createCredentialStore({ root }).putApiKey(ref('a'), 'key-marker')
    const store = createMcpOAuthStore({ root })
    expect(await reason(store.update('a', async () => ({ value: 0, next: next() })))).toBe('kind-conflict')
    expect(await reason(store.read('a'))).toBe('kind-conflict')
  })

  it('refuses an invalid server id', async () => {
    const store = createMcpOAuthStore({ root })
    expect(await reason(store.read('../x'))).toBe('bad-ref')
    expect(await reason(store.update('A/b', async () => ({ value: 0 })))).toBe('bad-ref')
  })

  it('the old reader rejects a v2 file and the old writer recovers it', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: 0, next: next() }))

    const old = createCredentialStore({ root })
    expect(await reason(old.read(ref('a')))).toBe('schema')

    await old.putOAuth(ref('a'), v1)
    expect(await old.read(ref('a'))).toMatchObject({ version: 1, kind: 'oauth', grantId: 'grant-1' })
    expect(await store.read('a')).toEqual({ legacy: true })
  })

  it('updates on one server run one at a time', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: 0, next: next() }))

    let entered: () => void = () => undefined
    const firstRunning = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = store.update('a', async () => {
      entered()
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { value: 'first', next: next({ requiredScope: ['first'] }) }
    })
    await firstRunning
    let secondSaw: unknown
    const second = store.update('a', async (current) => {
      secondSaw = current
      return { value: 'second' }
    })
    await Promise.all([first, second])
    expect(secondSaw).toMatchObject({ rev: 2, requiredScope: ['first'] })
  })

  it('updates on different servers do not wait for each other', async () => {
    const store = createMcpOAuthStore({ root, lockTimeoutMs: 200 })
    await store.update('a', async () => {
      await store.update('b', async () => ({ value: 0, next: next() }))
      return { value: 0, next: next() }
    })
    expect(await store.read('b')).toMatchObject({ rev: 1 })
  })

  it('gives up waiting for a held lock after the timeout', async () => {
    const store = createMcpOAuthStore({ root, lockTimeoutMs: 100 })
    let release: () => void = () => undefined
    let held: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      held = resolve
    })
    const first = store.update('a', async () => {
      held()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { value: 0 }
    })
    await holding
    await expect(store.update('a', async () => ({ value: 0 }))).rejects.toBeDefined()
    release()
    await first
  })

  it('does not follow a symlinked lock file', async () => {
    const store = createMcpOAuthStore({ root })
    await store.update('a', async () => ({ value: 0, next: next() }))
    mkdirSync(join(parent, 'elsewhere'))
    const { symlinkSync, unlinkSync } = await import('node:fs')
    unlinkSync(`${file('a')}.lock.sqlite`)
    symlinkSync(join(parent, 'elsewhere', 'lock'), `${file('a')}.lock.sqlite`)
    await expect(store.update('a', async () => ({ value: 0 }))).rejects.toBeDefined()
  })
})
