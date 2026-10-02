import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { lookup } from 'node:dns/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { createReferenceNetwork } from '../../../../examples/runtime-reference/src/providers/network.js'
import { createReferenceSecrets } from '../../../../examples/runtime-reference/src/providers/secrets.js'
import type {
  ActionContext,
  CallContext,
  Outcome,
  TrustedIngressContext,
} from '../../../extension-api/src/runtime/index.js'
import type * as W from '../../../protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../protocol/src/runtime/index.js'
import {
  createNetworkService,
  type NetworkOptions,
  type NetworkService,
} from '../../src/runtime/providers/network.js'
import {
  createSecretsService,
  type SecretsOptions,
  type SecretsService,
} from '../../src/runtime/providers/secrets.js'
import { createHostScopedDependencies } from '../../src/runtime/scoped-dependencies.js'

export type Kind = 'default' | 'reference'
export function must<T>(value: Outcome<T>): T {
  assert.equal(value.ok, true, value.ok ? '' : value.error.detailCode)
  if (!value.ok) throw new Error('Operation refused')
  return value.value
}
export function error(value: Outcome<unknown>): string {
  return value.ok ? 'ok' : `${value.error.code}/${value.error.detailCode}`
}
export function inline(value: W.JsonValue, typeId = 'fixture/value@1'): W.DataRef {
  const digest = canonicalJsonDigest(value)
  return {
    kind: 'inline',
    value,
    digest,
    bytes: Buffer.byteLength(JSON.stringify(value)),
    schema: { typeId, digest, revision: 1 },
  }
}
export const scope: W.ScopeRef = {
  kind: 'workspace',
  installationId: 'install',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
}
export const consumer: W.SecretConsumerBinding = {
  consumer: 'mcp',
  secretId: 'credential',
  accountRef: 'account',
  serverRef: 'server',
  audience: 'fixture-peer',
  purpose: 'mcp-oauth',
}
export const resolveInput: W.SecretsResolveRequest = {
  secretId: consumer.secretId,
  audience: consumer.audience,
  purpose: consumer.purpose,
}
export const refreshInput: W.CredentialRefreshRequest = {
  ...resolveInput,
  requestId: 'renewal',
  expectedVersion: 'v1',
  accountRef: 'account',
  serverRef: 'server',
  purpose: 'mcp-oauth',
}

/** Restricted-effects fixture: issuance is local and associated with the exact object. */
export function boundary() {
  const issued = new WeakSet<object>()
  const administrators = new WeakSet<object>()
  const ingress = new WeakSet<object>()
  let revoked = false
  let tenant = 'tenant'
  function call(patch: Partial<CallContext> = {}, maintenance = false): CallContext {
    const value = Object.freeze({
      principalRef: 'actor',
      scope,
      bindingId: 'consumer-binding',
      invocationId: randomUUID(),
      deadline: new Date(Date.now() + 10000).toISOString(),
      traceRef: 'trace',
      authorizationRef: 'authorization',
      signal: new AbortController().signal,
      ...patch,
    })
    issued.add(value)
    if (maintenance) administrators.add(value)
    return value
  }
  return {
    call,
    maintenance: (context: CallContext) => administrators.has(context),
    revoke: () => {
      revoked = true
    },
    tenant: (value: string) => {
      tenant = value
    },
    identity: {
      async resolve(
        request: W.IdentityResolveRequest,
        context: CallContext,
      ): Promise<Outcome<W.AuthenticatedIdentity>> {
        if (!issued.has(context) || revoked || request.principalRef !== context.principalRef)
          return {
            ok: false,
            error: {
              code: 'denied',
              detailCode: 'fixture_identity',
              message: 'Identity refused',
              diagnosticId: 'fixture',
              retryAdvice: { kind: 'never' },
            },
          }
        return {
          ok: true,
          value: {
            principalRef: context.principalRef,
            tenantRef: tenant,
            claims: inline({}),
            authRevision: 1,
            expiresAt: '2099-01-01T00:00:00.000Z',
            authKind: 'local',
            credentialKind: 'local',
            ownerClass: 'local-owner',
          },
        }
      },
    },
    trustedIngress(context: TrustedIngressContext) {
      return ingress.has(context)
    },
    ingress(): TrustedIngressContext {
      const value: TrustedIngressContext = Object.freeze({
        ingressId: 'callback-ingress',
        installationId: 'install',
        runtimeId: 'runtime',
        tenantRoute: 'tenant',
        transport: 'http',
        transportEvidence: inline({ bound: true }),
        receivedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 10000).toISOString(),
        traceRef: 'callback-trace',
        signal: new AbortController().signal,
      })
      ingress.add(value)
      return value
    },
  }
}
export function action(call: CallContext): ActionContext {
  const refuse = async (): Promise<Outcome<never>> => ({
    ok: false,
    error: {
      code: 'denied',
      detailCode: 'fixture_effect',
      message: 'Effect refused',
      diagnosticId: 'fixture',
      retryAdvice: { kind: 'never' },
    },
  })
  return { call, effects: { invoke: refuse, stream: refuse, upload: refuse }, progress: refuse }
}
export function scratch() {
  const parent = mkdtempSync(join(tmpdir(), 'runtime-platform-'))
  const directory = join(parent, 'private')
  createPrivateDirectorySync(directory)
  return directory
}

