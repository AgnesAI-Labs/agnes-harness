import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createDefaultModelFactory,
  createPreparedRegistry,
  type DefaultLoopSource,
  type ModelDeployment,
} from '@agnes/core'
import type { CallContext, LoopReadPorts } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { hostLoopCredentialSource, hostModelCredentialVerifier } from '../../src/runtime/loop-credentials.js'
import {
  adapter,
  config,
  inline,
  owner,
  pick,
  prepareRequest,
  stateBinding,
  wire,
} from './model-contract-fixture.js'
import {
  action,
  boundary,
  cleanup,
  consumer,
  error,
  type Kind,
  must,
  refreshInput,
  resolveInput,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

const runScope: W.ScopeRef = {
  kind: 'run',
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session-1',
  runId: 'run-1',
}
const modelBinding: W.SecretConsumerBinding = {
  consumer: 'model',
  secretId: 'credential',
  accountRef: null,
  serverRef: 'model-endpoint',
  audience: 'fixture-endpoint',
  purpose: 'model-inference',
}
const otherAudience: W.SecretConsumerBinding = { ...modelBinding, audience: 'other-audience' }
const otherPurpose: W.SecretConsumerBinding = { ...modelBinding, purpose: 'other-purpose' }
const otherSecret: W.SecretConsumerBinding = { ...modelBinding, secretId: 'other-secret' }
const deadline = '2099-01-01T00:00:00.000Z'
const entries = [
  {
    secretId: 'credential',
    versions: [
      { version: 'v1', ref: 'secret://fixture/old' },
      { version: 'v2', ref: 'secret://fixture/new' },
    ],
  },
  { secretId: 'other-secret', versions: [{ version: 'v1', ref: 'secret://fixture/other' }] },
]
const grants = [modelBinding, otherAudience, otherPurpose, otherSecret].map((binding) => ({
  principalRef: 'actor',
  scope: runScope,
  binding,
}))
const detail = (value: { ok: boolean; error?: { code: string; detailCode: string } }) =>
  value.ok ? 'ok' : `${value.error?.code}/${value.error?.detailCode}`
const ask = (binding: W.SecretConsumerBinding) => ({
  secretId: binding.secretId,
  audience: binding.audience,
  purpose: binding.purpose,
})

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}
function stored(kind: Kind, directory: string): string {
  if (kind === 'default') {
    const db = new DatabaseSync(join(directory, 'broker.sqlite'), { readOnly: true })
    try {
      return JSON.stringify(
        db.prepare('SELECT id, locator, grant_digest, revision FROM handles ORDER BY id').all(),
      )
    } finally {
      db.close()
    }
  }
  const db = new DatabaseSync(join(directory, 'cabinet.sqlite'), { readOnly: true })
  try {
    return String(db.prepare('SELECT document FROM cabinet WHERE singleton = 1').get()?.document)
  } finally {
    db.close()
  }
}
function traveled(handle: W.SecretHandle): W.SecretHandle {
  const parsed = validateRuntime('SecretHandle', JSON.parse(JSON.stringify(handle)))
  if (!parsed.ok) throw new Error('handle codec rejected a broker handle')
  return parsed.value
}

