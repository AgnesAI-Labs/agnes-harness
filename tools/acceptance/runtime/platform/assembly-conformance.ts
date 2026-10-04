import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  constructReferenceReleaseSet,
  createReferenceAssemblyProvider,
} from '../../../../examples/runtime-reference/src/providers/assembly.js'
import {
  type AssemblyPlanContractBinding,
  registerAssemblyPlanContract,
  registerAssemblyPrepareContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/assembly.js'
import {
  admissionFixtureInput,
  registerAssemblyAdmissionContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/assembly-admission.js'
import {
  type AssemblyPublishContractBinding,
  registerAssemblyPublishContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/assembly-publish.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import { constructReleaseSet } from '../../../../packages/host/src/runtime/assembly/release-set.js'
import { createAssemblyProvider } from '../../../../packages/host/src/runtime/providers/assembly.js'
import { admissionTestBinding } from '../../../../packages/host/test/runtime/fixtures/assembly-admission-binding.js'
import { memoryAssemblyLifecycle } from '../../../../packages/host/test/runtime/fixtures/assembly-lifecycle.js'
import {
  assemblyMaintenanceContext,
  persistentAssemblyFixture,
} from '../../../../packages/host/test/runtime/fixtures/assembly-maintenance.js'
import { getConformanceBuildIdentity } from '../build-identity.js'

function hash(files: string[]): string {
  const digest = createHash('sha256')
  for (const file of files) digest.update(readFileSync(new URL(`../../../../${file}`, import.meta.url)))
  return digest.digest('hex')
}
export function assemblyPublishBinding(
  providerId: 'default' | 'reference',
  command: string,
): AssemblyPublishContractBinding {
  const files =
    providerId === 'default'
      ? [
          'packages/host/src/runtime/providers/assembly.ts',
          'packages/host/src/runtime/assembly/publication.ts',
          'packages/host/src/runtime/assembly/maintenance-journal.ts',
          'packages/host/src/runtime/assembly/admission-ticket.ts',
          'packages/host/src/runtime/assembly/package-pins.ts',
          'packages/host/src/runtime/assembly/release-set.ts',
          'packages/host/src/runtime/assembly/client-bundles.ts',
          'packages/host/src/runtime/assembly/client-lock.ts',
          'packages/host/src/runtime/assembly/candidate.ts',
        ]
      : [
          'examples/runtime-reference/src/providers/assembly.ts',
          'examples/runtime-reference/src/providers/assembly-client-lock.ts',
          'examples/runtime-reference/src/providers/assembly-publication.ts',
          'examples/runtime-reference/src/providers/assembly-journal.ts',
          'examples/runtime-reference/src/providers/assembly-admission.ts',
          'examples/runtime-reference/src/providers/assembly-candidate.ts',
        ]
  return {
    providerId,
    command,
    providerDigest: hash(files),
    build: getConformanceBuildIdentity(),
    context: assemblyMaintenanceContext,
    create: providerId === 'default' ? createAssemblyProvider : createReferenceAssemblyProvider,
    async open(input, directory) {
      const fixture = await persistentAssemblyFixture(input, join(directory, 'maintenance.sqlite'))
      if (!fixture.memory) throw new Error('fixture lifecycle missing')
      return { ...fixture, lifecycle: fixture.memory.lifecycle, snapshot: fixture.database.inspect }
    },
    async coldReplay(directory) {
      const script = fileURLToPath(new URL('../fixtures/assembly-cold-process.ts', import.meta.url))
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', script, providerId, directory, 'replay'],
        { encoding: 'utf8', timeout: 30_000 },
      )
      if (child.status !== 0 || child.error)
        throw new Error(`assembly cold process failed: ${child.stderr}`, { cause: child.error })
      return JSON.parse(child.stdout) as Awaited<ReturnType<AssemblyPublishContractBinding['coldReplay']>>
    },
  }
}
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
  part: 'all' | 'plan' | 'prepare' | 'publish' | 'admission' = 'all',
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes('agh.assembly'))
    return { contracts: [], providers: [] }
  const providers = request.providers.filter((provider) => provider === 'default' || provider === 'reference')
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
            'packages/host/src/runtime/assembly/candidate.ts',
            'packages/host/src/runtime/scoped-dependencies.ts',
            'packages/plugin-runtime/src/runtime/cordis-adapter.ts',
            'packages/host/src/runtime/assembly/inputs.ts',
            'packages/host/src/runtime/assembly/primitives.ts',
          ]
        : [
            'examples/runtime-reference/src/providers/assembly.ts',
            'examples/runtime-reference/src/providers/assembly-client-lock.ts',
            'examples/runtime-reference/src/providers/assembly-candidate.ts',
          ]
    const publicationBinding = assemblyPublishBinding(providerId as 'default' | 'reference', request.command)
    const providerDigest = hash([
      ...implementation,
      ...(providerId === 'default'
        ? [
            'packages/host/src/runtime/assembly/client-bundles.ts',
            'packages/host/src/runtime/assembly/client-lock.ts',
            'packages/host/src/runtime/assembly/publication.ts',
            'packages/host/src/runtime/assembly/maintenance-journal.ts',
            'packages/host/src/runtime/assembly/admission-ticket.ts',
            'packages/host/src/runtime/assembly/package-pins.ts',
          ]
        : [
            'examples/runtime-reference/src/providers/assembly-client-lock.ts',
            'examples/runtime-reference/src/providers/assembly-publication.ts',
            'examples/runtime-reference/src/providers/assembly-journal.ts',
            'examples/runtime-reference/src/providers/assembly-admission.ts',
          ]),
    ])
    const binding: AssemblyPlanContractBinding = {
      providerId,
      command: request.command,
      providerDigest,
      build: getConformanceBuildIdentity(),
      context,
      create: providerId === 'default' ? createAssemblyProvider : createReferenceAssemblyProvider,
      lifecycle: memoryAssemblyLifecycle,
      construct: providerId === 'default' ? constructReleaseSet : constructReferenceReleaseSet,
    }
    if (part === 'all' || part === 'plan') registerAssemblyPlanContract(harness, binding)
    if (part === 'all' || part === 'prepare') registerAssemblyPrepareContract(harness, binding)
    if (part === 'all' || part === 'publish')
      registerAssemblyPublishContract(harness, { ...publicationBinding, providerDigest })
    if (part === 'all' || part === 'admission')
      registerAssemblyAdmissionContract(harness, {
        ...admissionTestBinding(providerId as 'default' | 'reference', admissionFixtureInput()),
        command: request.command,
        providerDigest: hash(
          providerId === 'default'
            ? [
                'packages/host/src/runtime/assembly/admission.ts',
                'packages/host/src/runtime/assembly/admission-ticket.ts',
              ]
            : [
                'examples/runtime-reference/src/providers/assembly-admission-coordinator.ts',
                'examples/runtime-reference/src/providers/assembly-admission.ts',
              ],
        ),
        build: getConformanceBuildIdentity(),
      })
  }
  return { contracts: ['agh.assembly'], providers }
}
