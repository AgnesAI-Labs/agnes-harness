import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActionContext, CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import type { McpLeases } from '../../src/runtime/mcp-leases.js'
import { mcpData } from '../../src/runtime/mcp-types.js'
import { createMcpService, type McpDependencies, type McpService } from '../../src/runtime/providers/mcp.js'

export type Kind = 'default' | 'reference'
export type Transport = 'stdio' | 'streamable-http'
export function must<T>(outcome: Outcome<T>): T {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.error.code}/${outcome.error.detailCode}`)
  if (!outcome.ok) throw new Error('Fixture operation refused')
  return outcome.value
}
export function error(outcome: Outcome<unknown>) {
  return outcome.ok ? 'ok' : `${outcome.error.code}/${outcome.error.detailCode}`
}
export function item<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error('Missing fixture item')
  return value
}
export const scope: W.ScopeRef = {
  kind: 'workspace',
  installationId: 'install',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
}
export const callSchema: W.SchemaRef = {
  typeId: 'fixture/mcp-call@1',
  revision: 1,
  digest: canonicalJsonDigest({ method: 'tools/call' }),
}
export const readSchema: W.SchemaRef = {
  typeId: 'fixture/mcp-read@1',
  revision: 1,
  digest: canonicalJsonDigest({ method: 'resources/read' }),
}
export function scratch() {
  return mkdtempSync(join(tmpdir(), 'agnes-mcp-'))
}
export function remove(root: string) {
  rmSync(root, { recursive: true, force: true })
}
export function boundary() {
  const issued = new WeakSet<object>()
  let allowed = true
  let toolAllowed = true
  const call = (patch: Partial<CallContext> = {}): CallContext => {
    const context = Object.freeze({
      scope,
      principalRef: 'actor',
      bindingId: 'mcp-consumer',
      invocationId: randomUUID(),
      authorizationRef: 'authorization',
      traceRef: 'trace',
      deadline: new Date(Date.now() + 10000).toISOString(),
      signal: new AbortController().signal,
      ...patch,
    })
    issued.add(context)
    return context
  }
  return {
    call,
    revoke: () => {
      allowed = false
    },
    tools: (value: boolean) => {
      toolAllowed = value
    },
    toolsAdmission: () => toolAllowed,
    identity: {
      async resolve(
        input: W.IdentityResolveRequest,
        context: CallContext,
      ): Promise<Outcome<W.AuthenticatedIdentity>> {
        if (!issued.has(context) || !allowed || input.principalRef !== context.principalRef)
          return {
            ok: false,
            error: {
              code: 'denied',
              detailCode: 'fixture_identity',
              message: 'Fixture refused',
              diagnosticId: 'fixture',
              retryAdvice: { kind: 'never' },
            },
          }
        return {
          ok: true,
          value: {
            principalRef: context.principalRef,
            tenantRef: 'tenant',
            claims: mcpData({}, 'fixture/claims@1'),
            authRevision: 1,
            expiresAt: '2099-01-01T00:00:00.000Z',
            authKind: 'local',
            credentialKind: 'local',
            ownerClass: 'local-owner',
          },
        }
      },
    },
  }
}
export async function fixture(
  kind: Kind,
  transport: Transport,
  root: string,
  port?: number,
  patch: Partial<McpDependencies> = {},
  leases?: McpLeases,
  peerMode?: string,
) {
  const auth = boundary()
  const networkModule = await import(
    new URL('../../../host/src/runtime/providers/network.ts', import.meta.url).href
  )
  const secretModule = await import(
    new URL('../../../host/src/runtime/providers/secrets.ts', import.meta.url).href
  )
  const storage = join(root, 'content')
  mkdirSync(storage, { recursive: true, mode: 0o700 })
  const content: McpDependencies['content'] = {
    async retain(bytes) {
      const digest = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(storage, digest), bytes, { mode: 0o600 })
      return {
        authorityId: 'fixture-content',
        blobId: digest,
        digest,
        bytes: bytes.length,
        mediaType: 'application/json',
        pinId: `pin-${digest}`,
      }
    },
    async read(ref) {
      assert.equal(ref.authorityId, 'fixture-content')
      assert.match(ref.blobId, /^[a-f0-9]{64}$/)
      const bytes = readFileSync(join(storage, ref.blobId))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.digest)
      return bytes
    },
  }
  const serverRef: W.ResourceRef = {
    resourceId: 'server',
    version: '1',
    digest: canonicalJsonDigest({ transport, revision: 1 }),
  }
  const consumer: W.SecretConsumerBinding = {
    consumer: 'mcp',
    secretId: 'credential',
    accountRef: 'account',
    serverRef: 'server',
    audience: 'fixture-peer',
    purpose: 'mcp-oauth',
  }
  const secret = secretModule.createSecretsService({
    directory: join(root, 'secrets'),
    tenantId: 'tenant',
    identity: auth.identity,
    maintenance: () => false,
    entries: [
      {
        secretId: consumer.secretId,
        versions: [
          { version: 'v1', ref: 'secret://fixture/old' },
          { version: 'v2', ref: 'secret://fixture/new' },
        ],
      },
    ],
    grants: [{ principalRef: 'actor', scope, binding: consumer }],
    source: { resolve: (ref: string) => ['fixture', ref.endsWith('/old') ? 'old' : 'new'].join('-') },
    handleMs: 300000,
    refresh: async () => ({ state: 'ready', newVersionRef: 'secret://fixture/new' }),
  })
  const outbound = networkModule.createNetworkService({
    directory: join(root, 'network'),
    identity: auth.identity,
    tenantId: 'tenant',
    content,
    authorize: (_target: W.NetworkTarget, context: CallContext) =>
      canonicalJsonDigest(context.scope) === canonicalJsonDigest(scope),
    rules: port
      ? [
          {
            targetId: 'peer',
            scheme: 'http',
            host: '127.0.0.1',
            port,
            effect: 'allow',
            addresses: ['127.0.0.1'],
          },
        ]
      : [],
    timeoutMs: 1500,
  })
  const selectedNetwork: McpDependencies['network'] = {
    request(input, context, signal = context.signal) {
      // The selected companion owns authenticated child contexts; the MCP provider cannot self-sign one.
      return outbound.request(
        input,
        auth.call({
          principalRef: context.principalRef,
          scope: context.scope,
          signal,
          deadline: context.deadline,
          invocationId: randomUUID(),
        }),
      )
    },
  }
  const options: McpDependencies = {
    directory: join(root, `provider-${kind}`),
    tenantId: 'tenant',
    scope,
    ownerId: 'generation-1',
    endpoints: [
      {
        resource: serverRef,
        transport,
        credential: transport === 'stdio' ? null : consumer,
        ...(transport === 'stdio'
          ? {
              executable: process.execPath,
              args: [
                fileURLToPath(new URL('./fixtures/mcp-stdio.mjs', import.meta.url)),
                join(root, 'stdio-calls.ndjson'),
                ...(peerMode ? [peerMode] : []),
              ],
            }
          : {
              target: { targetId: 'peer', scheme: 'http', host: '127.0.0.1', port: port ?? 0, path: '/mcp' },
              staticClientId: 'fixture-client',
            }),
        methods: { 'tools/call': callSchema, 'resources/read': readSchema },
      },
    ],
    allowedExecutables: [process.execPath],
    authorize: () => true,
    toolsAdmission: auth.toolsAdmission,
    identity: auth.identity,
    secrets: secret,
    network: selectedNetwork,
    content,
    attempt: (call) => ({
      run: {
        session: {
          sessionId: 'session',
          authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
        },
        runId: 'run',
      },
      actionId: call.invocationId,
      attemptId: `attempt-${call.invocationId}`,
    }),
    timeoutMs: 1500,
    ...patch,
  }
  let service: McpService
  try {
    service =
      kind === 'default'
        ? createMcpService(options, leases)
        : (
            await import(
              new URL('../../../../examples/runtime-reference/src/providers/mcp.ts', import.meta.url).href
            )
          ).createReferenceMcp(options)
  } catch (reason) {
    await outbound.close()
    await secret.close()
    throw reason
  }
  function action(call = auth.call()): ActionContext {
    const refuse = async (): Promise<Outcome<never>> => ({
      ok: false,
      error: {
        code: 'denied',
        detailCode: 'fixture_effect',
        message: 'Refused',
        diagnosticId: 'fixture',
        retryAdvice: { kind: 'never' },
      },
    })
    return {
      call,
      effects: {
        async invoke(request) {
          assert.equal(request.operation, 'agh.secrets.refresh')
          assert.equal(request.input.kind, 'inline')
          if (request.input.kind !== 'inline') return refuse()
          const result = await secret.refresh(request.input.value, {
            call: auth.call({
              invocationId: `refresh-${String((request.input.value as W.CredentialRefreshRequest).requestId)}`,
            }),
            effects: { invoke: refuse, stream: refuse, upload: refuse },
            progress: refuse,
          })
          if (!result.ok) return result
          const value = mcpData(result.value, 'agh.secrets/refresh.response@1')
          value.schema = RuntimeMethodSchemaRefs['agh.secrets'].refresh.output
          return { ok: true, value }
        },
        stream: refuse,
        upload: refuse,
      },
      progress: refuse,
    }
  }
  const request: W.McpConnectRequest = { serverRef, transport, credentialRef: null }
  return {
    service,
    auth,
    options,
    action,
    request,
    async connect(call = auth.call()) {
      const prepared = must(await service.prepareConnection({ request, credentialRefresh: null }, action()))
      const result = must(await service.connect(prepared, call))
      assert.equal(validateRuntime('McpConnectResult', result).ok, true)
      return { result, prepared }
    },
    async close() {
      await service.close()
      await outbound.close()
      await secret.close()
    },
  }
}
export function invocation(
  ref: W.DomainObjectRef,
  name = 'echo',
  value: W.JsonValue = 'hello',
): W.McpCallRequest {
  const data = mcpData({ name, arguments: { value } }, callSchema.typeId)
  data.schema = callSchema
  return { connectionRef: ref, method: 'tools/call', methodSchema: callSchema, params: data }
}
export function state(value: W.McpCallResult): { pid: number; value: W.JsonValue; environment?: string[] } {
  const data = value.contentRefs[0]
  assert.ok(data?.kind === 'inline')
  const parsed = data.value as { content: { text: string }[] }
  const result = JSON.parse(parsed.content[0]?.text ?? '')
  assert.equal(typeof result.pid, 'number')
  return result
}
export async function selected(service: McpService, digest = service.providerDigest) {
  const module = await import(
    new URL('../../../host/src/runtime/scoped-dependencies.ts', import.meta.url).href
  )
  const host = module.createHostScopedDependencies([])
  try {
    const view = await host.publish({
      generationId: 'mcp-selection',
      providers: [
        {
          binding: service.binding,
          major: 1,
          scope: 'workspace',
          features: service.features,
          packageDigest: digest,
          ownerId: service.binding.providerId,
          permissions: [],
          close: () => service.close(),
        },
      ],
    })
    assert.equal(view.bindings[0].packageDigest, digest)
    const requirement: W.ServiceRequirement = {
      contract: 'agh.mcp',
      major: 1,
      logicalName: 'mcp',
      scope: 'workspace',
      features: ['connect'],
      optional: false,
    }
    const selection = host.dependencies.get(requirement)
    assert.equal(selection.ok, true)
    if (selection.ok) assert.deepEqual(selection.value.binding, service.binding)
    assert.equal(
      error(host.dependencies.get({ ...requirement, features: ['stateful-http'] })),
      'incompatible/feature_missing',
    )
  } finally {
    await host.close('mcp-selection')
  }
}
export async function httpPeer() {
  const child = fork(fileURLToPath(new URL('./fixtures/mcp-http-runner.mjs', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr?.on('data', () => {})
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (data: { port: number }) => resolve(data.port))
    child.once('exit', () => reject(new Error('HTTP fixture exited')))
  })
  const command = (op: string) =>
    new Promise<{ method: string; name: string | null }[]>((resolve) => {
      const id = randomUUID()
      const listener = (reply: { id: string; calls: { method: string; name: string | null }[] }) => {
        if (reply.id === id) {
          child.off('message', listener)
          resolve(reply.calls)
        }
      }
      child.on('message', listener)
      child.send({ id, op })
    })
  return {
    port,
    calls: () => command('calls'),
    rotate: () => command('rotate'),
    close: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.disconnect()
      }),
  }
}
export function scan(root: string, receipts: unknown[]) {
  const files: Buffer[] = [Buffer.from(JSON.stringify(receipts))]
  for (const provider of readdirSync(root).filter((name) => name.startsWith('provider-')))
    for (const name of readdirSync(join(root, provider))) files.push(readFileSync(join(root, provider, name)))
  for (const suffix of ['old', 'new']) {
    const material = ['fixture', suffix].join('-')
    for (const bytes of files) assert.equal(bytes.includes(Buffer.from(material)), false)
  }
}
