import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyDrainResult,
  AssemblyGraph,
  AssemblyPrepareResult,
  BindingRef,
  Readiness,
  ReleaseSet,
} from '@agnes/protocol/runtime'
import type { BuildIdentity } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'
import { assemblyRefusalFixtures } from './assembly-cases.js'
import {
  ASSEMBLY_UNFINISHED,
  type AssemblyFixture,
  assemblyFixture,
  fixtureHash,
} from './assembly-fixture.js'

export const ASSEMBLY_PLAN_COVERAGE = Object.freeze({
  implemented: Object.freeze(['plan', 'prepare', 'memory-drain']),
  unfinished: ASSEMBLY_UNFINISHED,
  qualification: 'memory-public-fixture',
})
export interface AssemblyLifecyclePorts {
  readonly generationId: string
  readonly selections: readonly {
    readonly binding: BindingRef
    readonly major: number
    readonly scope: string
    readonly features: readonly string[]
    readonly packageDigest: string
  }[]
  prepare(signal: AbortSignal): Promise<AssemblyCandidateObservation>
  view(): AssemblyCandidateObservation | undefined
  drain(
    deadline: number,
  ): Promise<{ readonly state: string; readonly activeInvocationIds: readonly string[] }>
  activate?(): void
  close(): Promise<AssemblyCandidateObservation | undefined>
}
interface AssemblyCandidateObservation {
  readonly generationId: string
  readonly state: string
  readonly staged: boolean
  readonly readiness: readonly { readonly providerId: string; readonly ready: boolean }[]
  readonly diagnostics: readonly { readonly code: string; readonly event: string }[]
  readonly residualOwnerIds: readonly string[]
  readonly unknownActionIds: readonly string[]
}
export interface AssemblyLifecycleFixture {
  readonly lifecycle: AssemblyLifecyclePorts
  readonly started: Promise<void>
  readonly released: readonly string[]
  readonly mounted: readonly string[]
  readonly readied: readonly string[]
  cleanup(): Promise<void>
}
export interface AssemblyPlanSubject {
  readonly providerId: string
  plan(request: unknown, context: CallContext): Promise<Outcome<AssemblyGraph>>
  prepare(request: unknown, context: CallContext): Promise<Outcome<AssemblyPrepareResult>>
  drain(request: unknown, context: CallContext): Promise<Outcome<AssemblyDrainResult>>
  dispose(): Promise<readonly string[]>
  inspectCandidate():
    | { readonly state: string; readonly readiness: Readiness; readonly residualOwnerIds: readonly string[] }
    | undefined
}
export interface AssemblyPlanContractBinding {
  readonly providerId: string
  readonly command: string
  readonly build: BuildIdentity
  readonly providerDigest: string
  readonly context: () => CallContext
  readonly create: (input: unknown, lifecycle?: AssemblyLifecyclePorts) => AssemblyPlanSubject
  readonly lifecycle: (
    input: AssemblyFixture,
    options?: { pause?: boolean; failReady?: boolean },
  ) => Promise<AssemblyLifecycleFixture>
  readonly construct: (input: unknown) => Outcome<ReleaseSet>
}

/** Executable plan select/normal/deny cases; prepare is registered separately below. */
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

/** Executable memory prepare coverage; recover remains explicitly unfinished. */
export function registerAssemblyPrepareContract(
  harness: ConformanceHarness,
  binding: AssemblyPlanContractBinding,
): void {
  for (const scenario of ['select', 'normal', 'deny', 'cancel', 'dispose'] as const)
    harness.registerCase({
      contract: 'agh.assembly',
      providerId: binding.providerId,
      scenario,
      qualification: 'required',
      async run() {
        const input = assemblyFixture()
        const fixture = await binding.lifecycle(input, {
          pause: scenario === 'cancel',
          failReady: scenario === 'deny',
        })
        const subject = binding.create(input, fixture.lifecycle)
        let passed = subject.providerId === `agh.${binding.providerId}/assembly`
        try {
          const call = binding.context(),
            abort = new AbortController()
          const preparing = subject.prepare(
            { graph: input.graph },
            scenario === 'cancel' ? { ...call, signal: abort.signal } : call,
          )
          if (scenario === 'cancel') {
            await fixture.started
            abort.abort()
          }
          const result = await preparing
          if (scenario === 'deny' || scenario === 'cancel')
            passed =
              passed &&
              !result.ok &&
              result.error.detailCode ===
                (scenario === 'cancel' ? 'prepare_cancelled' : 'candidate_prepare_failed') &&
              fixture.released.length === fixture.mounted.length &&
              subject.inspectCandidate()?.readiness.state === 'blocked'
          else {
            passed =
              passed &&
              result.ok &&
              result.value.readiness.state === 'ready' &&
              result.value.readiness.required.length === input.graph.requiredContributions.length &&
              result.value.readiness.required.every((row) => row.ready) &&
              fixture.lifecycle.view()?.staged === true &&
              fixture.readied.length === fixture.lifecycle.selections.length
            const repeated = await subject.prepare({ graph: input.graph }, binding.context())
            passed =
              passed && repeated.ok && result.ok && fixtureHash(repeated.value) === fixtureHash(result.value)
          }
          if (scenario === 'dispose') {
            const drained = await subject.drain(
              {
                releaseSetId: input.plan.targetReleaseSet.releaseSetId,
                deadline: binding.context().deadline,
              },
              binding.context(),
            )
            passed = passed && drained.ok && drained.value.remainingRefs.length === 0
          }
          const residual = await subject.dispose()
          passed =
            passed &&
            residual.length === 0 &&
            (await subject.dispose()).length === 0 &&
            fixture.released.length === fixture.mounted.length
          if (scenario === 'dispose') {
            const closed = await subject.prepare({ graph: input.graph }, binding.context())
            passed = passed && !closed.ok && closed.error.detailCode === 'candidate_disposed'
          }
        } finally {
          await subject.dispose()
          await fixture.cleanup()
        }
        return {
          id: `agh.assembly/${binding.providerId}/prepare/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: 'memory-prepare/public-fixture',
          features: ['prepare', 'memory-drain'],
          build: binding.build,
          consumer: 'detached-assembly-candidate-consumer',
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

export * from './assembly-publish.js'