async function report(kind: Kind) {
  let clock = Date.parse('2026-10-06T00:00:00.000Z')
  let reads = 0
  const root = scratch()
  const auth = boundary()
  const call = (patch: Partial<CallContext> = {}, maintenance = false) =>
    auth.call(
      { deadline, scope: runScope, bindingId: owner.bindingId, principalRef: 'actor', ...patch },
      maintenance,
    )
  const broker = secrets(kind, root, auth, {
    now: () => clock,
    entries,
    grants,
    handleMs: 60_000,
    source: {
      resolve(ref) {
        reads += 1
        if (ref === 'secret://fixture/old') return 'not-real'
        if (ref === 'secret://fixture/other') return 'other'
        return 'rotated'
      },
    },
  })
  const route = {
    ...prepareRequest().route,
    credentialAudience: modelBinding.audience,
    credentialBinding: modelBinding,
  }
  const deployment: ModelDeployment = {
    packageDigest: 'f'.repeat(64),
    config,
    secrets: {
      bindingId: 'secrets',
      contract: 'agh.secrets',
      logicalName: 'default',
      providerId: 'fixture/secrets',
    },
    state: stateBinding,
    current: (context) => context.bindingId === owner.bindingId && !context.signal.aborted,
    catalog: {
      capture: () => ({
        ok: true,
        value: {
          digest: canonicalJsonDigest({ routes: [pick] } as never),
          select: (name, id) => (name === 'fixed-route' && id === 'fixture-model' ? pick : undefined),
        },
      }),
    },
    prices: { version: (target) => target.priceVersion },
    wire: { resolve: async () => ({ ok: true, value: wire }) },
    adapters: {
      select: (target) =>
        target.bindingId === adapter.bindingId ? { binding: adapter, packageDigest: 'package-1' } : null,
    },
    credentials: hostModelCredentialVerifier(broker),
    registry: createPreparedRegistry(),
    bridge: { ready: () => ({ ok: true, value: undefined }) },
    now: () => clock,
  }
  const factory = createDefaultModelFactory(deployment)
  const encoded = config.encode({})
  if (!encoded.ok) throw new Error(encoded.error.detailCode)
  const provider = await factory.create(encoded.value, createTestServiceContainer().dependencies, {
    instanceId: 'instance',
    bindingId: owner.bindingId,
    scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' },
    signal: new AbortController().signal,
  })
  const ready = await provider.ready(call())
  if (!ready.ok) throw new Error(ready.error.detailCode)
  const prepare = (credentialRef: W.SecretHandle | null, context = call()) =>
    provider.compute?.(
      {
        target: owner,
        method: 'prepare',
        input: inline(RuntimeMethodSchemaRefs['agh.model'].prepare.input, {
          ...prepareRequest(),
          route,
          credentialRef,
        }),
      },
      context,
    ) ?? Promise.reject(new Error('prepare missing'))
  try {
    expect(broker.features.includes('verifyIssued')).toBe(false)
    const issued = must(await broker.resolve(ask(modelBinding), call()))
    const handle = traveled(issued)
    const before = stored(kind, root)
    const first = detail(await broker.verifyIssued(handle, modelBinding, call()))
    const second = detail(await broker.verifyIssued(handle, modelBinding, call()))
    const after = stored(kind, root)
    const verifyReads = reads
    const prepared = detail(await prepare(handle))
    const forged = traveled({ ...handle, handleId: randomUUID() })
    const extended = traveled({
      ...handle,
      expiresAt: new Date(Date.parse(handle.expiresAt) + 60_000).toISOString(),
    })
    const audience = must(await broker.resolve(ask(otherAudience), call()))
    const purpose = must(await broker.resolve(ask(otherPurpose), call()))
    const secret = must(await broker.resolve(ask(otherSecret), call()))
    const forgedDirect = detail(await broker.verifyIssued(forged, modelBinding, call()))
    const forgedPrepare = detail(await prepare(forged))
    const extendedDirect = detail(await broker.verifyIssued(extended, modelBinding, call()))
    const extendedPrepare = detail(await prepare(extended))
    const audienceDirect = detail(await broker.verifyIssued(audience, modelBinding, call()))
    const audiencePrepare = detail(await prepare(audience))
    const purposeDirect = detail(await broker.verifyIssued(purpose, modelBinding, call()))
    const purposePrepare = detail(await prepare(purpose))
    const secretDirect = detail(await broker.verifyIssued(secret, modelBinding, call()))
    const secretPrepare = detail(await prepare(secret))
    const otherPrincipal = detail(
      await broker.verifyIssued(handle, modelBinding, call({ principalRef: 'other' })),
    )
    const otherPrincipalPrepare = detail(await prepare(handle, call({ principalRef: 'other' })))
    let verifierCalls = 0
    deployment.credentials = {
      verifyIssued: async (candidate, binding, context) => {
        verifierCalls += 1
        return hostModelCredentialVerifier(broker).verifyIssued(candidate, binding, context)
      },
    }
    const managed = await managedPrepare(provider, handle)
    const managedCalls = verifierCalls
    clock = Date.parse(handle.expiresAt) + 1000
    const expiredDirect = detail(await broker.verifyIssued(handle, modelBinding, call()))
    const expiredPrepare = detail(await prepare(handle))
    clock = Date.parse('2026-10-06T00:00:00.000Z')
    await broker.close()
    const reopened = secrets(kind, root, auth, {
      now: () => clock,
      entries,
      grants,
      handleMs: 60_000,
      source: { resolve: () => 'not-real' },
    })
    try {
      const restarted = detail(await reopened.verifyIssued(handle, modelBinding, call()))
      clock = Date.parse(handle.expiresAt) + 1000
      const restartedExpired = detail(await reopened.verifyIssued(handle, modelBinding, call()))
      clock = Date.parse('2026-10-06T00:00:00.000Z')
      const renewed = must(await reopened.resolve(ask(modelBinding), call()))
      const renewedOk = detail(await reopened.verifyIssued(renewed, modelBinding, call()))
      must(
        await reopened.rotate(
          { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
          call({}, true),
        ),
      )
      const rotated = detail(await reopened.verifyIssued(renewed, modelBinding, call()))
      must(await reopened.revoke({ secretId: 'credential', reason: 'test' }, call({}, true)))
      const revoked = detail(await reopened.verifyIssued(renewed, modelBinding, call()))
      return {
        first,
        second,
        unchanged: before === after,
        reads: verifyReads,
        prepared,
        forgedDirect,
        forgedPrepare,
        extendedDirect,
        extendedPrepare,
        audienceDirect,
        audiencePrepare,
        purposeDirect,
        purposePrepare,
        secretDirect,
        secretPrepare,
        otherPrincipal,
        otherPrincipalPrepare,
        expiredDirect,
        expiredPrepare,
        restarted,
        restartedExpired,
        renewedOk,
        rotated,
        revoked,
        managed,
        managedCalls,
        expiresAt: handle.expiresAt,
      }
    } finally {
      await reopened.close()
    }
  } finally {
    await provider.close('shutdown')
    await broker.close()
    cleanup(root)
  }
}

async function managedPrepare(
  provider: Awaited<ReturnType<ReturnType<typeof createDefaultModelFactory>['create']>>,
  handle: W.SecretHandle,
) {
  const factory = provider.actions?.prepareRequest
  if (!factory) throw new Error('prepareRequest missing')
  const action = await factory.create({
    instanceId: 'instance',
    actionId: 'parent-1',
    runId: 'run-1',
    bindingId: owner.bindingId,
    scope: runScope,
    signal: new AbortController().signal,
  })
  if (action.kind !== 'composite') throw new Error('prepareRequest is not composite')
  const request = {
    ...prepareRequest(),
    route: {
      ...prepareRequest().route,
      credentialAudience: modelBinding.audience,
      credentialBinding: modelBinding,
    },
    hookResults: null,
    credentialRefresh: null,
    credentialRef: handle,
  }
  const schema = RuntimeMethodSchemaRefs['agh.model'].prepareRequest.input
  const resolve = RuntimeMethodSchemaRefs['agh.secrets'].resolve
  const { signal: _signal, ...context } = {
    principalRef: 'actor',
    scope: runScope,
    bindingId: owner.bindingId,
    invocationId: 'invocation',
    deadline,
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal: new AbortController().signal,
  }
  const input = inline(schema, request)
  const frame: W.ActionFrame = {
    actionId: 'parent-1',
    parentActionId: null,
    runId: 'run-1',
    bindingId: owner.bindingId,
    method: 'prepareRequest',
    input,
    inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
    attemptId: 'attempt-1',
    attemptNumber: 1,
    invocationId: 'invocation-parent',
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 'signals', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'receipts', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'frame',
    observedAt: '2026-10-06T00:00:00.000Z',
    context,
    actionTimebox: { defaultTimeoutMs: 10_000, maxDeadline: deadline },
  }
  const ports: LoopReadPorts = {
    query: async () => ({
      ok: true,
      value: { kind: 'value', output: inline(resolve.output, handle), snapshot: 'snapshot' },
    }),
    compute: async () => {
      throw new Error('unused')
    },
    resolveData: async () => {
      throw new Error('unused')
    },
    prepare: () => {
      throw new Error('unused')
    },
  }
  const out = await action.start(frame, ports)
  return out.next.kind
}

describe('issued handle verification', () => {
  it('gives both brokers the same answers for the prepare-time checks', async () => {
    const left = await report('default')
    const right = await report('reference')
    expect(left).toEqual(right)
    expect(left).toMatchObject({
      first: 'ok',
      second: 'ok',
      unchanged: true,
      reads: 0,
      prepared: 'ok',
      forgedDirect: 'denied/secret_handle',
      forgedPrepare: 'incompatible/model_credential_unverified',
      extendedDirect: 'denied/secret_handle',
      extendedPrepare: 'incompatible/model_credential_unverified',
      audienceDirect: 'denied/secret_handle',
      audiencePrepare: 'denied/model_credential_binding',
      purposeDirect: 'denied/secret_handle',
      purposePrepare: 'incompatible/model_credential_unverified',
      secretDirect: 'denied/secret_handle',
      secretPrepare: 'denied/model_credential_binding',
      otherPrincipal: 'denied/secret_handle',
      otherPrincipalPrepare: 'incompatible/model_credential_unverified',
      expiredDirect: 'denied/secret_handle',
      expiredPrepare: 'denied/model_credential_expired',
      restarted: 'ok',
      restartedExpired: 'denied/secret_handle',
      renewedOk: 'ok',
      rotated: 'denied/secret_handle',
      revoked: 'denied/secret_handle',
      managed: 'complete',
      managedCalls: 0,
    })
  })

  it('asks the egress broker, with the prepare call, and does not let accept vouch for a handle', async () => {
    const root = scratch()
    const auth = boundary()
    const broker = secrets('default', root, auth, {
      grants: [{ principalRef: 'actor', scope: runScope, binding: modelBinding }],
      entries: entries.slice(0, 1),
    })
    try {
      const context = auth.call({
        deadline,
        scope: runScope,
        bindingId: owner.bindingId,
      })
      const handle = must(await broker.resolve(ask(modelBinding), context))
      let seen: CallContext | undefined
      const original = broker.verifyIssued.bind(broker)
      broker.verifyIssued = async (candidate, binding, call) => {
        seen = call
        return original(candidate, binding, call)
      }
      const egress = { secrets: broker }
      const credentials = hostModelCredentialVerifier(egress.secrets)
      expect(egress.secrets).toBe(broker)
      expect(await credentials.verifyIssued(handle, modelBinding, context)).toBe(true)
      expect(seen).toBe(context)
      expect(
        await credentials.verifyIssued({ ...handle, handleId: randomUUID() }, modelBinding, context),
      ).toBe(false)
      let checks = 0
      const accepted: W.SecretHandle[] = []
      let resolves = 0
      const source: DefaultLoopSource = {
        checkCurrent: async () => ({ ok: true, value: undefined }),
        async readInputs() {
          return {
            ok: true,
            value: {
              routing: {
                allowedRoutes: [
                  {
                    credentialBinding: modelBinding,
                    credentialAudience: modelBinding.audience,
                  },
                ],
              },
              credentialRef: null,
            } as never,
          }
        },
      }
      const ownerCredentials = {
        secrets: {
          async resolve(request: unknown, call: CallContext) {
            resolves += 1
            return broker.resolve(request, call)
          },
          async verifyIssued() {
            checks += 1
            return { ok: true as const, value: undefined }
          },
        },
        async select() {
          return {
            ok: true as const,
            value: {
              consumer: modelBinding,
              context,
              async accept(issued: W.SecretHandle) {
                accepted.push(issued)
                return { ok: true as const, value: undefined }
              },
            },
          }
        },
      }
      const wrapped = hostLoopCredentialSource(source, ownerCredentials)
      const first = await wrapped.readInputs({} as W.RunFrame, 'first-model', {} as LoopReadPorts)
      const second = await wrapped.readInputs({} as W.RunFrame, 'second-model', {} as LoopReadPorts)
      if (!first.ok || !second.ok) throw new Error('loop issuance refused')
      expect(accepted[0]).toBe(first.value.credentialRef)
      expect(accepted[1]).toBe(second.value.credentialRef)
      expect(accepted[0]).not.toBe(accepted[1])
      expect(resolves).toBe(2)
      expect(checks).toBe(0)
      const production = walk(join(import.meta.dirname, '../../src'))
      const constantTrue = production.filter((file) =>
        /verifyIssued\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*true/.test(readFileSync(file, 'utf8')),
      )
      expect(constantTrue).toEqual([])
      expect(
        readFileSync(join(import.meta.dirname, '../../src/runtime/loop-credentials.ts'), 'utf8'),
      ).toContain('secrets.verifyIssued')
    } finally {
      await broker.close()
      cleanup(root)
    }
  })

  it('collapses a refresh lock to the same handle refusal and leaves use unchanged', async () => {
    const root = scratch()
    const auth = boundary()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const broker = secrets('default', root, auth, {
      refresh: async () => {
        entered()
        await held
        return { state: 'unknown' }
      },
    })
    try {
      const context = auth.call()
      const handle = must(await broker.resolve(resolveInput, context))
      const pending = broker.refresh(refreshInput, action(auth.call()))
      await started
      expect(error(await broker.verifyIssued(handle, consumer, auth.call()))).toBe('denied/secret_handle')
      expect(error(await broker.use(handle, consumer, auth.call(), () => {}))).toBe(
        'denied/secret_refresh_pending',
      )
      release()
      await pending
    } finally {
      release()
      await broker.close()
      cleanup(root)
    }
  })
})
