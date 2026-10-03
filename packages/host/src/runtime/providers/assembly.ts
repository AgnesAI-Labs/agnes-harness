import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyDrainResult,
  AssemblyGraph,
  AssemblyPrepareResult,
  AssemblyPublishResult,
} from '@agnes/protocol/runtime'
import { type AdmissionStatePorts, createAdmissionCoordinator } from '../assembly/admission.js'
import { AssemblyCandidate, type CandidateLifecycle } from '../assembly/candidate.js'
import { readInputs } from '../assembly/inputs.js'
import {
  type AssemblyMaintenancePorts,
  authorizeMaintenance,
  maintenanceOutcome,
} from '../assembly/maintenance-journal.js'
import {
  attempt,
  equal,
  fields,
  freeze,
  readWire,
  releaseError,
  requireRelease,
} from '../assembly/primitives.js'
import { AssemblyPublication } from '../assembly/publication.js'
import { constructReleaseSet } from '../assembly/release-set.js'

/** Detached provider; persistent fixtures require explicit ports and never register at startup. */
export function createAssemblyProvider(
  input: unknown,
  lifecycle?: CandidateLifecycle,
  maintenance?: AssemblyMaintenancePorts,
  admissionState?: AdmissionStatePorts,
) {
  const admission = createAdmissionCoordinator(maintenance, admissionState)
  const captured = attempt(() => {
    fields(input, ['plan', 'graph', 'configuration', 'resolution', 'fixture'], '/')
    return freeze(structuredClone(input))
  })
  let decoded: ReturnType<typeof readInputs> | undefined
  let checked: ReturnType<typeof constructReleaseSet> | undefined
  const snapshot = () => (decoded ??= freeze(readInputs(captured.ok ? captured.value : undefined)))
  const release = () => (checked ??= freeze(constructReleaseSet(snapshot())))
  let candidate: AssemblyCandidate | undefined
  let publication: AssemblyPublication | undefined
  const journal = () => {
    requireRelease(maintenance, 'maintenance_store_unavailable', '/maintenance')
    publication ??= new AssemblyPublication(snapshot(), maintenance)
    return publication
  }
  const lifetime = new AbortController()
  let disposed = false
  let preparing: Promise<unknown> = Promise.resolve()
  let publishing: Promise<unknown> = Promise.resolve()
  const call = (context: CallContext) => ({
    ...context,
    signal: AbortSignal.any([context.signal, lifetime.signal]),
  })
  async function prepare(request: unknown, context: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
    if (context.signal.aborted)
      return { ok: false, error: { ...releaseError('prepare_cancelled'), code: 'cancelled' } }
    if (disposed) return { ok: false, error: releaseError('candidate_disposed') }
    if (!captured.ok) return captured
    const fixed = attempt(() => {
      const parsed = readWire('AssemblyPrepareRequest', request),
        inputs = snapshot()
      requireRelease(equal(parsed.graph, inputs.graph), 'prepare_input_mismatch', '/prepare/graph')
      return inputs
    })
    if (!fixed.ok) return fixed
    const validated = release()
    if (!validated.ok) return validated
    if (!lifecycle) return { ok: false, error: releaseError('candidate_lifecycle_unavailable') }
    if (maintenance && !candidate) {
      const staged = await journal().stage(context)
      if (!staged.ok) return staged
      const started = await journal().beginPrepare(context)
      if (!started.ok) return started
      if (disposed) return { ok: false, error: releaseError('candidate_disposed') }
    }
    candidate ??= new AssemblyCandidate(fixed.value.graph, validated.value, fixed.value.plan, lifecycle)
    const result = await candidate.prepare(request, context)
    return maintenance && result.ok
      ? journal().verified(result.value, lifecycle.generationId, context)
      : result
  }
  return {
    admission,
    providerId: 'agh.default/assembly',
    contract: 'agh.assembly',
    implemented: Object.freeze(
      maintenance
        ? ['plan', 'prepare', 'publish', 'maintenance-replay']
        : ['plan', 'prepare', 'memory-drain'],
    ),
    incomplete: Object.freeze(
      maintenance
        ? ['persistent-pin-drain', 'admission', 'runtime-cold-recovery', 'production-wiring']
        : ['publish', 'persistent-pin-drain', 'admission', 'cold-recovery'],
    ),
    async plan(request: unknown, context: CallContext): Promise<Outcome<AssemblyGraph>> {
      if (context.signal.aborted)
        return { ok: false, error: { ...releaseError('plan_cancelled'), code: 'cancelled' } }
      if (!captured.ok) return captured
      const accepted = attempt(() => {
        const parsed = readWire('AssemblyPlanRequest', request),
          fixed = snapshot()
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
      if (maintenance) {
        const authorized = await maintenanceOutcome(() =>
          authorizeMaintenance(maintenance, context, accepted.value.plan),
        )
        if (!authorized.ok) return authorized
      }
      return { ok: true, value: freeze(accepted.value.graph) }
    },
    async prepare(request: unknown, context: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
      const fixed = attempt(() => freeze(readWire('AssemblyPrepareRequest', request)))
      if (context.signal.aborted)
        return { ok: false, error: { ...releaseError('prepare_cancelled'), code: 'cancelled' } }
      if (disposed) return { ok: false, error: releaseError('candidate_disposed') }
      if (!fixed.ok) return fixed
      const operation = preparing.then(() => prepare(fixed.value, call(context)))
      preparing = operation.then(() => undefined)
      return operation
    },
    async dispose(): Promise<readonly string[]> {
      disposed = true
      lifetime.abort()
      await admission.dispose()
      await Promise.all([preparing, publishing])
      return candidate ? candidate.dispose() : []
    },
    inspectCandidate() {
      return candidate?.inspect()
    },
    async publish(request: unknown, context: CallContext): Promise<Outcome<AssemblyPublishResult>> {
      if (!maintenance) return { ok: false, error: releaseError('assembly_publish_unimplemented') }
      if (disposed) return { ok: false, error: releaseError('candidate_disposed') }
      const fixed = attempt(() => freeze(readWire('AssemblyPublishRequest', request)))
      if (!fixed.ok) return fixed
      if (!captured.ok) return captured
      const operation = publishing.then(() => {
        const coordinator = attempt(journal)
        return coordinator.ok
          ? coordinator.value.publish(fixed.value, candidate, lifecycle, call(context))
          : coordinator
      })
      publishing = operation.then(() => undefined)
      return operation
    },
    async drain(request: unknown, context: CallContext): Promise<Outcome<AssemblyDrainResult>> {
      if (maintenance) return { ok: false, error: releaseError('persistent_pin_drain_unimplemented') }
      if (!candidate) return { ok: false, error: releaseError('candidate_not_prepared') }
      return candidate.drain(request, context)
    },
  }
}
