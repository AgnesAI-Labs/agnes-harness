import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type NetworkPort,
  type NetworkScenarioEvidence,
  registerNetworkContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/network.js'
import {
  registerSecretsContract,
  type SecretsPort,
} from '../../../../packages/extension-api/testkit/runtime/contracts/secrets.js'
import type {
  BuildIdentity,
  ScenarioName,
} from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import {
  action,
  boundary,
  cleanup,
  consumer,
  error,
  type Kind,
  loopback,
  must,
  network,
  peer,
  refreshInput,
  request,
  resolveInput,
  rule,
  scan,
  scope,
  scratch,
  secrets,
  selected,
} from '../../../../packages/host/test/runtime/network-secrets-fixture.js'
import {
  recoverNetwork,
  recoverRefresh,
  recoverSecrets,
} from '../../../../packages/host/test/runtime/network-secrets-process.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const OWNED = ['agh.network', 'agh.secrets'] as const
function build(): BuildIdentity {
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const sdk = JSON.parse(readFileSync(join(ROOT, 'packages/extension-api/package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const specVersion = 'runtime-services-1'
  return {
    codeSha,
    specVersion,
    buildDigest: canonicalJsonDigest({ codeSha, specVersion }),
    sdkVersion: sdk.version,
    sdkDigest: canonicalJsonDigest({ name: sdk.name, version: sdk.version }),
    lockDigest: createHash('sha256')
      .update(readFileSync(join(ROOT, 'pnpm-lock.yaml')))
      .digest('hex'),
    platform: `${process.platform}-${process.arch}`, // guards-allow-platform: evidence only
  }
}
function evidence(kind: Kind, name: 'network' | 'secrets', detail: string): NetworkScenarioEvidence {
  const path =
    kind === 'default' ? 'packages/host/src/runtime/providers/' : 'examples/runtime-reference/src/providers/'
  return {
    passed: true,
    providerDigest: createHash('sha256')
      .update(readFileSync(join(ROOT, `${path + name}.ts`)))
      .digest('hex'),
    configDigest: canonicalJsonDigest({ kind, name, tenant: 'tenant', scope }),
    releaseSetDigest: canonicalJsonDigest({
      kind,
      name,
      code: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    }),
    detail,
  }
}
async function networkScenario(kind: Kind, scenario: ScenarioName) {
  if (scenario === 'recover') {
    await recoverNetwork(kind)
    return evidence(kind, 'network', 'SIGKILL after send; no resend')
  }
  const root = scratch()
  const remote = await peer()
  const auth = boundary()
  const service = network(kind, root, auth, [rule(remote.port)], { resolver: loopback })
  try {
    if (scenario === 'select') await selected(service, evidence(kind, 'network', 'selection').providerDigest)
    else if (scenario === 'normal') {
      const output = must(await service.request(request(remote.port), auth.call()))
      assert.equal(output.status, 200)
      assert.equal(output.bodyRef.digest, createHash('sha256').update('peer-result').digest('hex'))
      assert.equal(output.receipt?.kind, 'inline')
      assert.equal(remote.requests(), 1)
    } else if (scenario === 'deny') {
      assert.equal(
        error(await service.request(request(remote.port), { ...auth.call() })),
        'denied/network_denied',
      )
      assert.equal(
        error(
          await service.request(
            request(remote.port),
            auth.call({
              scope: {
                kind: 'workspace',
                installationId: 'install',
                runtimeId: 'runtime',
                workspaceId: 'other',
              },
            }),
          ),
        ),
        'denied/network_denied',
      )
      assert.equal(remote.connections(), 0)
    } else if (scenario === 'cancel') {
      const abort = new AbortController()
      abort.abort()
      assert.equal(
        error(await service.request(request(remote.port), auth.call({ signal: abort.signal }))),
        'cancelled/network_cancelled',
      )
      assert.equal(remote.connections(), 0)
    } else {
      await service.close()
      assert.equal(error(await service.request(request(remote.port), auth.call())), 'denied/network_closed')
      assert.equal(remote.connections(), 0)
    }
    return evidence(kind, 'network', scenario)
  } finally {
    await service.close()
    await remote.close()
    cleanup(root)
  }
}
async function secretsScenario(kind: Kind, scenario: ScenarioName) {
  if (scenario === 'recover') {
    await recoverSecrets(kind)
    return evidence(kind, 'secrets', 'SIGKILL; current authorization and durable revoke')
  }
  const root = scratch()
  const auth = boundary()
  const broker = secrets(kind, root, auth)
  try {
    if (scenario === 'select') await selected(broker, evidence(kind, 'secrets', 'selection').providerDigest)
    else if (scenario === 'normal') {
      const old = must(await broker.resolve(resolveInput, auth.call()))
      must(
        await broker.use(old, consumer, auth.call(), (value) => {
          assert.equal(value === 'not-real', true)
        }),
      )
      assert.equal(
        must(
          await broker.rotate(
            { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
            auth.call({}, true),
          ),
        ).revision,
        2,
      )
      assert.equal(
        error(
          await broker.use(old, consumer, auth.call(), () => {
            throw new Error('Forbidden material exposure')
          }),
        ),
        'denied/secret_handle',
      )
      const current = must(await broker.resolve(resolveInput, auth.call()))
      must(
        await broker.use(current, consumer, auth.call(), (value) => {
          assert.equal(value === 'rotated', true)
        }),
      )
      must(await broker.revoke({ secretId: 'credential', reason: 'maintenance' }, auth.call({}, true)))
      assert.equal(error(await broker.use(current, consumer, auth.call(), () => {})), 'denied/secret_revoked')
      scan(root, ['not-real', 'rotated'], [old, current])
    } else if (scenario === 'deny') {
      const locator = must(await broker.resolve(resolveInput, auth.call()))
      const denied = await broker.use(locator, consumer, { ...auth.call() }, () => {
        throw new Error('Forbidden material exposure')
      })
      assert.equal(error(denied), 'denied/secret_denied')
      scan(root, ['not-real', 'rotated'], [denied])
    } else if (scenario === 'cancel') {
      const abort = new AbortController()
      abort.abort()
      assert.equal(
        error(await broker.resolve(resolveInput, auth.call({ signal: abort.signal }))),
        'cancelled/secret_cancelled',
      )
    } else {
      await broker.close()
      assert.equal(error(await broker.resolve(resolveInput, auth.call())), 'denied/secret_closed')
    }
    return evidence(kind, 'secrets', scenario)
  } finally {
    await broker.close()
    cleanup(root)
  }
}
function methods<T>(run: (scenario: ScenarioName) => Promise<T>) {
  return {
    select: () => run('select'),
    normal: () => run('normal'),
    deny: () => run('deny'),
    cancel: () => run('cancel'),
    recover: () => run('recover'),
    dispose: () => run('dispose'),
  }
}
function unsupported(kind: Kind, name: 'network' | 'secrets', feature: string): NetworkPort {
  return {
    recipe: `unsupported-${feature}`,
    features: [feature],
    qualification: 'not-advertised',
    scenarios: ['deny'],
    ...methods(async () => {
      const root = scratch()
      const auth = boundary()
      try {
        if (name === 'network') {
          const { addresses: _addresses, ...destination } = rule(1234)
          const provider = network(
            kind,
            root,
            auth,
            feature === 'proxy' ? [rule(1234, { proxy: 'http://localhost:4321' })] : [destination],
            {
              resolver:
                feature === 'proxy'
                  ? loopback
                  : ((async () => [{ address: '2001:4860:4860::8888', family: 6 }]) as never),
            },
          )
          try {
            assert.equal(
              error(await provider.request(request(1234), auth.call())),
              feature === 'proxy'
                ? 'incompatible/network_proxy_unsupported'
                : 'incompatible/network_address_family_unsupported',
            )
            assert.equal(provider.features.includes(feature), false)
          } finally {
            await provider.close()
          }
        } else {
          const broker = secrets(kind, root, auth)
          try {
            assert.equal(broker.features.includes(feature), false)
            const output =
              feature === 'refresh'
                ? await broker.refresh(refreshInput, action(auth.call()))
                : feature === 'exchange'
                  ? await broker.exchange({}, action(auth.call()))
                  : await broker.acceptCallback({}, auth.ingress())
            assert.equal(
              error(output),
              `incompatible/secret_${feature === 'acceptCallback' ? 'callback' : feature}_unsupported`,
            )
          } finally {
            await broker.close()
          }
        }
        return evidence(kind, name, `${feature} explicitly unsupported`)
      } finally {
        cleanup(root)
      }
    }),
  }
}
async function credentialEffects() {
  const root = scratch()
  const remote = await peer()
  const auth = boundary()
  const outbound = network('default', join(root, 'outbound'), auth, [rule(remote.port)], {
    resolver: loopback,
  })
  const renewal = async () => {
    must(await outbound.request(request(remote.port), auth.call()))
    return { state: 'ready' as const, newVersionRef: 'secret://fixture/new' }
  }
  const flow = {
    flowId: 'flow',
    stateDigest: canonicalJsonDigest('state'),
    redirectUri: 'http://localhost/callback',
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    grant: { principalRef: 'actor', scope, binding: consumer },
  }
  const first = secrets('default', join(root, 'refresh'), auth, { refresh: renewal })
  const second = secrets('default', join(root, 'exchange'), auth, {
    flows: [flow],
    trustedIngress: auth.trustedIngress,
    exchange: async (_input, code) => {
      assert.equal(Buffer.from(code).toString() === 'bad-code', true)
      return renewal()
    },
  })
  try {
    const ready = must(await first.refresh(refreshInput, action(auth.call())))
    assert.equal(ready.state, 'ready')
    assert.equal(ready.handle?.version, 'v2')
    const escrow = must(
      await second.acceptCallback(
        { flowId: 'flow', state: 'state', authorizationCode: 'bad-code', redirectUri: flow.redirectUri },
        auth.ingress(),
      ),
    )
    const exchanged = must(
      await second.exchange(
        {
          requestId: 'exchange',
          ...escrow,
          expectedVersion: 'v1',
          audience: consumer.audience,
          accountRef: 'account',
          serverRef: 'server',
        },
        action(auth.call()),
      ),
    )
    assert.equal(exchanged.state, 'ready')
    assert.equal(remote.requests(), 2)
    scan(join(root, 'refresh'), ['not-real', 'rotated', 'bad-code'], [ready])
    scan(join(root, 'exchange'), ['not-real', 'rotated', 'bad-code'], [exchanged])
    return evidence('default', 'secrets', 'restricted outbound refresh and encrypted callback exchange')
  } finally {
    await first.close()
    await second.close()
    await outbound.close()
    await remote.close()
    cleanup(root)
  }
}
function kindOf(id: string): Kind | null {
  if (id === 'default' || id === 'agh.default/network' || id === 'agh.default/secrets') return 'default'
  if (id === 'reference' || id === 'agh.reference/network' || id === 'agh.reference/secrets')
    return 'reference'
  return null
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
) {
  const wanted =
    request.contracts === 'all' ? [...OWNED] : OWNED.filter((name) => request.contracts.includes(name))
  const providers = request.providers.filter((id) => kindOf(id) !== null)
  if (!wanted.length) return { contracts: [], providers: [] }
  const identity = build()
  for (const providerId of providers) {
    const kind = kindOf(providerId)
    if (kind === null) continue
    if (wanted.includes('agh.network'))
      registerNetworkContract(harness, {
        command: request.command,
        build: identity,
        providerId,
        sources: [
          {
            recipe: kind === 'default' ? 'pinned-undici' : 'native-request-cabinet',
            ...methods((scenario) => networkScenario(kind, scenario)),
          },
          ...(kind === 'reference'
            ? [unsupported(kind, 'network', 'proxy'), unsupported(kind, 'network', 'public-ipv6')]
            : []),
        ],
      })
    if (wanted.includes('agh.secrets')) {
      const sources: SecretsPort[] = [
        {
          recipe: kind === 'default' ? 'sqlite-reference-broker' : 'document-cabinet',
          ...methods((scenario) => secretsScenario(kind, scenario)),
        },
      ]
      if (kind === 'reference')
        for (const feature of ['refresh', 'exchange', 'acceptCallback'])
          sources.push(unsupported(kind, 'secrets', feature))
      else
        sources.push({
          recipe: 'restricted-credential-effects',
          features: ['refresh', 'exchange', 'acceptCallback'],
          qualification: 'advertised',
          scenarios: ['normal', 'recover'],
          ...methods(async (scenario) => {
            if (scenario === 'recover') {
              await recoverRefresh()
              return evidence(kind, 'secrets', 'refresh SIGKILL; no token replay')
            }
            return credentialEffects()
          }),
        })
      registerSecretsContract(harness, { command: request.command, build: identity, providerId, sources })
    }
  }
  return { contracts: wanted, providers }
}
