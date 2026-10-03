import { spawn } from 'node:child_process'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DataRef,
  type LegacyIdentityTransportEvidence,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type ScopeRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  type CurrentIdentity,
  createIdentityAuthority,
  type IdentityClaimsBinding,
  type IdentityClaimsOwner,
  identityAuthorityUsesDatabase,
} from '../../src/runtime/identity/authority.js'
import { decodeIdentityData, encodeIdentityData } from '../../src/runtime/identity/data.js'
import { createIdentityHttpSessions } from '../../src/runtime/identity/http-sessions.js'
import {
  createIdentityIngressAuthority,
  type IdentityConnectionFacts,
  identityInitializeDigest,
  identityLegacySigningDocument,
} from '../../src/runtime/identity/legacy-ingress.js'
import {
  createIdentityIngressReplayOwner,
  createIdentityNonceOwner,
} from '../../src/runtime/identity/nonce.js'
import type { IdentityCredentialSource } from '../../src/runtime/identity/source.js'
import {
  type IdentityVerificationPorts,
  identityPrincipalKey,
  verifyIdentityCredential,
} from '../../src/runtime/identity/verify.js'
import { createIdentityProviderFactory } from '../../src/runtime/providers/identity.js'

const now = Date.parse('2026-10-01T00:00:00.000Z')
const deadline = new Date(now + 120000).toISOString()
const providerScope: ScopeRef = { kind: 'runtime', installationId: 'install', runtimeId: 'runtime' }
const scope: ScopeRef = {
  kind: 'workspace',
  installationId: 'install',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
}
const evidence: LegacyIdentityTransportEvidence = {
  bindingId: 'identity-binding',
  ingressId: 'ingress',
  connectionId: 'connection',
  clientId: 'client',
  initializeDigest: 'a'.repeat(64),
  receivedAt: new Date(now).toISOString(),
  transport: 'rpc',
  localGate: 'none',
  channelBinding: 'b'.repeat(64),
  proof: { kind: 'in-process', issuerBindingId: 'identity-binding' },
}
const nonce = '1'.repeat(32)
const source = (timestamp = now / 1000, label = evidence.clientId) => ({
  kind: 'source-auth' as const,
  timestamp,
  nonce,
  signature: `v0=${createHmac('sha256', 'source-secret').update(`v0:${timestamp}:${nonce}:initialize\n${label}\n${evidence.initializeDigest}`).digest('hex')}`,
})
function token(payload: unknown, header: unknown = { alg: 'HS256' }) {
  const message = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  return `${message}.${createHmac('sha256', 'jwt-secret').update(message).digest('base64url')}`
}
function verificationSettings(clock = () => now): Omit<IdentityVerificationPorts, 'nonces'> {
  return {
    now: clock,
    generation: 'fixture-keyring-v1',
    jwt: { issuer: 'issuer', secret: 'jwt-secret' },
    portalSecret: 'portal-secret',
    sourceKeys: () => [{ keyId: 'key-1', secret: 'source-secret' }],
    surfaceSources: () => [
      { sourceId: 'surface-1', keys: [{ keyId: 'key-1', secret: 'source-secret' }], grants: [] },
    ],
  }
}
function verification(database: DatabaseSync, clock = () => now): IdentityVerificationPorts {
  return { ...verificationSettings(clock), nonces: createIdentityNonceOwner(database) }
}
function claimsOwner(database: DatabaseSync): IdentityClaimsOwner {
  database.exec(
    'CREATE TABLE IF NOT EXISTS fixture_claims (authorization_ref TEXT PRIMARY KEY, binding TEXT NOT NULL, data TEXT NOT NULL)',
  )
  const schema = defineGeneratedAuthorSchema<
    Readonly<{ authorizationRef: string; principalRef: string; tenantRef: string }>
  >({
    ownerPackageId: 'fixture.identity',
    name: 'Claims',
    typeId: 'fixture.identity/claims@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Claims',
      $defs: {
        Claims: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authorizationRef: { type: 'string' },
            principalRef: { type: 'string' },
            tenantRef: { type: 'string' },
          },
          required: ['authorizationRef', 'principalRef', 'tenantRef'],
        },
      },
    },
  })
  return {
    async create(binding) {
      const result = schema.encode({
        authorizationRef: binding.authorizationRef,
        principalRef: binding.principalRef,
        tenantRef: binding.tenantRef,
      })
      if (!result.ok) throw new Error('fixture claims encoding failed')
      database
        .prepare('INSERT INTO fixture_claims VALUES (?, ?, ?)')
        .run(binding.authorizationRef, jcs(binding), jcs(result.value))
      return result.value
    },
    validate(ref: DataRef, binding: IdentityClaimsBinding) {
      const row = database
        .prepare('SELECT * FROM fixture_claims WHERE authorization_ref = ?')
        .get(binding.authorizationRef)
      return !!row && row.binding === jcs(binding) && row.data === jcs(ref)
    },
  }
}
function fixture(database = new DatabaseSync(':memory:'), clock = () => now) {
  const binding = {
    bindingId: 'identity-binding',
    contract: 'agh.identity',
    logicalName: 'identity',
    providerId: 'default-identity',
  }
  const connection = {}
  let live = true
  let cross = false
  let generation = 'fixture-keyring-v1'
  const facts: IdentityConnectionFacts = {
    ...scope,
    installationId: 'install',
    runtimeId: 'runtime',
    scope,
    bindingId: binding.bindingId,
    tenantRef: 'tenant',
    connectionId: 'connection',
    channelBinding: 'b'.repeat(64),
    transport: 'local',
    localGate: 'local-peer',
  }
  const ingress = createIdentityIngressAuthority({
    now: clock,
    binding,
    readLegacyConnection: (input) => (input === connection && live ? facts : null),
    verifyHttpConnection: (input) => input === connection && live,
  })
  const authorize = (instance: CurrentIdentity, target: Readonly<{ bindingId: string; scope: ScopeRef }>) =>
    !cross && jcs(target.scope) === jcs(instance.scope) && target.bindingId === binding.bindingId
  const sessions = createIdentityHttpSessions(database, {
    now: clock,
    current: () => live,
    currentBinding: () => live,
  })
  const sourceCurrent = (source: IdentityCredentialSource) =>
    source.kind === 'deployment'
      ? source.generation === generation
      : sessions.current(source.ownerRef, source.revision)
  const authority = createIdentityAuthority(database, claimsOwner(database), clock, authorize, sourceCurrent)
  const emptySource = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../protocol/schema/runtime/empty-config.schema.json', import.meta.url)),
      'utf8',
    ),
  )
  delete emptySource.$id
  delete emptySource.$schema
  emptySource.required ??= []
  const config = defineGeneratedAuthorSchema<Readonly<Record<string, never>>>({
    ownerPackageId: 'fixture.identity',
    name: 'Empty',
    typeId: 'fixture.identity/config@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Empty',
      $defs: { Empty: emptySource },
    },
  })
  const calls = new WeakSet<object>()
  const control = Object.freeze({
    principalRef: 'control',
    scope,
    bindingId: binding.bindingId,
    authorizationRef: 'control-auth',
    invocationId: 'control-invoke',
    traceRef: 'trace',
    deadline,
    signal: new AbortController().signal,
  })
  calls.add(control)
  const authenticated: CurrentIdentity[] = []
  const options = {
    config,
    packageVersion: '1.0.0',
    packageDigest: 'c'.repeat(64),
    binding,
    ingress,
    authority,
    sessions,
    verification: async () => ({ ...verification(database, clock), generation }),
    principal: async (key: string) => `principal-${canonicalJsonDigest(key)}`,
    control: (input: CallContext) => calls.has(input),
    authenticated: (_context: unknown, instance: CurrentIdentity) => {
      authenticated.push(instance)
    },
    now: clock,
  }
  const factory = createIdentityProviderFactory(options)
  const encoded = config.encode({})
  if (!encoded.ok) throw new Error('fixture empty encoding failed')
  const dependencies: ScopedDependencies = {
    get: () => {
      throw new Error('unexpected dependency')
    },
    openScope: async () => {
      throw new Error('unexpected scope')
    },
    close: async () => {},
  }
  return {
    database,
    options,
    factory,
    config: encoded.value,
    dependencies,
    control,
    connection,
    authority,
    ingress,
    binding,
    authenticated,
    sessions,
    setGeneration: (value: string) => {
      generation = value
    },
    setLive: (value: boolean) => {
      live = value
    },
    setCross: (value: boolean) => {
      cross = value
    },
  }
}

