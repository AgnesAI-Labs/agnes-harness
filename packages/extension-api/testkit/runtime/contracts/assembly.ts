import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type { AssemblyGraph, ReleaseSet } from '@agnes/protocol/runtime'
import type { BuildIdentity } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import { assemblyRefusalFixtures } from './assembly-cases.js'
import { ASSEMBLY_UNFINISHED, assemblyFixture, fixtureHash } from './assembly-fixture.js'

export const ASSEMBLY_PLAN_COVERAGE = Object.freeze({
  implemented: Object.freeze(['plan']),
  unfinished: ASSEMBLY_UNFINISHED,
  qualification: 'static-public-fixture',
})
export interface AssemblyPlanSubject {
  readonly providerId: string
  plan(request: unknown, context: CallContext): Promise<Outcome<AssemblyGraph>>
}
export interface AssemblyPlanContractBinding {
  readonly providerId: string
  readonly command: string
  readonly build: BuildIdentity
  readonly providerDigest: string
  readonly context: () => CallContext
  readonly create: (input: unknown) => AssemblyPlanSubject
  readonly construct: (input: unknown) => Outcome<ReleaseSet>
}

/** Only executable plan select/normal/deny cases. Other C49 behavior remains unfinished. */
export function registerAssemblyPlanContract(
  harness: ConformanceHarness,
  binding: AssemblyPlanContractBinding,
): void {
  for (const scenario of ['select', 'normal', 'deny'] as const)
    harness.registerCase({
      contract: 'agh.assembly',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        const input = assemblyFixture()
        const subject = binding.create(input)
        const request = { configRef: input.graph.configRef, lock: input.graph.lock }
        const first = await subject.plan(request, binding.context())
        let passed =
          first.ok &&
          subject.providerId === `agh.${binding.providerId}/assembly` &&
          fixtureHash(first.value) === fixtureHash(input.graph)
        if (scenario === 'normal') {
          const release = binding.construct(input)
          const repeat = await subject.plan(request, binding.context())
          passed =
            passed &&
            release.ok &&
            Object.isFrozen(release.value) &&
            repeat.ok &&
            fixtureHash(repeat.value) === fixtureHash(first.ok ? first.value : null)
        }
        if (scenario === 'deny') {
          const changed = {
            configRef: input.graph.configRef,
            lock: { ...input.graph.lock, digest: '0'.repeat(64) },
          }
          const denied = await subject.plan(changed, binding.context())
          passed = passed && !denied.ok && denied.error.detailCode === 'plan_input_mismatch'
          for (const row of assemblyRefusalFixtures()) {
            const rejected = await binding
              .create(row.input)
              .plan({ configRef: row.input.graph.configRef, lock: row.input.graph.lock }, binding.context())
            passed = passed && !rejected.ok && rejected.error.detailCode === row.code
          }
        }
        return {
          id: `agh.assembly/${binding.providerId}/plan/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'static-plan/public-fixture',
          features: ['plan'],
          build: binding.build,
          consumer: 'detached-assembly-plan-consumer',
          command: binding.command,
          status: passed ? 'passed' : 'failed',
          configDigest: input.plan.configDigest,
          releaseSetDigest: input.plan.targetReleaseSet.releaseSetId,
          attachmentDigest: fixtureHash(ASSEMBLY_PLAN_COVERAGE),
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'deployment',
            methodKind: 'maintenance',
            lifecycle: 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
