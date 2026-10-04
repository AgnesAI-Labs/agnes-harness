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
import { expectedRefusal, scenario } from '../../../../packages/host/test/runtime/sandbox-exec-scenarios.js'
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
    serviceQualified: false,
    mandatoryLimits: 'refused before effects: memoryBytes/processes have no hard gate',
    samples: { diagnosticOnly: true, hardLimit: false, overshootBound: null },
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
    hardGates: {
      controllers: ['memory.max', 'memory.swap.max', 'pids.max', 'memory.oom.group'],
      qualification: 'set and exact readback on a real trusted delegation, before any business fork',
      evidence: 'conditional Linux kernel tests; not exercised by admission conformance',
    },
    mandatoryLimits: 'CPU-total and aggregate openFiles are unavailable; zero business launches',
    samples: { diagnosticOnly: true, hardLimit: false, overshootBound: null },
    unsupported: ['Linux filesystem isolation provider', 'reference cgroup backend', 'Exec.env.secret'],
  },
  win32: {
    ownership: 'strong Job membership for directly inherited descendants; suspended launch, no breakaway',
    nativeImplemented: true,
    serviceQualified: false,
    supervisorProtected: false,
    tested: false,
    openFiles: {
      default: 'SystemExtendedHandleInformation + NtQueryObject(File)',
      reference: 'ProcessHandleInformation + NtQueryObject(File)',
      diagnosticOnly: true,
      hardLimit: false,
      overshootBound: null,
      qualified: false,
      decision: 'Windows refuses execution with openFiles: handle sampling cannot impose a hard ceiling',
    },
    memory: 'Job committed-byte ceilings plus aggregate working-set watchdog; distinct measurements',
    validation: 'Windows Job limits, stable File refusal and ownership await integration CI',
    unsupported: [
      'sandbox isolation',
      'qualified openFiles enforcement',
      'protected supervisor',
      'Exec.env.secret',
    ],
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
    assert.equal(error(result), expectedRefusal(service))
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
      const sources = [
        {
          recipe: `${kind}-mandatory-hard-gate-refusal`,
          qualification: 'required' as const,
          features: ['admission-refusal'],
          scenarios: ['deny', 'cancel', 'dispose'] as const,
          ...methods(async (test) => {
            await scenario(kind, name, test)
            return evidence(kind, name, 'Admission refusal only; no launch qualification')
          }),
        },
      ]
      // A refusal does not prove selection, normal execution or cold recovery.
      for (const unavailable of ['select', 'normal', 'recover'] as const)
        harness.registerCase({
          contract,
          scenario: unavailable,
          qualification: 'not-advertised',
          providerId,
          build,
          run: () => ({
            id: `${contract}/${providerId}/unqualified-hard-limits/${unavailable}`,
            ...evidence(kind, name, 'No qualified hard-limit backend'),
            recipe: 'unqualified-hard-limits',
            features: [],
            build,
            consumer: `${name}-consumer`,
            command: request.command,
            status: 'skipped',
            diagnostic:
              'Incomplete: mandatory hard gates unavailable; refusal is not normal or recovery evidence',
            attachmentDigest: null,
            fixture: 'restricted-effects',
            sharedEvidenceId: null,
          }),
        })
      if (name === 'exec')
        registerExecContract(harness, { command: request.command, build, providerId, sources })
      else registerSandboxContract(harness, { command: request.command, build, providerId, sources })
    }
  }
  return { contracts, providers }
}
