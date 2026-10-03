import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type {
  AssemblyGraph,
  AssemblyPrepareResult,
  BindingRef,
  DataRef,
  PublicRef,
  Readiness,
  ReleasePlan,
  ReleaseSet,
} from '@agnes/protocol/runtime'
import type { HostProviderPublication, HostScopedDependencies } from '../scoped-dependencies.js'
import { digest, equal, freeze, readWire, releaseError, requireRelease } from './primitives.js'

export interface CandidateView {
  readonly generationId: string
  readonly state: string
  readonly staged: boolean
  readonly readiness: readonly { readonly providerId: string; readonly ready: boolean }[]
  readonly diagnostics: readonly { readonly code: string; readonly event: string }[]
  readonly residualOwnerIds: readonly string[]
  readonly unknownActionIds: readonly string[]
}
/** Trusted, memory-only lifecycle ports. They never construct a selectable container. */
export interface CandidateLifecycle {
  readonly generationId: string
  readonly selections: readonly {
    readonly binding: BindingRef
    readonly major: number
    readonly scope: string
    readonly features: readonly string[]
    readonly packageDigest: string
  }[]
  prepare(signal: AbortSignal): Promise<CandidateView>
  view(): CandidateView | undefined
  drain(
    deadline: number,
  ): Promise<{ readonly state: string; readonly activeInvocationIds: readonly string[] }>
  activate?(): void
  close(): Promise<CandidateView | undefined>
}

/** Wrap an already owned Host root; no factory or second selection authority is introduced. */
export function candidateLifecycle(
  root: HostScopedDependencies,
  publication: HostProviderPublication,
): CandidateLifecycle {
  const fixed: HostProviderPublication = {
    ...publication,
    providers: publication.providers.map((provider) => ({
      ...provider,
      binding: structuredClone(provider.binding),
      features: [...provider.features],
      permissions: [...provider.permissions],
      ...(provider.requires ? { requires: structuredClone(provider.requires) } : {}),
      ...(provider.capabilities ? { capabilities: [...provider.capabilities] } : {}),
      ...(provider.contractDefinition
        ? { contractDefinition: structuredClone(provider.contractDefinition) }
        : {}),
      ...(provider.operations ? { operations: structuredClone(provider.operations) } : {}),
      ...(provider.owners ? { owners: [...provider.owners] } : {}),
    })),
    ...(publication.contracts ? { contracts: structuredClone(publication.contracts) } : {}),
    ...(publication.contributions
      ? {
          contributions: publication.contributions.map((row) => ({
            ...row,
            ...(row.hooks ? { hooks: structuredClone(row.hooks) } : {}),
            ...(row.operations ? { operations: structuredClone(row.operations) } : {}),
            ...(row.tools ? { tools: structuredClone(row.tools) } : {}),
            ...(row.requiredCapabilities ? { requiredCapabilities: [...row.requiredCapabilities] } : {}),
          })),
        }
      : {}),
    ...(publication.loopFeatures ? { loopFeatures: [...publication.loopFeatures] } : {}),
    ...(publication.brokerKeys ? { brokerKeys: [...publication.brokerKeys] } : {}),
  }
  const view = () => {
    try {
      return root.view(fixed.generationId)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'unknown_generation') return undefined
      throw error
    }
  }
  return {
    generationId: fixed.generationId,
    selections: freeze(
      fixed.providers.map((provider) => ({
        binding: structuredClone(provider.binding),
        major: provider.major,
        scope: provider.scope,
        features: [...provider.features],
        packageDigest: provider.packageDigest,
      })),
    ),
    prepare: (signal) => root.prepare(fixed, signal),
    activate() {
      root.activate(fixed.generationId)
    },
    view,
    drain: (deadline) => root.drain(fixed.generationId, deadline),
    async close() {
      if (view()) await root.close(fixed.generationId)
      return view()
    },
  }
}

