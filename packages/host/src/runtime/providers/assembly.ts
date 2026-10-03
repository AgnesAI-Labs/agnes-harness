import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  AssemblyDrainResult,
  AssemblyGraph,
  AssemblyPrepareResult,
  AssemblyPublishResult,
} from '@agnes/protocol/runtime'
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

/** Offline plan provider; it is deliberately absent from the production service root. */
export function createAssemblyProvider(input: unknown) {
  const captured = attempt(() => {
    fields(input, ['plan', 'graph', 'configuration', 'resolution', 'fixture'], '/')
    return freeze(structuredClone(input))
  })
  return {
    providerId: 'agh.default/assembly',
    contract: 'agh.assembly',
    implemented: Object.freeze(['plan']),
    incomplete: Object.freeze(['prepare', 'publish', 'drain', 'admission', 'cold-recovery']),
    async plan(request: unknown, context: CallContext): Promise<Outcome<AssemblyGraph>> {
      if (context.signal.aborted)
        return { ok: false, error: { ...releaseError('plan_cancelled'), code: 'cancelled' } }
      if (!captured.ok) return captured
      const accepted = attempt(() => {
        const parsed = readWire('AssemblyPlanRequest', request)
        const fixed = readInputs(captured.value)
        requireRelease(
          equal(parsed.configRef, fixed.graph.configRef) && equal(parsed.lock, fixed.graph.lock),
          'plan_input_mismatch',
          '/plan/request',
        )
        return fixed
      })
      if (!accepted.ok) return accepted
      const release = constructReleaseSet(accepted.value)
      if (!release.ok) return release
      return { ok: true, value: freeze(accepted.value.graph) }
    },
    async prepare(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyPrepareResult>> {
      return { ok: false, error: releaseError('assembly_prepare_unimplemented') }
    },
    async publish(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyPublishResult>> {
      return { ok: false, error: releaseError('assembly_publish_unimplemented') }
    },
    async drain(_request: unknown, _context: CallContext): Promise<Outcome<AssemblyDrainResult>> {
      return { ok: false, error: releaseError('assembly_drain_unimplemented') }
    },
  }
}
