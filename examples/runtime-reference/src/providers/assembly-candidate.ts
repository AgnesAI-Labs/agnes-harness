import type { CallContext, Outcome, RuntimeError } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type AssemblyDrainResult,
  type AssemblyGraph,
  type AssemblyPrepareResult,
  type BindingRef,
  canonicalJsonDigest,
  type Readiness,
  type ReleasePlan,
  type ReleaseSet,
  type RuntimeWireTypes,
} from '@agnes/protocol/runtime'
import { readReferenceAssemblyWire } from './assembly-wire.js'

interface StagedObservation {
  readonly generationId: string
  readonly state: string
  readonly staged: boolean
  readonly readiness: readonly { readonly providerId: string; readonly ready: boolean }[]
  readonly diagnostics: readonly { readonly code: string; readonly event: string }[]
  readonly residualOwnerIds: readonly string[]
  readonly unknownActionIds: readonly string[]
}
/** A trusted Cordis lifecycle is infrastructure; this example owns its own candidate algorithm. */
export interface ReferenceCandidateLifecycle {
  readonly generationId: string
  readonly selections: readonly {
    readonly binding: BindingRef
    readonly major: number
    readonly scope: string
    readonly features: readonly string[]
    readonly packageDigest: string
  }[]
  prepare(signal: AbortSignal): Promise<StagedObservation>
  view(): StagedObservation | undefined
  drain(
    deadline: number,
  ): Promise<{ readonly state: string; readonly activeInvocationIds: readonly string[] }>
  activate?(): void
  close(): Promise<StagedObservation | undefined>
}
class CandidateRejected extends Error {
  constructor(readonly detailCode: string) {
    super(detailCode)
  }
}
const ensure = (valid: unknown, reason: string) => {
  if (!valid) throw new CandidateRejected(reason)
}
function checked<K extends keyof RuntimeWireTypes>(name: K, raw: unknown): RuntimeWireTypes[K] {
  const decoded = readReferenceAssemblyWire(name, raw)
  if (!decoded.ok) throw new CandidateRejected('schema_invalid')
  return decoded.value
}
const hash = (value: unknown) => canonicalJsonDigest(checked('JsonValue', value))
const canon = (value: unknown) => jcs(checked('JsonValue', value))
function seal<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(seal)
    Object.freeze(value)
  }
  return value
}
function failed(cause: unknown, stopped = false): Outcome<never> {
  let reason = 'candidate_prepare_failed'
  if (cause instanceof Error) {
    if ('detailCode' in cause && typeof cause.detailCode === 'string') reason = cause.detailCode
    else if ('code' in cause && typeof cause.code === 'string')
      reason = cause.code.split('/').at(-1) ?? reason
  }
  if (stopped || reason === 'cancelled') reason = 'prepare_cancelled'
  const code: RuntimeError['code'] =
    reason === 'prepare_cancelled' ? 'cancelled' : reason === 'schema_invalid' ? 'invalid_input' : 'conflict'
  return {
    ok: false,
    error: {
      code,
      detailCode: reason,
      message: 'Reference candidate refused the fixed generation',
      diagnosticId: 'reference-assembly',
      retryAdvice: { kind: 'never' },
    },
  }
}