function prepareFailure(error: unknown): Outcome<never> {
  let detailCode = 'candidate_prepare_failed'
  if (error instanceof Error && 'detailCode' in error && typeof error.detailCode === 'string')
    detailCode = error.detailCode
  else if (error instanceof Error && 'code' in error && typeof error.code === 'string')
    detailCode = error.code.split('/').at(-1) ?? detailCode
  const errorValue = releaseError(detailCode === 'cancelled' ? 'prepare_cancelled' : detailCode)
  if (detailCode === 'cancelled' || detailCode === 'prepare_cancelled') errorValue.code = 'cancelled'
  return { ok: false, error: errorValue }
}

export class AssemblyCandidate {
  readonly #controller = new AbortController()
  readonly #graph: AssemblyGraph
  readonly #release: ReleaseSet
  readonly #plan: ReleasePlan
  #state: 'idle' | 'preparing' | 'ready' | 'failed' | 'disposed' | 'residual' = 'idle'
  #closing = false
  #pending: Promise<Outcome<AssemblyPrepareResult>> | undefined
  #closingTask: Promise<void> | undefined
  #result: AssemblyPrepareResult | undefined
  #readiness: Readiness
  #residual: readonly string[] = []

  constructor(
    graph: AssemblyGraph,
    release: ReleaseSet,
    plan: ReleasePlan,
    readonly lifecycle: CandidateLifecycle,
  ) {
    this.#graph = freeze(structuredClone(graph))
    this.#release = freeze(structuredClone(release))
    this.#plan = freeze(structuredClone(plan))
    this.#readiness = {
      state: 'blocked',
      required: graph.requiredContributions.map((contributionId) => ({
        contributionId,
        ready: false,
        diagnosticIds: [],
      })),
    }
  }

  async prepare(request: unknown, context: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
    if (context.signal.aborted) return prepareFailure(Object.assign(new Error(), { code: 'cancelled' }))
    try {
      const parsed = readWire('AssemblyPrepareRequest', request)
      requireRelease(equal(parsed.graph, this.#graph), 'prepare_input_mismatch', '/prepare/graph')
      requireRelease(!this.#closing && this.#state !== 'failed', 'candidate_disposed', '/candidate')
      const expected = this.#release.bindings.map(({ binding, descriptor }) => ({
        binding,
        major: descriptor.major,
        scope: descriptor.scope,
        features: descriptor.features,
        packageDigest: descriptor.packageDigest,
      }))
      const sort = <T extends { binding: BindingRef }>(rows: readonly T[]) =>
        [...rows].sort((a, b) => a.binding.bindingId.localeCompare(b.binding.bindingId))
      requireRelease(
        equal(sort(expected), sort(this.lifecycle.selections)),
        'candidate_selection_mismatch',
        '/candidate/selections',
      )
      if (this.#result) return { ok: true, value: this.#result }
      this.#pending ??= this.#stage(context.signal)
      return await this.#pending
    } catch (error) {
      return prepareFailure(error)
    }
  }

  async #stage(signal: AbortSignal): Promise<Outcome<AssemblyPrepareResult>> {
    this.#state = 'preparing'
    try {
      const view = await this.lifecycle.prepare(AbortSignal.any([signal, this.#controller.signal]))
      if (signal.aborted || this.#closing) throw Object.assign(new Error(), { code: 'cancelled' })
      this.#setReadiness(view)
      requireRelease(
        view.generationId === this.lifecycle.generationId && view.staged && view.state === 'ready',
        'candidate_not_staged',
        '/candidate',
      )
      requireRelease(
        this.#readiness.state === 'ready',
        'candidate_readiness_incomplete',
        '/candidate/readiness',
      )
      const value = readWire('JsonValue', {
        kind: 'memory-assembly-candidate',
        qualification: 'public-fixture',
        generationId: view.generationId,
        graphId: this.#graph.graphId,
        graphDigest: this.#graph.digest,
        releaseSetId: this.#release.releaseSetId,
        planId: this.#plan.planId,
        upgradeId: this.#plan.upgradeId,
        planFingerprint: this.#plan.planFingerprint,
      })
      const typeId = 'agh.assembly/memory-candidate@1'
      const candidateRef: DataRef = {
        kind: 'inline',
        schema: { typeId, revision: 1, digest: digest({ typeId }) },
        value,
        digest: digest(value),
        bytes: Buffer.byteLength(jcs(value)),
      }
      this.#result = freeze(readWire('AssemblyPrepareResult', { candidateRef, readiness: this.#readiness }))
      this.#state = 'ready'
      return { ok: true, value: this.#result }
    } catch (error) {
      const failure = prepareFailure(
        signal.aborted || this.#closing ? Object.assign(new Error(), { code: 'cancelled' }) : error,
      )
      let observation: CandidateView | undefined
      try {
        observation = this.lifecycle.view()
      } catch {
        /* Cleanup still owns the generation. */
      }
      this.#setReadiness(observation, failure.ok ? undefined : failure.error.detailCode)
      await this.#releaseOwners()
      this.#state = this.#residual.length ? 'residual' : 'failed'
      return failure
    }
  }

  #setReadiness(view?: CandidateView, failure?: string): void {
    this.#readiness = freeze({
      state: failure || view?.state !== 'ready' ? 'blocked' : 'ready',
      required: this.#graph.requiredContributions.map((contributionId) => {
        const selected = this.#release.bindings.find((row) => row.binding.bindingId === contributionId)
        const ready =
          view?.readiness.find((row) => row.providerId === selected?.binding.providerId)?.ready === true
        const diagnosticIds = [
          ...(view?.diagnostics.map((row) => `${row.code}:${row.event}`) ?? []),
          ...(failure && !ready ? [failure] : []),
        ]
        return { contributionId, ready, diagnosticIds }
      }),
    })
    if (this.#readiness.required.some((row) => !row.ready))
      this.#readiness = freeze({ ...this.#readiness, state: 'blocked' })
  }

  async #releaseOwners(): Promise<void> {
    this.#closingTask ??= (async () => {
      try {
        this.#residual = [...((await this.lifecycle.close())?.residualOwnerIds ?? [])]
      } catch {
        this.#residual = [`lifecycle:${this.lifecycle.generationId}`]
      }
    })()
    await this.#closingTask
  }

  async dispose(): Promise<readonly string[]> {
    this.#closing = true
    this.#controller.abort()
    await this.#pending
    await this.#releaseOwners()
    this.#state = this.#residual.length ? 'residual' : 'disposed'
    return Object.freeze([...this.#residual])
  }

  async drain(request: unknown, context: CallContext): Promise<Outcome<{ remainingRefs: PublicRef[] }>> {
    if (context.signal.aborted) return prepareFailure(Object.assign(new Error(), { code: 'cancelled' }))
    try {
      const parsed = readWire('AssemblyDrainRequest', request)
      requireRelease(
        parsed.releaseSetId === this.#release.releaseSetId,
        'candidate_release_mismatch',
        '/drain/releaseSetId',
      )
      requireRelease(this.#result && !this.#closing, 'candidate_not_prepared', '/drain')
      requireRelease(this.lifecycle.view()?.staged, 'candidate_not_staged', '/drain')
      const drained = await this.lifecycle.drain(Date.parse(parsed.deadline))
      const active = [...drained.activeInvocationIds]
      if (drained.state === 'drained') await this.dispose()
      const owners = [...this.#residual, ...(this.lifecycle.view()?.unknownActionIds ?? []), ...active]
      return {
        ok: true,
        value: readWire('AssemblyDrainResult', {
          remainingRefs: [...new Set(owners)].map((id) => ({
            kind: 'resource',
            value: {
              resourceId: id,
              version: this.lifecycle.generationId,
              digest: this.#release.releaseSetId,
            },
          })),
        }),
      }
    } catch (error) {
      return prepareFailure(error)
    }
  }

  inspect() {
    return freeze({
      state: this.#state,
      generationId: this.lifecycle.generationId,
      graph: this.#graph,
      releaseSet: this.#release,
      candidateRef: this.#result?.candidateRef ?? null,
      readiness: this.#readiness,
      residualOwnerIds: [...this.#residual],
    })
  }
}