describe('identity durable nonce and cryptography', () => {
  it('binds a genuine C14 authority to its exact native database', () => {
    const selected = fixture()
    const foreign = new DatabaseSync(':memory:')
    try {
      expect(identityAuthorityUsesDatabase(selected.authority, selected.database)).toBe(true)
      expect(identityAuthorityUsesDatabase(selected.authority, foreign)).toBe(false)
      expect(identityAuthorityUsesDatabase({ ...selected.authority }, selected.database)).toBe(false)
    } finally {
      selected.authority.close()
      selected.database.close()
      foreign.close()
    }
  })

  it('rolls both namespaces back if the second real SQLite write fails', () => {
    const db = new DatabaseSync(':memory:')
    const owner = createIdentityNonceOwner(db)
    db.exec(
      `CREATE TRIGGER reject_key BEFORE INSERT ON auth_nonces WHEN NEW.client_id LIKE 'source-key:%' BEGIN SELECT RAISE(ABORT, 'fault'); END`,
    )
    expect(() =>
      owner.consumePair({ clientId: 'client', keyId: 'key', nonce, now, expiresAt: now + 60000 }),
    ).toThrow('fault')
    expect(db.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(0)
    db.exec('DROP TRIGGER reject_key')
    expect(owner.consumePair({ clientId: 'client', keyId: 'key', nonce, now, expiresAt: now + 60000 })).toBe(
      true,
    )
    expect(owner.consumePair({ clientId: 'other', keyId: 'key', nonce, now, expiresAt: now + 60000 })).toBe(
      false,
    )
    expect(db.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(2)
    db.close()
  })
  it('preserves pre-migration rows and future-skew replay protection through a cold reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-nonce-'))
    const path = join(dir, 'owner.sqlite')
    try {
      const db = new DatabaseSync(path)
      db.exec(
        'CREATE TABLE auth_nonces (client_id TEXT NOT NULL,nonce TEXT NOT NULL,seen_at INTEGER NOT NULL,PRIMARY KEY(client_id,nonce))',
      )
      db.prepare('INSERT INTO auth_nonces VALUES (?,?,?)').run('client', nonce, now)
      const owner = createIdentityNonceOwner(db)
      expect(
        owner.consumePair({
          clientId: 'client',
          keyId: 'key',
          nonce,
          now: now + 300001,
          expiresAt: now + 600000,
        }),
      ).toBe(false)
      db.close()
      const reopened = new DatabaseSync(path)
      expect(
        createIdentityNonceOwner(reopened).consumePair({
          clientId: 'client',
          keyId: 'key',
          nonce,
          now: now + 599999,
          expiresAt: now + 600000,
        }),
      ).toBe(false)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('does not burn a Surface nonce when subject validation fails', () => {
    const db = new DatabaseSync(':memory:')
    const ports = verification(db)
    expect(
      verifyIdentityCredential(
        {
          kind: 'surface',
          sourceId: 'surface-1',
          source: source(),
          subject: { kind: 'jwt', token: 'invalid' },
        },
        evidence,
        ports,
      ).ok,
    ).toBe(false)
    expect(db.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(0)
    expect(
      verifyIdentityCredential(
        {
          kind: 'surface',
          sourceId: 'surface-1',
          source: source(),
          subject: { kind: 'jwt', token: token({ sub: 'user', iss: 'issuer', exp: now / 1000 + 60 }) },
        },
        evidence,
        ports,
      ).ok,
    ).toBe(true)
    expect(db.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(2)
    db.close()
  })
  it('rejects algorithm, issuer, expiry, critical extension and source signature mutations', () => {
    const db = new DatabaseSync(':memory:')
    const ports = verification(db)
    const payload = { sub: 'user', iss: 'issuer', exp: now / 1000 + 60 }
    expect(verifyIdentityCredential({ kind: 'jwt', token: token(payload) }, evidence, ports).ok).toBe(true)
    for (const invalid of [
      token({ ...payload, iss: 'wrong' }),
      token({ ...payload, exp: now / 1000 }),
      token(payload, { alg: 'none' }),
      token(payload, { alg: 'HS256', crit: ['fake'] }),
      `${token(payload)}.extra`,
    ])
      expect(verifyIdentityCredential({ kind: 'jwt', token: invalid }, evidence, ports).ok).toBe(false)
    expect(
      verifyIdentityCredential({ ...source(), signature: `v0=${'0'.repeat(64)}` }, evidence, ports).ok,
    ).toBe(false)
    expect(db.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(0)
    db.close()
  })
  it('uses actual RSA key identity and rejects ambiguous kid selection', () => {
    const db = new DatabaseSync(':memory:')
    const base = verification(db)
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'key' }
    const message = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u', iss: 'issuer', exp: now / 1000 + 60 })).toString('base64url')}`
    const credential = {
      kind: 'jwt' as const,
      token: `${message}.${sign('sha256', Buffer.from(message), pair.privateKey).toString('base64url')}`,
    }
    expect(
      verifyIdentityCredential(credential, evidence, { ...base, jwt: { issuer: 'issuer', keys: [key] } }).ok,
    ).toBe(true)
    expect(
      verifyIdentityCredential(credential, evidence, { ...base, jwt: { issuer: 'issuer', keys: [key, key] } })
        .ok,
    ).toBe(false)
    db.close()
  })
  it('keeps the original JCS canonical params and principal namespace', () => {
    const params = {
      value: '😀',
      _meta: { keep: { a: 1 }, 'ai.agnes.harness': { clientId: '', auth: { kind: 'local' }, keep: 'yes' } },
    }
    expect(identityInitializeDigest(params)).toBe(
      canonicalJsonDigest({
        value: '😀',
        _meta: { keep: { a: 1 }, 'ai.agnes.harness': { clientId: '', keep: 'yes' } },
      }),
    )
    expect(identityInitializeDigest({ ...params, value: 'changed' })).not.toBe(
      identityInitializeDigest(params),
    )
    expect(
      identityPrincipalKey({
        authKind: 'source-auth',
        credentialKind: 'channel',
        ownerClass: 'service',
        subject: 'caller',
        sourceKeyId: 'actual-key',
        expiresAt: now + 1000,
      }),
    ).toBe('source-auth:actual-key')
  })
})

describe('default identity factory and true current authorization consumer', () => {
  it('rejects an already issued context after the real token owner revokes its credential', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    const credential = { kind: 'session-cookie' as const, token: 'opaque-session-'.repeat(4) }
    f.sessions.install(credential.token, credential.kind, {
      principalKey: 'jwt:user',
      tenantRef: 'tenant',
      bindingId: f.binding.bindingId,
      scope,
      credentialRevision: 1,
      expiresAt: now + 60000,
      verified: {
        authKind: 'jwt',
        credentialKind: 'jwt',
        ownerClass: 'remote',
        subject: 'user',
        expiresAt: now + 60000,
      },
    })
    const provider = await f.factory.create(f.config, f.dependencies, {
      instanceId: 'instance',
      bindingId: f.binding.bindingId,
      scope: providerScope,
      signal,
    })
    await provider.ready(f.control)
    const input = f.ingress.http(
      f.connection,
      {
        credential,
        scope,
        tenantRef: 'tenant',
        evidence: {
          bindingId: f.binding.bindingId,
          ingressId: 'http-ingress',
          requestNonce: 'http-nonce',
          receivedAt: new Date(now).toISOString(),
          transport: 'http',
          method: 'POST',
          path: '/api/runtime/client/query',
          origin: null,
          authority: 'app.example',
          peerLoopback: false,
          tls: true,
          channelBinding: 'b'.repeat(64),
          proof: { kind: 'in-process', issuerBindingId: f.binding.bindingId },
        },
      },
      signal,
      deadline,
      'trace',
    )
    if (!input || !provider.ingress) throw new Error('missing ingress')
    expect((await provider.ingress(input.operation, input.context)).ok).toBe(true)
    const instance = f.authenticated[0]
    if (!instance) throw new Error('missing authentication')
    const call = f.authority.issue(instance.authorizationRef, {
      bindingId: f.binding.bindingId,
      scope,
      invocationId: 'call',
      traceRef: 'trace',
      deadline,
      signal,
    })
    if (!call) throw new Error('missing issued context')
    expect(f.authority.current(call)).not.toBeNull()
    f.sessions.revoke(credential.token)
    expect(f.authority.current(call)).toBeNull()
    await provider.close('shutdown')
    f.database.close()
  })
  it('rejects old authorization when the trusted keyring generation changes', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    const instance = await f.authority.accept({
      verified: {
        authKind: 'jwt',
        credentialKind: 'jwt',
        ownerClass: 'remote',
        subject: 'user',
        expiresAt: now + 60000,
      },
      principalRef: 'principal',
      tenantRef: 'tenant',
      bindingId: f.binding.bindingId,
      scope,
      signal,
      source: { kind: 'deployment', generation: 'fixture-keyring-v1', keyId: null },
    })
    if (!instance) throw new Error('missing identity')
    const call = f.authority.issue(instance.authorizationRef, {
      bindingId: f.binding.bindingId,
      scope,
      invocationId: 'call',
      traceRef: 'trace',
      deadline,
      signal,
    })
    if (!call) throw new Error('missing context')
    expect(f.authority.current(call)).not.toBeNull()
    f.setGeneration('fixture-keyring-v2')
    expect(f.authority.current(call)).toBeNull()
    f.database.close()
  })
  it('aborts a pending cache lookup and records no new identity after disposal', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    let complete: ((ports: IdentityVerificationPorts) => void) | undefined
    let observed: AbortSignal | undefined
    const factory = createIdentityProviderFactory({
      ...f.options,
      verification: (inputSignal) => {
        observed = inputSignal
        return new Promise((resolve) => {
          complete = resolve
        })
      },
    })
    const provider = await factory.create(f.config, f.dependencies, {
      instanceId: 'instance',
      bindingId: f.binding.bindingId,
      scope: providerScope,
      signal,
    })
    await provider.ready(f.control)
    const input = f.ingress.legacy(f.connection, {}, 'client', signal, deadline, 'trace')
    if (!input || !provider.ingress) throw new Error('missing ingress')
    const pending = provider.ingress(input.operation, input.context)
    expect(observed?.aborted).toBe(false)
    await provider.close('shutdown')
    expect(observed?.aborted).toBe(true)
    if (!complete) throw new Error('lookup was not reached')
    complete(verification(f.database))
    expect((await pending).ok).toBe(false)
    expect(f.authenticated).toHaveLength(0)
    expect(f.database.prepare('SELECT * FROM runtime_identity_instances').all()).toHaveLength(0)
    f.database.close()
  })
  it('does not fallback from a revoked session token to a cryptographically valid JWT', async () => {
    const f = fixture(new DatabaseSync(':memory:'), () => now)
    const credential = {
      kind: 'bearer' as const,
      token: token({ sub: 'http-user', iss: 'issuer', exp: now / 1000 + 60 }),
    }
    f.sessions.install(credential.token, 'bearer', {
      principalKey: 'jwt:http-user',
      tenantRef: 'tenant',
      bindingId: f.binding.bindingId,
      scope,
      expiresAt: now + 60000,
      credentialRevision: 1,
      verified: {
        authKind: 'jwt',
        credentialKind: 'jwt',
        ownerClass: 'remote',
        subject: 'http-user',
        expiresAt: now + 60000,
      },
    })
    expect(f.sessions.revoke(credential.token)).toBe(true)
    const signal = new AbortController().signal
    const provider = await f.factory.create(f.config, f.dependencies, {
      bindingId: f.binding.bindingId,
      instanceId: 'instance',
      scope: providerScope,
      signal,
    })
    await provider.ready(f.control)
    const input = f.ingress.http(
      f.connection,
      {
        credential,
        scope,
        tenantRef: 'tenant',
        evidence: {
          bindingId: f.binding.bindingId,
          ingressId: 'ingress-http',
          requestNonce: 'nonce-http',
          receivedAt: new Date(now).toISOString(),
          transport: 'http',
          method: 'POST',
          path: '/api/runtime/client/query',
          origin: 'https://app.example',
          authority: 'app.example',
          peerLoopback: false,
          tls: true,
          channelBinding: 'b'.repeat(64),
          proof: { kind: 'in-process', issuerBindingId: f.binding.bindingId },
        },
      },
      signal,
      deadline,
      'trace',
    )
    if (!input || !provider.ingress) throw new Error('missing HTTP ingress')
    expect((await provider.ingress(input.operation, input.context)).ok).toBe(false)
    expect(f.authenticated).toHaveLength(0)
    await provider.close('shutdown')
    f.database.close()
  })
  it('revalidates expiry and isolates local/remote authentication instances for one principal', async () => {
    let time = now
    const f = fixture(new DatabaseSync(':memory:'), () => time)
    const signal = new AbortController().signal
    const local = await f.authority.accept({
      verified: {
        authKind: 'local',
        credentialKind: 'local',
        ownerClass: 'local-owner',
        subject: 'owner',
        expiresAt: now + 1000,
      },
      principalRef: 'one-principal',
      tenantRef: 'tenant',
      bindingId: f.binding.bindingId,
      scope,
      signal,
      source: { kind: 'deployment', generation: 'fixture-keyring-v1', keyId: null },
    })
    const remote = await f.authority.accept({
      verified: {
        authKind: 'jwt',
        credentialKind: 'jwt',
        ownerClass: 'remote',
        subject: 'owner',
        expiresAt: now + 1000,
      },
      principalRef: 'one-principal',
      tenantRef: 'tenant',
      bindingId: f.binding.bindingId,
      scope,
      signal,
      source: { kind: 'deployment', generation: 'fixture-keyring-v1', keyId: null },
    })
    if (!local || !remote) throw new Error('identity instances not persisted')
    const call = f.authority.issue(remote.authorizationRef, {
      bindingId: f.binding.bindingId,
      scope,
      invocationId: 'invoke',
      traceRef: 'trace',
      deadline,
      signal,
    })
    if (!call) throw new Error('current context not issued')
    expect(f.authority.current(call)?.identity.ownerClass).toBe('remote')
    expect(local.authorizationRef).not.toBe(remote.authorizationRef)
    expect(
      f.authority.issue(remote.authorizationRef, {
        bindingId: f.binding.bindingId,
        scope: { kind: 'workspace', installationId: 'install', runtimeId: 'runtime', workspaceId: 'other' },
        invocationId: 'invoke',
        traceRef: 'trace',
        deadline,
        signal,
      }),
    ).toBeNull()
    time = now + 1000
    expect(f.authority.current(call)).toBeNull()
    f.database.close()
  })
  it('selects the real descriptor and consumes authenticate/resolve with exact generated refs', async () => {
    const f = fixture(new DatabaseSync(':memory:'), () => now)
    const signal = new AbortController().signal
    expect(validateRuntime('ProviderDescriptor', f.factory.descriptor).ok).toBe(true)
    const provider = await f.factory.create(f.config, f.dependencies, {
      instanceId: 'instance',
      scope: providerScope,
      bindingId: f.binding.bindingId,
      signal,
    })
    expect(await provider.ready(f.control)).toEqual({ ok: true, value: undefined })
    const auth = f.ingress.legacy(f.connection, {}, '', signal, deadline, 'trace')
    if (!auth || !provider.ingress || !provider.query) throw new Error('missing real ingress')
    const output = await provider.ingress(auth.operation, auth.context)
    expect(output.ok).toBe(true)
    if (!output.ok) throw new Error(output.error.message)
    const identity = decodeIdentityData(
      'AuthenticatedIdentity',
      RuntimeMethodSchemaRefs['agh.identity'].authenticate.output,
      output.value,
    )
    expect(identity?.ownerClass).toBe('local-owner')
    const instance = f.authenticated[0]
    if (!instance) throw new Error('no current instance')
    const context = f.authority.issue(instance.authorizationRef, {
      bindingId: f.binding.bindingId,
      scope,
      invocationId: 'invoke',
      traceRef: 'trace',
      deadline,
      signal,
    })
    if (!context) throw new Error('no actual issued context')
    const request = {
      target: f.binding,
      method: 'resolve',
      input: encodeIdentityData(
        'IdentityResolveRequest',
        RuntimeMethodSchemaRefs['agh.identity'].resolve.input,
        { principalRef: instance.identity.principalRef },
      ),
    }
    expect((await provider.query(request, context)).ok).toBe(true)
    expect((await provider.query(request, { ...context } as CallContext)).ok).toBe(false)
    f.setCross(true)
    expect((await provider.query(request, context)).ok).toBe(false)
    f.setCross(false)
    expect(f.authority.revoke(instance.authorizationRef)).toBe(true)
    expect((await provider.query(request, context)).ok).toBe(false)
    await provider.close('shutdown')
    f.database.close()
  })
  it('refuses fake contexts, swapped params, unknown connections and closed transport', async () => {
    const f = fixture(new DatabaseSync(':memory:'), () => now)
    const signal = new AbortController().signal
    const provider = await f.factory.create(f.config, f.dependencies, {
      instanceId: 'instance',
      scope: providerScope,
      bindingId: f.binding.bindingId,
      signal,
    })
    await provider.ready(f.control)
    expect(f.ingress.legacy({}, {}, 'client', signal, deadline, 'trace')).toBeNull()
    const auth = f.ingress.legacy(f.connection, {}, 'client', signal, deadline, 'trace')
    if (!auth || !provider.ingress) throw new Error('missing ingress')
    expect((await provider.ingress(auth.operation, { ...auth.context })).ok).toBe(false)
    expect((await provider.ingress({ ...auth.operation, method: 'other' }, auth.context)).ok).toBe(false)
    f.setLive(false)
    expect((await provider.ingress(auth.operation, auth.context)).ok).toBe(false)
    expect(f.authenticated).toHaveLength(0)
    f.database.close()
  })
  it('cancels before authentication and rejects disposal without deleting durable rows', async () => {
    const f = fixture(new DatabaseSync(':memory:'), () => now)
    const controller = new AbortController()
    const provider = await f.factory.create(f.config, f.dependencies, {
      instanceId: 'instance',
      scope: providerScope,
      bindingId: f.binding.bindingId,
      signal: controller.signal,
    })
    await provider.ready(f.control)
    const auth = f.ingress.legacy(f.connection, {}, 'client', controller.signal, deadline, 'trace')
    if (!auth || !provider.ingress) throw new Error('missing ingress')
    controller.abort()
    expect((await provider.ingress(auth.operation, auth.context)).ok).toBe(false)
    expect(f.authenticated).toHaveLength(0)
    await provider.close('cancelled')
    expect((await provider.ready(f.control)).ok).toBe(false)
    expect(f.database.prepare('SELECT * FROM runtime_identity_instances').all()).toHaveLength(0)
    f.database.close()
  })
})

describe('signed remote trusted ingress', () => {
  it('verifies the real issuer/channel, excludes signature cycles and persists replay admission', async () => {
    const db = new DatabaseSync(':memory:')
    const binding = {
      bindingId: 'identity-binding',
      contract: 'agh.identity',
      logicalName: 'identity',
      providerId: 'identity',
    }
    const connection = {}
    const signal = new AbortController().signal
    const credential = encodeIdentityData(
      'LegacyIdentityCredentialEnvelope',
      RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope,
      { kind: 'jwt', token: token({ sub: 'user', iss: 'issuer', exp: now / 1000 + 60 }) },
    )
    const signedEvidence = {
      ...evidence,
      proof: {
        kind: 'signed' as const,
        issuerBindingId: 'gateway',
        keyId: 'deployment-key',
        expiresAt: new Date(now + 30000).toISOString(),
        signature: 'pending',
      },
    }
    const context = {
      ingressId: evidence.ingressId,
      installationId: 'install',
      runtimeId: 'runtime',
      tenantRoute: 'tenant',
      transport: 'rpc' as const,
      transportEvidence: encodeIdentityData(
        'LegacyIdentityTransportEvidence',
        RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
        signedEvidence,
      ),
      receivedAt: evidence.receivedAt,
      deadline,
      traceRef: 'trace',
      signal,
    }
    const document = identityLegacySigningDocument(credential, signedEvidence, context)
    if (!document) throw new Error('no signing document')
    signedEvidence.proof.signature = createHmac('sha256', 'deployment-secret')
      .update(jcs(document))
      .digest('base64url')
    context.transportEvidence = encodeIdentityData(
      'LegacyIdentityTransportEvidence',
      RuntimeSchemaRefs.LegacyIdentityTransportEvidence,
      signedEvidence,
    )
    const request = { credentialEnvelope: credential, transportEvidence: context.transportEvidence }
    const operation = {
      target: binding,
      method: 'authenticate',
      input: encodeIdentityData(
        'IdentityAuthenticateRequest',
        RuntimeMethodSchemaRefs['agh.identity'].authenticate.input,
        request,
      ),
    }
    const authority = createIdentityIngressAuthority({
      now: () => now,
      binding,
      readLegacyConnection: () => null,
      verifyHttpConnection: () => false,
      remote: {
        connection: (source, call, facts) =>
          source === connection &&
          call.installationId === 'install' &&
          call.runtimeId === 'runtime' &&
          call.tenantRoute === 'tenant' &&
          facts.channelBinding === evidence.channelBinding
            ? { scope, tenantRef: 'tenant', allowLocalOwner: false }
            : null,
        verify: async (issuer, key, message, signature) =>
          issuer === 'gateway' &&
          key === 'deployment-key' &&
          signature === createHmac('sha256', 'deployment-secret').update(jcs(message)).digest('base64url'),
        consume: createIdentityIngressReplayOwner(db, () => now),
      },
    })
    expect(await authority.remote({}, operation, context)).toBeNull()
    expect(await authority.remote(connection, operation, { ...context, traceRef: 'tampered' })).toBeNull()
    expect(db.prepare('SELECT * FROM runtime_identity_ingress_replay').all()).toHaveLength(0)
    const accepted = await authority.remote(connection, operation, context)
    expect(accepted).not.toBeNull()
    if (!accepted) throw new Error('valid remote proof rejected')
    expect(authority.inspect(accepted.operation, accepted.context)).not.toBeNull()
    expect(authority.inspect(accepted.operation, { ...accepted.context })).toBeNull()
    expect(await authority.remote(connection, operation, context)).toBeNull()
    expect(identityLegacySigningDocument(credential, signedEvidence, context)).toEqual(document)
    db.close()
  })
})

describe('real nonce owner process boundaries', () => {
  it('admits only one of two independent processes sharing the durable owner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'identity-race-'))
    const path = join(directory, 'owner.sqlite')
    const initialize = new DatabaseSync(path)
    createIdentityNonceOwner(initialize)
    initialize.close()
    const script = `import {DatabaseSync} from 'node:sqlite';
      import {createIdentityNonceOwner} from ${JSON.stringify(new URL('../../src/runtime/identity/nonce.ts', import.meta.url).href)};
      const db=new DatabaseSync(${JSON.stringify(path)},{timeout:3000});
      const result=createIdentityNonceOwner(db).consumePair({clientId:'client',keyId:'key',nonce:'${nonce}',now:${now},expiresAt:${now + 60000}});
      process.stdout.write(JSON.stringify(result));db.close();`
    const run = () =>
      new Promise<boolean>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        let errors = ''
        child.stdout.on('data', (value: Buffer) => {
          output += value.toString()
        })
        child.stderr.on('data', (value: Buffer) => {
          errors += value.toString()
        })
        child.once('error', reject)
        child.once('exit', (code) => {
          if (code === 0) resolve(JSON.parse(output))
          else reject(new Error(errors))
        })
      })
    try {
      expect((await Promise.all([run(), run()])).sort()).toEqual([false, true])
      const reopened = new DatabaseSync(path)
      expect(reopened.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(2)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rolls back a process killed between the two namespace inserts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'identity-kill-'))
    const databasePath = join(directory, 'owner.sqlite')
    try {
      const script = `import {DatabaseSync} from 'node:sqlite';
        import {createIdentityNonceOwner} from ${JSON.stringify(new URL('../../src/runtime/identity/nonce.ts', import.meta.url).href)};
        const db=new DatabaseSync(${JSON.stringify(databasePath)}); const owner=createIdentityNonceOwner(db);
        db.function('pause_write',()=>{process.stdout.write('second-insert');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);return 0});
        db.exec("CREATE TRIGGER crash_point BEFORE INSERT ON auth_nonces WHEN NEW.client_id LIKE 'source-key:%' BEGIN SELECT pause_write(); END");
        owner.consumePair({clientId:'client',keyId:'key',nonce:'${nonce}',now:${now},expiresAt:${now + 60000}});`
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          process.kill('SIGKILL')
          reject(new Error('child never reached actual second insert'))
        }, 3000)
        process.stdout.once('data', () => {
          clearTimeout(timeout)
          process.kill('SIGKILL')
          resolve()
        })
        process.once('error', reject)
        process.once('exit', (code, signal) => {
          if (code !== null && signal !== 'SIGKILL') {
            clearTimeout(timeout)
            reject(new Error(`child exited ${code}`))
          }
        })
      })
      await new Promise<void>((resolve) => {
        if (process.signalCode) resolve()
        else process.once('exit', () => resolve())
      })
      const reopened = new DatabaseSync(databasePath)
      expect(reopened.prepare('SELECT * FROM auth_nonces').all()).toHaveLength(0)
      reopened.exec('DROP TRIGGER crash_point')
      expect(
        createIdentityNonceOwner(reopened).consumePair({
          clientId: 'client',
          keyId: 'key',
          nonce,
          now,
          expiresAt: now + 60000,
        }),
      ).toBe(true)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