export function content(directory: string): NetworkOptions['content'] {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    async retain(bytes) {
      const digest = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(directory, digest), bytes, { mode: 0o600 })
      return {
        authorityId: 'fixture-content',
        blobId: digest,
        digest,
        bytes: bytes.byteLength,
        mediaType: 'application/octet-stream',
        pinId: `fixture-pin-${digest}`,
      }
    },
    async read(ref) {
      assert.equal(ref.authorityId, 'fixture-content')
      assert.match(ref.blobId, /^[a-f0-9]{64}$/)
      return readFileSync(join(directory, ref.blobId))
    },
  }
}
export function network(
  kind: Kind,
  directory: string,
  auth: ReturnType<typeof boundary>,
  rules: NetworkOptions['rules'],
  patch: Partial<NetworkOptions> = {},
): NetworkService {
  const options: NetworkOptions = {
    directory,
    rules,
    tenantId: 'tenant',
    identity: auth.identity,
    authorize: (_target, call) =>
      call.scope.kind === 'workspace' && canonicalJsonDigest(call.scope) === canonicalJsonDigest(scope),
    content: content(join(directory, 'content')),
    ...patch,
  }
  return kind === 'default' ? createNetworkService(options) : createReferenceNetwork(options)
}
export function secrets(
  kind: Kind,
  directory: string,
  auth: ReturnType<typeof boundary>,
  patch: Partial<SecretsOptions> = {},
): SecretsService {
  const options: SecretsOptions = {
    directory,
    tenantId: 'tenant',
    identity: auth.identity,
    maintenance: auth.maintenance,
    entries: [
      {
        secretId: 'credential',
        versions: [
          { version: 'v1', ref: 'secret://fixture/old' },
          { version: 'v2', ref: 'secret://fixture/new' },
        ],
      },
    ],
    grants: [{ principalRef: 'actor', scope, binding: consumer }],
    source: { resolve: (ref) => (ref === 'secret://fixture/old' ? 'not-real' : 'rotated') },
    ...patch,
  }
  return kind === 'default' ? createSecretsService(options) : createReferenceSecrets(options)
}
export function request(
  port: number,
  path = '/normal',
  patch: Partial<W.NetworkRequest> = {},
): W.NetworkRequest {
  return {
    target: { targetId: 'peer', scheme: 'http', host: 'localhost', port, path },
    method: 'GET',
    headers: inline({}, 'agh.network/request-headers@1'),
    bodyRef: null,
    redirect: { mode: 'revalidate', maxHops: 3 },
    maxBytes: 1024,
    ...patch,
  }
}
export function rule(
  port: number,
  patch: Partial<NetworkOptions['rules'][number]> = {},
): NetworkOptions['rules'][number] {
  return {
    targetId: 'peer',
    scheme: 'http',
    host: 'localhost',
    port,
    effect: 'allow',
    addresses: ['127.0.0.1'],
    ...patch,
  }
}
export const loopback = (async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof lookup

/** A fixed local HTTP peer, never an Internet endpoint. */
export async function peer() {
  let connections = 0
  let requests = 0
  const observed: { path: string; authorization: string | undefined; cookie: string | undefined }[] = []
  const server = createServer((input, response) => {
    requests += 1
    observed.push({
      path: input.url ?? '',
      authorization: input.headers.authorization,
      cookie: input.headers.cookie,
    })
    if (input.url === '/slow') return
    if (input.url === '/redirect') {
      response.writeHead(302, { location: '/normal' })
      response.end()
      return
    }
    if (input.url === '/private') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/normal` })
      response.end()
      return
    }
    if (input.url === '/oversize') {
      response.end('x'.repeat(2048))
      return
    }
    response.setHeader('content-type', 'text/plain')
    response.end('peer-result')
  })
  let active = 0
  server.on('connection', (socket) => {
    connections += 1
    active += 1
    socket.once('close', () => {
      active -= 1
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  return {
    port,
    connections: () => connections,
    active: () => active,
    requests: () => requests,
    observed: () => observed,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((failure) => (failure ? reject(failure) : resolve())),
      )
    },
  }
}

export async function selected(
  service: NetworkService | SecretsService,
  packageDigest = service.providerDigest,
) {
  const host = createHostScopedDependencies([])
  const view = await host.publish({
    generationId: 'selection',
    providers: [
      {
        binding: service.binding,
        major: 1,
        scope: 'workspace',
        features: service.features,
        packageDigest,
        ownerId: service.binding.providerId,
        permissions: [],
        close: () => service.close(),
      },
    ],
  })
  assert.equal(view.bindings[0]?.providerId, service.binding.providerId)
  assert.equal(view.bindings[0]?.packageDigest, packageDigest)
  assert.deepEqual(
    must(
      host.dependencies.get({
        contract: service.binding.contract,
        major: 1,
        logicalName: service.binding.logicalName,
        scope: 'workspace',
        features: [service.features[0] ?? 'absent-capability'],
        optional: false,
      }),
    ).binding,
    service.binding,
  )
  assert.equal(
    error(
      host.dependencies.get({
        contract: service.binding.contract,
        major: 1,
        logicalName: service.binding.logicalName,
        scope: 'workspace',
        features: ['absent-capability'],
        optional: false,
      }),
    ),
    'incompatible/feature_missing',
  )
  await host.close('selection')
}

/** Scan diagnostics and all broker persistence, including WAL pages. No snapshots contain material. */
export function scan(directory: string, values: readonly string[], diagnostics: readonly unknown[]) {
  const buffers = [Buffer.from(JSON.stringify(diagnostics))]
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) visit(file)
      else buffers.push(readFileSync(file))
    }
  }
  visit(directory)
  for (const value of values)
    for (const bytes of buffers)
      assert.equal(bytes.includes(Buffer.from(value)), false, 'Secret material escaped the broker boundary')
}
export function cleanup(directory: string) {
  const parent = dirname(directory)
  if (basename(directory) !== 'private' || !basename(parent).startsWith('runtime-platform-'))
    throw new Error('Unknown fixture directory')
  rmSync(parent, { recursive: true, force: true })
}