export function referenceCandidate(
  graph: AssemblyGraph,
  release: ReleaseSet,
  plan: ReleasePlan,
  ports: ReferenceCandidateLifecycle,
) {
  const fixedGraph = seal(structuredClone(graph)),
    fixedRelease = seal(structuredClone(release))
  const fixedPlan = seal(structuredClone(plan)),
    stop = new AbortController()
  let mode: 'idle' | 'preparing' | 'ready' | 'failed' | 'disposed' | 'residual' = 'idle'
  let disposing = false
  let outcome: AssemblyPrepareResult | undefined
  // This graph is a detached deep-frozen capture; validate its canonical bytes once.
  let graphEncoding: string | undefined
  let running: Promise<Outcome<AssemblyPrepareResult>> | undefined
  let releasing: Promise<void> | undefined
  let leftover: readonly string[] = []
  let readiness: Readiness = {
    state: 'blocked',
    required: fixedGraph.requiredContributions.map((id) => ({
      contributionId: id,
      ready: false,
      diagnosticIds: [],
    })),
  }

  function record(observation?: StagedObservation, reason?: string): void {
    const rows = fixedGraph.requiredContributions.map((id) => {
      const provider = fixedRelease.bindings.find((snapshot) => snapshot.binding.bindingId === id)?.binding
        .providerId
      const ready =
        observation?.readiness.some((entry) => entry.providerId === provider && entry.ready) ?? false
      return {
        contributionId: id,
        ready,
        diagnosticIds: [
          ...(observation?.diagnostics.map((item) => `${item.code}:${item.event}`) ?? []),
          ...(reason && !ready ? [reason] : []),
        ],
      }
    })
    readiness = seal({
      state:
        !reason && observation?.state === 'ready' && rows.every((entry) => entry.ready) ? 'ready' : 'blocked',
      required: rows,
    })
  }
  async function releaseOwners(): Promise<void> {
    if (!releasing)
      releasing = (async () => {
        try {
          const closed = await ports.close()
          leftover = closed ? [...closed.residualOwnerIds] : []
        } catch {
          leftover = [`lifecycle:${ports.generationId}`]
        }
      })()
    await releasing
  }
  async function initialize(signal: AbortSignal): Promise<Outcome<AssemblyPrepareResult>> {
    mode = 'preparing'
    try {
      const observed = await ports.prepare(AbortSignal.any([signal, stop.signal]))
      if (signal.aborted || disposing) throw new CandidateRejected('prepare_cancelled')
      record(observed)
      ensure(
        observed.generationId === ports.generationId && observed.state === 'ready' && observed.staged,
        'candidate_not_staged',
      )
      ensure(readiness.state === 'ready', 'candidate_readiness_incomplete')
      const body = checked('JsonValue', {
        kind: 'memory-assembly-candidate',
        qualification: 'public-fixture',
        generationId: observed.generationId,
        graphId: fixedGraph.graphId,
        graphDigest: fixedGraph.digest,
        releaseSetId: fixedRelease.releaseSetId,
        planId: fixedPlan.planId,
        upgradeId: fixedPlan.upgradeId,
        planFingerprint: fixedPlan.planFingerprint,
      })
      const candidateType = 'agh.assembly/memory-candidate@1'
      outcome = seal(
        checked('AssemblyPrepareResult', {
          candidateRef: {
            kind: 'inline',
            schema: { typeId: candidateType, revision: 1, digest: hash({ typeId: candidateType }) },
            value: body,
            digest: hash(body),
            bytes: new TextEncoder().encode(jcs(body)).length,
          },
          readiness,
        }),
      )
      mode = 'ready'
      return { ok: true, value: outcome }
    } catch (cause) {
      const rejection = failed(cause, signal.aborted || disposing)
      let observation: StagedObservation | undefined
      try {
        observation = ports.view()
      } catch {
        /* A failed observation must not prevent disposal. */
      }
      record(observation, rejection.ok ? undefined : rejection.error.detailCode)
      await releaseOwners()
      mode = leftover.length ? 'residual' : 'failed'
      return rejection
    }
  }
  async function dispose(): Promise<readonly string[]> {
    disposing = true
    stop.abort()
    if (running) await running
    await releaseOwners()
    mode = leftover.length === 0 ? 'disposed' : 'residual'
    return Object.freeze([...leftover])
  }
  return {
    async prepare(raw: unknown, call: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
      if (call.signal.aborted) return failed(null, true)
      try {
        const incoming = canon(checked('AssemblyPrepareRequest', raw).graph)
        graphEncoding ??= canon(fixedGraph)
        ensure(incoming === graphEncoding, 'prepare_input_mismatch')
        ensure(!disposing && mode !== 'failed', 'candidate_disposed')
        const selected = new Map(ports.selections.map((entry) => [entry.binding.bindingId, entry]))
        ensure(
          selected.size === ports.selections.length && selected.size === fixedRelease.bindings.length,
          'candidate_selection_mismatch',
        )
        for (const snapshot of fixedRelease.bindings) {
          const chosen = selected.get(snapshot.binding.bindingId),
            declaration = snapshot.descriptor
          ensure(
            chosen &&
              canon(chosen) ===
                canon({
                  binding: snapshot.binding,
                  major: declaration.major,
                  scope: declaration.scope,
                  features: declaration.features,
                  packageDigest: declaration.packageDigest,
                }),
            'candidate_selection_mismatch',
          )
        }
        if (outcome) return { ok: true, value: outcome }
        if (!running) running = initialize(call.signal)
        return await running
      } catch (cause) {
        return failed(cause)
      }
    },
    dispose,
    async drain(raw: unknown, call: CallContext): Promise<Outcome<AssemblyDrainResult>> {
      if (call.signal.aborted) return failed(null, true)
      try {
        const operation = checked('AssemblyDrainRequest', raw)
        ensure(operation.releaseSetId === fixedRelease.releaseSetId, 'candidate_release_mismatch')
        ensure(outcome && !disposing, 'candidate_not_prepared')
        ensure(ports.view()?.staged, 'candidate_not_staged')
        const waited = await ports.drain(Date.parse(operation.deadline))
        if (waited.state === 'drained') await dispose()
        const retained = new Set([
          ...leftover,
          ...(ports.view()?.unknownActionIds ?? []),
          ...waited.activeInvocationIds,
        ])
        const remainingRefs = Array.from(retained, (resourceId) => ({
          kind: 'resource',
          value: { resourceId, version: ports.generationId, digest: fixedRelease.releaseSetId },
        }))
        return { ok: true, value: checked('AssemblyDrainResult', { remainingRefs }) }
      } catch (cause) {
        return failed(cause)
      }
    },
    inspect() {
      return seal({
        state: mode,
        generationId: ports.generationId,
        graph: fixedGraph,
        releaseSet: fixedRelease,
        candidateRef: outcome?.candidateRef ?? null,
        readiness,
        residualOwnerIds: [...leftover],
      })
    },
  }
}
