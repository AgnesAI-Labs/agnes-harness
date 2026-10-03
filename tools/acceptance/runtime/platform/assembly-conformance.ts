import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  constructReferenceReleaseSet,
  createReferenceAssemblyProvider,
} from '../../../../examples/runtime-reference/src/providers/assembly.js'
import {
  type AssemblyPlanContractBinding,
  registerAssemblyPlanContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/assembly.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { constructReleaseSet } from '../../../../packages/host/src/runtime/assembly/release-set.js'
import { createAssemblyProvider } from '../../../../packages/host/src/runtime/providers/assembly.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'

function hash(files: string[]): string {
  const digest = createHash('sha256')
  for (const file of files) digest.update(readFileSync(new URL(`../../../../${file}`, import.meta.url)))
  return digest.digest('hex')
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.assembly'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((provider) => provider === 'default' || provider === 'reference')
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const lockDigest = hash(['pnpm-lock.yaml'])
  const sdk = JSON.parse(
    readFileSync(new URL('../../../../packages/extension-api/package.json', import.meta.url), 'utf8'),
  ) as { name: string; version: string }
  const specVersion = 'runtime-services-1'
  const context = (): ReturnType<AssemblyPlanContractBinding['context']> => ({
    signal: new AbortController().signal,
    principalRef: 'fixture-principal',
    bindingId: 'fixture-binding',
    invocationId: 'fixture-invocation',
    deadline: '2030-01-01T00:00:00Z',
    traceRef: 'fixture-trace',
    // A public CallContext fixture, never a production maintenance credential.
    scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
    authorizationRef: 'fixture-authorization',
  })
  for (const providerId of providers) {
    const implementation =
      providerId === 'default'
        ? [
            'packages/host/src/runtime/providers/assembly.ts',
            'packages/host/src/runtime/assembly/release-set.ts',
            'packages/host/src/runtime/assembly/inputs.ts',
            'packages/host/src/runtime/assembly/primitives.ts',
          ]
        : ['examples/runtime-reference/src/providers/assembly.ts']
    const providerDigest = hash(implementation)
    registerAssemblyPlanContract(harness, {
      providerId,
      command: request.command,
      providerDigest,
      build: {
        codeSha,
        buildDigest: canonicalJsonDigest({ codeSha, specVersion }),
        lockDigest,
        specVersion,
        sdkVersion: sdk.version,
        sdkDigest: canonicalJsonDigest({ name: sdk.name, version: sdk.version }),
        platform: `${process.platform}-${process.arch}`, // guards-allow-platform: evidence only, no branch
      },
      context,
      create: providerId === 'default' ? createAssemblyProvider : createReferenceAssemblyProvider,
      construct: providerId === 'default' ? constructReleaseSet : constructReferenceReleaseSet,
    })
  }
  return { contracts: ['agh.assembly'], providers }
}
