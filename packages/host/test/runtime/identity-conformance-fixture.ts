import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
  type ScopeRef,
} from '@agnes/protocol/runtime'
import { createReferenceIdentityAuthority } from '../../../../examples/runtime-reference/src/providers/identity/authority.js'
import { createReferenceIdentitySessions } from '../../../../examples/runtime-reference/src/providers/identity/http-sessions.js'
import { createReferenceIdentityProviderFactory } from '../../../../examples/runtime-reference/src/providers/identity.js'
import type {
  IdentityContractFixture,
  IdentityCredentialCase,
} from '../../../extension-api/testkit/runtime/contracts/identity.js'
import {
  type CurrentIdentity,
  createIdentityAuthority,
  type IdentityClaimsBinding,
  type IdentityClaimsOwner,
} from '../../src/runtime/identity/authority.js'
import { decodeIdentityData } from '../../src/runtime/identity/data.js'
import { createIdentityHttpSessions } from '../../src/runtime/identity/http-sessions.js'
import {
  createIdentityIngressAuthority,
  type IdentityConnectionFacts,
  identityInitializeDigest,
} from '../../src/runtime/identity/legacy-ingress.js'
import { createIdentityNonceOwner } from '../../src/runtime/identity/nonce.js'
import type { IdentityCredentialSource } from '../../src/runtime/identity/source.js'
import type { IdentityVerificationPorts } from '../../src/runtime/identity/verify.js'
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
function fixture(
  database = new DatabaseSync(':memory:'),
  clock = () => now,
  implementation: 'default' | 'reference' = 'default',
) {
  const binding = {
    bindingId: 'identity-binding',
    contract: 'agh.identity',
    logicalName: 'identity',
    providerId: implementation === 'default' ? 'default-identity' : 'reference-identity',
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
  const sessions =
    implementation === 'default'
      ? createIdentityHttpSessions(database, { now: clock, current: () => live, currentBinding: () => live })
      : createReferenceIdentitySessions(database, {
          now: clock,
          current: () => live,
          currentBinding: () => live,
        })
  const sourceCurrent = (source: IdentityCredentialSource) =>
    source.kind === 'deployment'
      ? source.generation === generation
      : sessions.current(source.ownerRef, source.revision)
  const authority =
    implementation === 'default'
      ? createIdentityAuthority(database, claimsOwner(database), clock, authorize, sourceCurrent)
      : createReferenceIdentityAuthority(database, {
          now: clock,
          claims: claimsOwner(database),
          authorize,
          sourceCurrent,
        })
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
  let associationHook: (() => void) | undefined
  const options = {
    config,
    packageVersion: '1.0.0',
    packageDigest: canonicalJsonDigest(
      readFileSync(
        fileURLToPath(
          new URL(
            implementation === 'default'
              ? '../../src/runtime/providers/identity.ts'
              : '../../../../examples/runtime-reference/src/providers/identity.ts',
            import.meta.url,
          ),
        ),
        'utf8',
      ),
    ),
    binding,
    ingress,
    authority,
    sessions,
    verification: async () => ({ ...verification(database, clock), generation }),
    principal: async (key: string) => `principal-${canonicalJsonDigest(key)}`,
    control: (input: CallContext) => calls.has(input),
    authenticated: (_context: unknown, instance: CurrentIdentity) => {
      authenticated.push(instance)
      associationHook?.()
    },
    now: clock,
  }
  const factory =
    implementation === 'default'
      ? createIdentityProviderFactory(options)
      : createReferenceIdentityProviderFactory({
          ...options,
          database,
          verification: async () => ({ ...verificationSettings(clock), generation }),
        })
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
    setAssociationHook: (hook: () => void) => {
      associationHook = hook
    },
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

export async function tckFixture(
  implementation: 'default' | 'reference',
  path: string,
  state: { credential?: ReturnType<typeof source> } = {},
): Promise<IdentityContractFixture> {
  const f = fixture(new DatabaseSync(path), () => now, implementation)
  const signal = new AbortController().signal
  let closed = false
  return {
    factory: f.factory,
    config: f.config,
    dependencies: f.dependencies,
    context: { instanceId: 'tck-instance', bindingId: f.binding.bindingId, scope: providerScope, signal },
    administrativeContext: f.control,
    releaseSetDigest: canonicalJsonDigest({
      provider: f.factory.descriptor.packageDigest,
      binding: f.binding,
    }),
    async ingress(kind: IdentityCredentialCase, inputSignal, replay) {
      if (kind === 'bearer' || kind === 'session-cookie' || kind === 'module-session') {
        const secret = randomUUID() + randomUUID()
        const verified = {
          authKind: 'jwt' as const,
          credentialKind: 'jwt' as const,
          ownerClass: 'remote' as const,
          subject: 'http-user',
          expiresAt: now + 60000,
        }
        const module = {
          principalRef: `principal-${canonicalJsonDigest('jwt:http-user')}`,
          tenantRef: 'tenant',
          authRevision: 1,
          credentialRevision: 1,
          negotiatedSession: 'session',
          clientInstanceId: 'client-instance',
          moduleId: 'module',
          packageDigest: 'a'.repeat(64),
          assetDigest: 'b'.repeat(64),
          moduleGeneration: 1,
          ownerRef: { kind: 'run' as const, id: 'run' },
          catalogRevision: 1,
          expiresAt: new Date(now + 60000).toISOString(),
          channelBinding: 'b'.repeat(64),
          operations: ['query'],
          allowedActions: [],
          moduleReady: true as const,
        }
        f.sessions.install(secret, kind, {
          principalKey: 'jwt:http-user',
          tenantRef: 'tenant',
          bindingId: f.binding.bindingId,
          scope,
          expiresAt: now + 60000,
          credentialRevision: 1,
          verified,
          ...(kind === 'module-session' ? { module } : {}),
        })
        const pair = f.ingress.http(
          f.connection,
          {
            credential: { kind, token: secret },
            evidence: {
              bindingId: f.binding.bindingId,
              ingressId: randomUUID(),
              requestNonce: randomUUID(),
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
            scope,
            tenantRef: 'tenant',
          },
          inputSignal,
          deadline,
          'trace',
        )
        if (!pair) throw new Error('no real HTTP ingress')
        return pair
      }
      const payload = Buffer.from(
        JSON.stringify({ sub: 'user', exp: now / 1000 + 60, attrs: { team: 'safe' } }),
      )
      const portal = `${payload.toString('base64url')}.${createHmac('sha256', 'portal-secret').update(payload).digest('hex')}`
      let auth: unknown =
        kind === 'local'
          ? { kind: 'local' }
          : kind === 'jwt'
            ? { kind, token: token({ sub: 'user', iss: 'issuer', exp: now / 1000 + 60 }) }
            : kind === 'portal-identity'
              ? { kind, token: portal }
              : { kind: 'source-auth' }
      const params = {
        _meta: { 'ai.agnes.harness': { clientId: 'client', auth } },
        options: { preserved: true },
      }
      if (kind === 'source-auth' || kind === 'surface') {
        if (replay && state.credential) auth = state.credential
        else {
          const freshNonce = randomUUID().replaceAll('-', '')
          const timestamp = now / 1000
          const digest = identityInitializeDigest(params)
          auth = {
            kind: 'source-auth',
            timestamp,
            nonce: freshNonce,
            signature: `v0=${createHmac('sha256', 'source-secret')
              .update(`v0:${timestamp}:${freshNonce}:initialize
client
${digest}`)
              .digest('hex')}`,
          }
          if (kind === 'source-auth') state.credential = auth as ReturnType<typeof source>
        }
        if (kind === 'surface')
          auth = {
            kind,
            sourceId: 'surface-1',
            source: auth,
            subject: { kind: 'portal-identity', token: portal },
          }
        params._meta['ai.agnes.harness'].auth = auth
      }
      const pair = f.ingress.legacy(f.connection, params, 'client', inputSignal, deadline, 'trace')
      if (!pair) throw new Error('no real legacy ingress')
      return pair
    },
    async current(ref, inputSignal) {
      const identity = decodeIdentityData(
        'AuthenticatedIdentity',
        RuntimeMethodSchemaRefs['agh.identity'].authenticate.output,
        ref,
      )
      const instance = f.authenticated.find(
        (entry) =>
          entry.identity.principalRef === identity?.principalRef && jcs(entry.identity) === jcs(identity),
      )
      if (!instance) throw new Error('no matching authentication instance')
      const context = f.authority.issue(instance.authorizationRef, {
        bindingId: f.binding.bindingId,
        scope,
        invocationId: randomUUID(),
        traceRef: 'trace',
        deadline,
        signal: inputSignal,
      })
      if (!context) throw new Error('current context rejected')
      return context
    },
    async revoke(context) {
      f.authority.revoke(context.authorizationRef)
    },
    async coldRestart() {
      f.database.close()
      closed = true
      return tckFixture(implementation, path, state)
    },
    async dispose() {
      if (!closed) {
        f.database.close()
        closed = true
      }
    },
  }
}
