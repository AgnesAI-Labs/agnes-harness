import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerExecContract } from '../../../../packages/extension-api/testkit/runtime/contracts/exec.js'
import { registerSandboxContract } from '../../../../packages/extension-api/testkit/runtime/contracts/sandbox.js'
import type { ScenarioName } from '../../../../packages/extension-api/testkit/runtime/evidence.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { cleanup, error, type Kind } from '../../../../packages/host/test/runtime/network-secrets-fixture.js'
import { fixture } from '../../../../packages/host/test/runtime/sandbox-exec-fixture.js'
import { scenario } from '../../../../packages/host/test/runtime/sandbox-exec-scenarios.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const owned = ['agh.sandbox', 'agh.exec'] as const
const digest = (path: string) =>
  createHash('sha256')
    .update(readFileSync(ROOT + path))
    .digest('hex')
export const qualification = {
  darwin: {
    ownership: 'cooperative: process group + inherited lifeline',
    strong: false,
    securityDebt:
      'setsid plus deliberate closure of all inherited descriptors can escape detection; blocks main; platform owner must close before release qualification',
    isolation: 'Seatbelt',
    openFilesMinimum: 32,
    unsupported: ['remote sandbox', 'partial-access policy', 'Exec.env.secret'],
  },
  linux: {
    ownership:
      'strong native cgroup v2 only with delegation, protected supervisor and isolated control filesystem',
    serviceQualified: false,
    unsupported: ['Linux filesystem isolation provider', 'reference cgroup backend', 'Exec.env.secret'],
  },
  win32: {
    ownership: 'unsupported: Job Object backend is absent',
    tested: false,
    unsupported: ['sandbox isolation', 'six execution limits', 'Exec.env.secret'],
  },
}
function methods(run: (name: ScenarioName) => Promise<ReturnType<typeof evidence>>) {
  return {
    select: () => run('select'),
    normal: () => run('normal'),
    deny: () => run('deny'),
    cancel: () => run('cancel'),
    recover: () => run('recover'),
    dispose: () => run('dispose'),
  }
}
function evidence(kind: Kind, name: 'sandbox' | 'exec', detail: string) {
  const prefix =
    kind === 'default' ? 'packages/host/src/runtime/providers/' : 'examples/runtime-reference/src/providers/'
  return {
    passed: true,
    providerDigest: digest(`${prefix + name}.ts`),
    configDigest: canonicalJsonDigest({ kind, name, qualification }),
    releaseSetDigest: canonicalJsonDigest({
      kind,
      name,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    }),
    detail,
  }
}
export async function unsupportedPlatform(kind: Kind, service: 'sandbox' | 'exec') {
  const f = await fixture(kind)
  try {
    const ref = {
      authorityId: 'sandbox-authority',
      sandboxId: 'unsupported',
      ownerBinding: f.sandbox.binding,
      lease: f.mount.lease,
    }
    const result =
      service === 'sandbox'
        ? await f.sandbox.create(f.createInput, f.auth.call())
        : await f.exec.run(
            {
              sandboxRef: ref,
              argv: ['/bin/echo'],
              cwd: { mount: f.mount, path: '' },
              env: [],
              stdinRef: null,
              limits: f.createInput.resourceLimits,
            },
            f.auth.call(),
          )
    assert.equal(
      error(result),
      'incompatible/' +
        (service === 'sandbox' ? 'sandbox_isolation_unsupported' : 'exec_platform_unsupported'),
    )
    assert.equal(f[service].features.length, 0)
  } finally {
    await f.close()
    cleanup(f.directory)
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
) {
  const contracts = owned.filter((name) => request.contracts === 'all' || request.contracts.includes(name))
  if (!contracts.length) return { contracts: [], providers: [] }
  const providers = request.providers.filter((id) =>
    [
      'default',
      'reference',
      'agh.default/sandbox',
      'agh.default/exec',
      'agh.reference/sandbox',
      'agh.reference/exec',
    ].includes(id),
  )
  const build = getConformanceBuildIdentity()
  for (const providerId of providers) {
    const kind = providerId.includes('reference') ? 'reference' : 'default'
    for (const contract of contracts) {
      const name = contract === 'agh.exec' ? 'exec' : 'sandbox'
      const supported = process.platform === 'darwin' // guards-allow-platform: explicit backend qualification
      const sources = [
        {
          recipe: supported
            ? `${kind}-darwin-cooperative-lifeline-main-blocked`
            : `${kind}-unsupported-platform`,
          qualification: supported ? ('required' as const) : ('not-advertised' as const),
          features: supported
            ? [name === 'exec' ? 'run' : 'create', 'cooperative-ownership']
            : ['unsupported-platform'],
          ...methods(async (test) => {
            const proof = evidence(kind, name, supported ? test : 'explicit unsupported refusal')
            if (supported) await scenario(kind, name, test, proof.providerDigest)
            else await unsupportedPlatform(kind, name)
            return proof
          }),
        },
      ]
      if (name === 'exec')
        registerExecContract(harness, { command: request.command, build, providerId, sources })
      else registerSandboxContract(harness, { command: request.command, build, providerId, sources })
    }
  }
  return { contracts, providers }
}
