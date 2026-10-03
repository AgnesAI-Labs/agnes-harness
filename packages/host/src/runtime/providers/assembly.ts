import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyDrainResult,
  AssemblyGraph,
  AssemblyPrepareResult,
  AssemblyPublishResult,
} from '@agnes/protocol/runtime'
import { AssemblyCandidate, type CandidateLifecycle } from '../assembly/candidate.js'
import { readInputs } from '../assembly/inputs.js'
import {
  attempt,
  equal,
  fields,
  freeze,
  readWire,
  releaseError,
  requireRelease,
} from '../assembly/primitives.js'
import { constructReleaseSet } from '../assembly/release-set.js'

/** Detached memory candidate provider; it is deliberately absent from the production service root. */
export function createAssemblyProvider(input: unknown, lifecycle?: CandidateLifecycle) {
  const captured = attempt(() => {
    fields(input, ['plan', 'graph', 'configuration', 'resolution', 'fixture'], '/')
    return freeze(structuredClone(input))
  })
  let decoded: ReturnType<typeof readInputs> | undefined
  let checked: ReturnType<typeof constructReleaseSet> | undefined
  const snapshot = () => (decoded ??= freeze(readInputs(captured.ok ? captured.value : undefined)))
  const release = () => (checked ??= freeze(constructReleaseSet(snapshot())))
  let candidate: AssemblyCandidate | undefined
  let disposed = false
  return {
    providerId: 'agh.default/assembly',
    contract: 'agh.assembly',
    implemented: Object.freeze(['plan', 'prepare', 'memory-drain']),
    incomplete: Object.freeze(['publish', 'persistent-pin-drain', 'admission', 'cold-recovery']),
    async plan(request: unknown, context: CallContext): Promise<Outcome<AssemblyGraph>> {
      if (context.signal.aborted)
        return { ok: false, error: { ...releaseError('plan_cancelled'), code: 'cancelled' } }
      if (!captured.ok) return captured
      const accepted = attempt(() => {
        const parsed = readWire('AssemblyPlanRequest', request)
        const fixed = snapshot()
        requireRelease(
          equal(parsed.configRef, fixed.graph.configRef) && equal(parsed.lock, fixed.graph.lock),
          'plan_input_mismatch',
          '/plan/request',
        )
        return fixed
      })
      if (!accepted.ok) return accepted
      const validated = release()
      if (!validated.ok) return validated
      return { ok: true, value: freeze(accepted.value.graph) }
    },
    async prepare(request: unknown, context: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
      if (context.signal.aborted)
        return { ok: false, error: { ...releaseError('prepare_cancelled'), code: 'cancelled' } }
      if (disposed) return { ok: false, error: releaseError('candidate_disposed') }
      if (candidate) return candidate.prepare(request, context)
      if (!captured.ok) return captured
      const fixed = attempt(() => {
        const parsed = readWire('AssemblyPrepareRequest', request)
        const inputs = snapshot()
        requireRelease(equal(parsed.graph, inputs.graph), 'prepare_input_mismatch', '/prepare/graph')
        return inputs
      })
      if (!fixed.ok) return fixed
      const validated = release()
      if (!validated.ok) return validated
      if (!lifecycle) return { ok: false, error: releaseError('candidate_lifecycle_unavailable') }
      candidate ??= new AssemblyCandidate(fixed.value.graph, validated.value, fixed.value.plan, lifecycle)
      return candidate.prepare(request, context)
    },
    async dispose(): Promise<readonly string[]> {
      disposed = true
      return candidate ? candidate.dispose() : []
    },
    inspectCandidate() {
      return candidate?.inspect()
    },

    async publish(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyPublishResult>> {
      return { ok: false, error: releaseError('assembly_publish_unimplemented') }
    },
    async drain(request: unknown, context: CallContext): Promise<Outcome<AssemblyDrainResult>> {
      if (!candidate) return { ok: false, error: releaseError('candidate_not_prepared') }
      return candidate.drain(request, context)
    },
  }
}
